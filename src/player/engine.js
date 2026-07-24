import { EventEmitter } from 'node:events';
import { db, getSetting, setSetting } from '../db.js';
import { config } from '../config.js';
import { MpvPlayer } from './mpv.js';
import { nowOn, upNext, guide, publicChannel } from '../schedule/resolver.js';
import { MINUTE, HOUR, floorToSlot } from '../util/time.js';
import {
  channelBanner,
  tuneDigits,
  fillerCard,
  offAirCard,
  troubleCard,
  colorBars,
  blockedGlyph,
  guideScreen,
  OVERLAY_IDS,
} from './overlay.js';

// A clock earlier than this is a cold-booted Pi with no NTP yet, not a real time.
const CLOCK_SANE_AFTER = Date.UTC(2026, 0, 1);

const BANNER_MS = 5000;

/**
 * The engine never trusts a timer to know what should be playing. Once a
 * second it asks the schedule what is on air and makes reality match.
 * That is why it survives sleep, power loss and clock drift: it is always
 * re-deriving, never remembering.
 */
export class Engine extends EventEmitter {
  constructor() {
    super();
    this.mpv = null;
    this.driver = config.playerDriver;
    this.channelId = null;
    this.currentProgramId = null;
    this.bannerUntil = 0;
    this.digits = '';
    this.digitsTimer = null;
    this.timer = null;
    this.status = 'stopped';
    this.lastError = null;
    this.lastHopAt = 0;
    this.guideOpen = false;
    this.guideIndex = 0;
    this.guideOffset = 0; // in 30-minute steps forward from now
    this.stickyChannelId = null; // a channel you chose while it was on dead air
  }

  async start() {
    if (this.driver === 'mpv') {
      this.mpv = new MpvPlayer();
      this.mpv.on('error', (err) => {
        this.lastError = err.message;
        this.driver = 'none';
        this.emit('log', `Player disabled: ${err.message}`);
      });
      this.mpv.on('log', (m) => this.emit('log', m));
      // Remote/keyboard input arrives as mpv client-message events.
      this.mpv.on('client-message', (m) => this.#onKey(m.args || []));
      try {
        await this.mpv.start();
        await this.mpv.bindKeys();
      } catch (err) {
        this.lastError = err.message;
        this.driver = 'none';
      }
    }

    // last_channel can point at a channel that was since deleted (e.g. the demo
    // lineup). Fall back to the first enabled channel, and never let a bad tune
    // crash startup — the TV must always come up on something (invariant #7).
    const last = getSetting('last_channel', null);
    const stillThere = last
      ? db.prepare('SELECT id FROM channels WHERE id = ? AND enabled = 1').get(last)
      : null;
    const first = db
      .prepare('SELECT id FROM channels WHERE enabled = 1 ORDER BY number LIMIT 1')
      .get();
    const target = (stillThere && stillThere.id) ?? (first ? first.id : null);
    if (target) {
      try {
        await this.tune(target, { silent: true });
      } catch (err) {
        this.lastError = err.message;
        this.emit('log', `Could not tune to channel ${target}: ${err.message}`);
      }
    }

    this.timer = setInterval(() => this.tick().catch(() => {}), config.tickMs);
    this.status = 'running';
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.mpv) await this.mpv.quit();
    this.status = 'stopped';
  }

  get channel() {
    if (!this.channelId) return null;
    const c = db.prepare('SELECT * FROM channels WHERE id = ?').get(this.channelId);
    return c ? publicChannel(c) : null;
  }

  async tune(channelId, { silent = false } = {}) {
    const c = db.prepare('SELECT * FROM channels WHERE id = ? AND enabled = 1').get(channelId);
    if (!c) throw new Error('No such channel');

    this.channelId = c.id;
    this.currentProgramId = null;
    setSetting('last_channel', c.id);
    if (!silent) {
      this.bannerUntil = Date.now() + BANNER_MS;
      // If you deliberately tune to a channel that's between shows, that choice
      // sticks — the dead-air auto-hop won't yank you off it. Cleared once the
      // channel's own content starts (in sync), or when you pick another.
      const p = nowOn(c.id, Date.now());
      this.stickyChannelId = p && p.kind === 'filler' ? c.id : null;
    }

    await this.sync(true);
    this.emit('tuned', this.snapshot());
    return this.snapshot();
  }

  async tuneByNumber(number) {
    const c = db.prepare('SELECT id FROM channels WHERE number = ? AND enabled = 1').get(number);
    if (!c) return null;
    return this.tune(c.id);
  }

  async surf(direction) {
    const list = db
      .prepare('SELECT id FROM channels WHERE enabled = 1 ORDER BY number')
      .all()
      .map((r) => r.id);
    if (list.length === 0) return null;
    const idx = list.indexOf(this.channelId);
    const nextIdx = (idx + direction + list.length) % list.length;
    return this.tune(list[nextIdx]);
  }

  /** The lowest-numbered enabled channel with a real show/movie on right now. */
  #firstChannelWithContent(at, excludeId = null) {
    const rows = db
      .prepare('SELECT id FROM channels WHERE enabled = 1 ORDER BY number')
      .all();
    for (const r of rows) {
      if (r.id === excludeId) continue;
      const p = nowOn(r.id, at);
      if (p && (p.kind === 'episode' || p.kind === 'movie') && p.playable) return r.id;
    }
    return null;
  }

  /** Digit entry with a two second commit window, like a real box. */
  pressDigit(d) {
    this.digits = (this.digits + d).slice(-3);
    if (this.digitsTimer) clearTimeout(this.digitsTimer);
    this.#drawDigits();
    this.digitsTimer = setTimeout(async () => {
      const num = Number(this.digits);
      this.digits = '';
      if (this.mpv) await this.mpv.clearOverlay(OVERLAY_IDS.digits).catch(() => {});
      const res = await this.tuneByNumber(num).catch(() => null);
      if (!res) this.bannerUntil = Date.now() + 1500;
    }, 2000);
    return this.digits;
  }

  showBanner(ms = BANNER_MS) {
    this.bannerUntil = Date.now() + ms;
    return this.snapshot();
  }

  /** Dispatch a key from the mpv window (or a FLIRC remote pretending to be one). */
  async #onKey(args) {
    if (args[0] !== 'cathode-key') return;
    const [, action, value] = args;
    try {
      if (action === 'guide') {
        this.guideOpen ? await this.#closeGuide() : await this.#openGuide();
      } else if (action === 'digit') {
        if (this.guideOpen) await this.#closeGuide();
        this.pressDigit(String(value));
      } else if (action === 'arrow') {
        await this.#onArrow(String(value));
      } else if (action === 'enter') {
        if (this.guideOpen) {
          const rows = this.#enabledChannels();
          const pick = rows[this.guideIndex];
          if (pick) await this.tune(pick.id);
          await this.#closeGuide();
        } else {
          this.showBanner();
          await this.tick().catch(() => {});
        }
      } else if (action === 'blocked') {
        await this.#flashBlocked();
      }
    } catch (err) {
      this.lastError = err.message;
    }
  }

  #enabledChannels() {
    return db
      .prepare('SELECT id, number, name FROM channels WHERE enabled = 1 ORDER BY number')
      .all();
  }

  async #onArrow(dir) {
    if (this.guideOpen) {
      const rows = this.#enabledChannels();
      if (dir === 'up') this.guideIndex = Math.max(0, this.guideIndex - 1);
      else if (dir === 'down') this.guideIndex = Math.min(rows.length - 1, this.guideIndex + 1);
      else if (dir === 'left') this.guideOffset = Math.max(0, this.guideOffset - 1);
      else if (dir === 'right') this.guideOffset = Math.min(this.#maxGuideOffset(), this.guideOffset + 1);
      await this.#drawGuide();
    } else if (dir === 'up') {
      await this.surf(-1);
    } else if (dir === 'down') {
      await this.surf(1);
    } else {
      // Left/Right do nothing while watching — no seeking.
      await this.#flashBlocked();
    }
  }

  async #openGuide() {
    this.guideOpen = true;
    this.guideOffset = 0;
    const rows = this.#enabledChannels();
    const cur = rows.findIndex((c) => c.id === this.channelId);
    this.guideIndex = cur >= 0 ? cur : 0;
    if (this.mpv && this.mpv.ready) {
      await this.mpv.clearOverlay(OVERLAY_IDS.banner).catch(() => {});
      await this.mpv.setVideoRegion(true);
    }
    await this.#drawGuide();
  }

  async #closeGuide() {
    this.guideOpen = false;
    if (this.mpv && this.mpv.ready) {
      await this.mpv.setVideoRegion(false);
      await this.mpv.clearOverlay(OVERLAY_IDS.guide).catch(() => {});
    }
  }

  #maxGuideOffset() {
    const g = db.prepare('SELECT MAX(generated_thru) m FROM channels WHERE enabled = 1').get();
    if (!g || !g.m) return 0;
    const start = floorToSlot(Date.now(), 30);
    return Math.max(0, Math.floor((g.m - start) / (30 * MINUTE)) - 3);
  }

  /** Assemble everything the guide overlay needs from the schedule + the clock. */
  #buildGuideData(at) {
    const winStart = floorToSlot(at, 30) + this.guideOffset * 30 * MINUTE;
    const winSpanMs = 90 * MINUTE;
    const g = guide(winStart, winSpanMs / HOUR);
    const rows = g.channels.map((c) => ({
      id: c.id,
      number: c.number,
      name: c.name,
      // Blocks span the whole slot (ad breaks collapsed) so they tile the grid.
      programs: (c.programs || []).map((p) => ({
        startUtc: p.startUtc,
        endUtc: p.endUtc,
        title: p.title,
        subtitle: p.subtitle,
      })),
    }));
    if (this.guideIndex >= rows.length) this.guideIndex = Math.max(0, rows.length - 1);

    const cur = this.channelId ? nowOn(this.channelId, at) : null;
    const chan = this.channel;
    const info = cur && chan
      ? {
          number: chan.number,
          name: chan.name,
          title: cur.title,
          subtitle: cur.subtitle,
          seasonNo: cur.seasonNo,
          episodeNo: cur.episodeNo,
          offsetMs: cur.offsetMs,
          durationMs: cur.durationMs,
          startUtc: cur.startUtc,
          endUtc: cur.endUtc,
        }
      : null;

    const rowOffset = Math.max(0, Math.min(this.guideIndex - 2, Math.max(0, rows.length - 5)));
    return { info, rows, selectedIndex: this.guideIndex, rowOffset, winStart, winSpanMs, now: at };
  }

  async #drawGuide() {
    if (!this.mpv || !this.mpv.ready || !this.guideOpen) return;
    await this.mpv
      .showOverlay(OVERLAY_IDS.guide, guideScreen(this.#buildGuideData(Date.now())))
      .catch(() => {});
  }

  /** No pausing, no seeking. Flash ⊘ for a beat, exactly like the browser TV. */
  async #flashBlocked() {
    if (!this.mpv || !this.mpv.ready) return;
    await this.mpv.showOverlay(OVERLAY_IDS.blocked, blockedGlyph()).catch(() => {});
    setTimeout(() => {
      this.mpv?.clearOverlay(OVERLAY_IDS.blocked).catch(() => {});
    }, 450);
  }

  async #drawDigits() {
    if (!this.mpv || !this.mpv.ready) return;
    await this.mpv.showOverlay(OVERLAY_IDS.digits, tuneDigits(this.digits)).catch(() => {});
  }

  /** Make what is playing match what the schedule says should be playing. */
  async sync(force = false) {
    if (!this.channelId) return;
    const at = Date.now();

    // NTP sanity gate: a Pi with no real-time clock cold-boots thinking it's 1970.
    // Don't guess the schedule against a bogus clock — show a card until time syncs.
    if (at < CLOCK_SANE_AFTER) {
      if (this.mpv && this.mpv.ready) {
        await this.mpv.stop().catch(() => {});
        await this.mpv.showOverlay(OVERLAY_IDS.card, troubleCard('Waiting for the clock to sync…')).catch(() => {});
      }
      return;
    }

    const program = nowOn(this.channelId, at);

    if (!program) {
      if (force || this.currentProgramId !== 'none') {
        this.currentProgramId = 'none';
        if (this.mpv && this.mpv.ready) {
          await this.mpv.stop().catch(() => {});
          await this.mpv
            .showOverlay(OVERLAY_IDS.card, troubleCard('Nothing is scheduled on this channel'))
            .catch(() => {});
        }
      }
      return;
    }

    if (!force && program.id === this.currentProgramId) return;
    this.currentProgramId = program.id;

    // Once real content plays on a channel you'd stuck to, drop the stickiness —
    // a later gap here becomes ordinary passive dead air the auto-hop can act on.
    if ((program.kind === 'episode' || program.kind === 'movie') && this.stickyChannelId === this.channelId) {
      this.stickyChannelId = null;
    }

    const chan = this.channel;

    if (!this.mpv || !this.mpv.ready) {
      this.emit('program', program);
      return;
    }

    if (program.kind === 'offair') {
      // Deliberate dead air (dark hours). Show the off-air card, never hop away.
      await this.mpv.stop().catch(() => {});
      await this.mpv
        .showOverlay(OVERLAY_IDS.card, offAirCard(chan, program.subtitle))
        .catch(() => {});
    } else if (program.kind === 'filler') {
      // A gap no ad could fill. Show colour bars; tick() handles hopping away to
      // a channel that has real content on, and keeps re-checking each second.
      await this.mpv.stop().catch(() => {});
      await this.mpv.showOverlay(OVERLAY_IDS.card, colorBars(chan)).catch(() => {});
    } else if (!program.playable) {
      await this.mpv.stop().catch(() => {});
      await this.mpv.showOverlay(OVERLAY_IDS.card, fillerCard(chan)).catch(() => {});
    } else {
      await this.mpv.clearOverlay(OVERLAY_IDS.card).catch(() => {});
      // mpv wants a real path for local files; the browser wants the route.
      const src = program.localPath || program.source;
      await this.mpv.play(src, program.offsetMs / 1000).catch((err) => {
        this.lastError = err.message;
      });
      // Loudness: pull a hot commercial down (or a quiet one up) to match shows.
      await this.mpv
        .setProperty('af', program.gainDb ? `volume=${program.gainDb}dB` : '')
        .catch(() => {});
      // Display fill: panscan 1.0 crops the picture to fill the screen (no
      // letterbox bars), the right call on a 4:3 set. 'fit' leaves it whole.
      await this.mpv
        .setProperty('panscan', getSetting('display_fill', 'fit') === 'fill' ? 1.0 : 0.0)
        .catch(() => {});
      // Captions: show embedded subtitles when the household wants them.
      await this.mpv
        .setProperty('sub-visibility', getSetting('captions', 0) ? 'yes' : 'no')
        .catch(() => {});
      // A show starting is worth announcing, same as cable did.
      if (program.offsetMs < 3000 && (program.kind === 'episode' || program.kind === 'movie')) {
        this.bannerUntil = Date.now() + BANNER_MS;
      }
    }

    this.emit('program', program);
  }

  async tick() {
    await this.sync(false);
    if (!this.mpv || !this.mpv.ready) return;

    // While browsing the guide, keep it live (progress bars, now-line, clock)
    // and hold the channel — no auto-hop, no banner yanking focus.
    if (this.guideOpen) {
      await this.#drawGuide();
      return;
    }

    // Sitting on dead air (a gap with no ad)? Hop to a channel with real content
    // on right now. Re-checked every tick, so we catch content coming back on
    // another channel too. Nothing on anywhere → stay on colour bars.
    const at = Date.now();
    const cur = this.channelId ? nowOn(this.channelId, at) : null;
    if (cur && cur.kind === 'filler' && this.channelId !== this.stickyChannelId && at - this.lastHopAt > 3000) {
      const alt = this.#firstChannelWithContent(at, this.channelId);
      if (alt) {
        this.lastHopAt = at;
        await this.tune(alt, { silent: true });
        return;
      }
    }

    if (Date.now() < this.bannerUntil) {
      const snap = this.snapshot();
      if (snap.channel) {
        await this.mpv
          .showOverlay(OVERLAY_IDS.banner, channelBanner(snap))
          .catch(() => {});
      }
    } else {
      await this.mpv.clearOverlay(OVERLAY_IDS.banner).catch(() => {});
    }
  }

  snapshot() {
    const at = Date.now();
    return {
      status: this.status,
      driver: this.driver,
      lastError: this.lastError,
      channel: this.channel,
      now: this.channelId ? nowOn(this.channelId, at) : null,
      next: this.channelId ? upNext(this.channelId, 1, at)[0] || null : null,
      bannerVisible: at < this.bannerUntil,
      digits: this.digits,
    };
  }
}

export const engine = new Engine();
