/**
 * The browser TV. Same rules as the real thing on the Pi:
 * what's on is what's on, you join it in progress, and you can't pause it.
 */

import { escapeHtml } from './esc.js';
import { createStaticField } from './static-renderer.js';

const $ = (s) => document.querySelector(s);

const video = $('#video');

// U-5: the cheatsheet used to replay for 9 seconds on EVERY load, forever. It
// is a first-run courtesy, not a permanent fixture — the Apple app settled this
// in build 13 with first_run_done. `h` still brings it back any time.
const SEEN_HELP = 'dumbtv.helpSeen';
const firstRun = !localStorage.getItem(SEEN_HELP);
if (firstRun) localStorage.setItem(SEEN_HELP, '1');

const state = {
  channels: [],
  channelId: null,
  programId: null,
  program: null,
  guideOpen: false,
  guideIndex: 0,
  digits: '',
  digitTimer: null,
  bannerUntil: 0,
  helpUntil: firstRun ? Date.now() + 9000 : 0,
  fill: 'fit',
  captions: false,
  // K-B2: the up-next banner reveals itself near the end of a program, the way
  // a broadcaster slides one in over the last act. Once per program.
  nextRevealedFor: null,
  guideSig: '',        // E-5: only rebuild the guide DOM when it actually changed
};

// The one noise field. Channel-change bursts, off-air snow, and later the Vibe
// grain all draw through it.
const snow = createStaticField($('#snow'), { intensity: 0.85, grain: 4 });

const clock = (ts) =>
  new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Request failed');
  return res.json();
}

// ------------------------------------------------------------ screens

function show(which, opts = {}) {
  $('#filler').classList.toggle('on', which === 'filler');
  $('#bars').classList.toggle('on', which === 'bars');
  $('#trouble').classList.toggle('on', which === 'trouble');
  video.style.visibility = which === 'video' ? 'visible' : 'hidden';

  if (which === 'filler') {
    $('#fillerNum').textContent = String(opts.number ?? 0).padStart(2, '0');
    $('#fillerName').textContent = (opts.name || '').toUpperCase();
  }
  if (which === 'bars') {
    $('#barsTitle').textContent =
      `${String(opts.number ?? 0).padStart(2, '0')}  ${(opts.name || '').toUpperCase()}`;
    $('#barsMsg').textContent = opts.message || 'Programming resumes shortly';
  }
  if (which === 'trouble') {
    $('#troubleMsg').textContent = opts.message || 'We are experiencing technical difficulties';
  }
}

function flashNope() {
  const el = $('#nope');
  el.classList.add('on');
  setTimeout(() => el.classList.remove('on'), 450);
}

// ------------------------------------------------------------ display settings

function applyCaptions() {
  // Best-effort in the browser: embedded subs are only shown if the <video>
  // exposes them as text tracks. On the Pi, mpv handles this properly.
  const tracks = video.textTracks || [];
  for (const t of tracks) t.mode = state.captions ? 'showing' : 'hidden';
}

function applyDisplay() {
  document.body.classList.toggle('fill', state.fill === 'fill');
  applyCaptions();
}

async function loadDisplaySettings() {
  try {
    const s = await api('/api/settings');
    state.fill = s.displayFill === 'fill' ? 'fill' : 'fit';
    state.captions = !!s.captions;
    applyDisplay();
  } catch {}
}

// ------------------------------------------------------------ the loop

// U-4: a hidden tab is not watching television. Polling every second behind a
// backgrounded window is pure battery cost, and a dead server should not be
// hammered forever — back off, then recover the moment it answers.
let pollFails = 0;

async function poll() {
  if (document.hidden) return;
  let data;
  try {
    data = await api('/api/onair');
    pollFails = 0;
  } catch {
    pollFails++;
    show('trouble', { message: 'Cannot reach the dumbTV server' });
    return;
  }

  state.channels = data.channels;
  if (state.channels.length === 0) {
    show('trouble', { message: 'No channels have been set up yet' });
    return;
  }

  if (state.channelId == null || !state.channels.some((c) => c.channel.id === state.channelId)) {
    state.channelId = state.channels[0].channel.id;
    state.bannerUntil = Date.now() + 5000;
  }

  const entry = state.channels.find((c) => c.channel.id === state.channelId);
  const ch = entry.channel;
  const now = entry.now;
  state.program = now;

  if (!now) {
    show('trouble', { message: 'Nothing is scheduled on this channel' });
    state.programId = null;
    return;
  }

  const changed = now.id !== state.programId;
  state.programId = now.id;

  // K-B2: reveal the up-next banner over the last stretch of a program, once.
  // A viewer who can't pause deserves to be told what's coming without asking.
  const REVEAL_BEFORE_MS = 120000;
  if (now.remainingMs > 0 && now.remainingMs <= REVEAL_BEFORE_MS
      && state.nextRevealedFor !== now.id
      && (now.kind === 'episode' || now.kind === 'movie')
      && entry.next) {
    state.nextRevealedFor = now.id;
    state.bannerUntil = Date.now() + 6000;
  }

  if (now.kind === 'offair') {
    if (changed) video.removeAttribute('src');
    show('bars', { number: ch.number, name: ch.name, message: now.subtitle });
  } else if (now.kind === 'filler' || !now.playable) {
    if (changed) video.removeAttribute('src');
    show('filler', { number: ch.number, name: ch.name });
  } else {
    show('video');
    if (changed) {
      // This is the whole trick: open the file, then jump to exactly how far
      // into the broadcast we are.
      video.src = now.source;
      video.currentTime = now.offsetMs / 1000;
      video.play().catch(() => {
        show('trouble', { message: 'Click anywhere to start the picture' });
      });
      applyCaptions();
      if (now.offsetMs < 4000 && (now.kind === 'episode' || now.kind === 'movie')) {
        state.bannerUntil = Date.now() + 5000;
      }
    } else {
      // Correct any drift between the tape and the clock.
      const want = now.offsetMs / 1000;
      if (Number.isFinite(video.currentTime) && Math.abs(video.currentTime - want) > 5) {
        video.currentTime = want;
      }
    }
  }
}

function paint() {
  const now = Date.now();
  const entry = state.channels.find((c) => c.channel.id === state.channelId);

  $('#help').classList.toggle('on', now < state.helpUntil);
  $('#digits').classList.toggle('on', state.digits.length > 0);
  $('#digits').textContent = state.digits.padEnd(2, '·');

  // K-B1: the channel bug. Present whenever a picture is, absent when the
  // screen belongs to something else (a card, the guide, a dialled number).
  const showBug = !!entry && !state.guideOpen && state.program?.playable
    && state.program.kind !== 'offair';
  $('#bug').classList.toggle('on', showBug);
  if (showBug) $('#bugNum').textContent = String(entry.channel.number).padStart(2, '0');

  const showBanner = now < state.bannerUntil && !state.guideOpen;
  $('#banner').classList.toggle('on', showBanner);

  if (showBanner && entry) {
    const ch = entry.channel;
    const p = entry.now;
    $('#bNum').textContent = String(ch.number).padStart(2, '0');
    $('#bName').textContent = ch.name.toUpperCase();
    $('#bClock').textContent = clock(now);
    $('#bTitle').textContent = p ? p.title : 'Nothing scheduled';
    const ep =
      p && p.seasonNo != null && p.episodeNo != null
        ? `S${String(p.seasonNo).padStart(2, '0')}E${String(p.episodeNo).padStart(2, '0')}  `
        : '';
    $('#bSub').textContent = p && p.subtitle ? ep + p.subtitle : '';
    $('#bRange').textContent = p ? `${clock(p.startUtc)} – ${clock(p.endUtc)}` : '';
    $('#bNext').textContent = entry.next ? `NEXT  ${entry.next.title}` : '';
    const pct = p ? Math.min(100, (p.offsetMs / p.durationMs) * 100) : 0;
    $('#bProgress').style.width = `${pct}%`;
  }

  $('#guide').classList.toggle('on', state.guideOpen);
  $('#screen').classList.toggle('guiding', state.guideOpen);
  if (state.guideOpen) {
    // The clock ticks every frame; the ROWS change only when the poll brings
    // new data or the selection moves. Rebuilding the whole grid at 4 Hz threw
    // away the selected row on every tick — which is why selection could never
    // animate, and why a scrolling guide CHANNEL (R4) could not be built on
    // this at all. Rebuild on a cheap signature instead (E-5).
    $('#gClock').textContent = clock(now);
    const sig = state.guideIndex + '|' + state.channels
      .map((c) => `${c.channel.id}:${c.now?.id ?? 0}:${c.next?.id ?? 0}`).join(',');
    if (sig === state.guideSig) return;
    state.guideSig = sig;
    // Everything interpolated here is escaped: titles and channel names come
    // from Plex/Jellyfin metadata, from filenames, and from pack manifests, so
    // none of it is ours. (The banner and the cards above use textContent and
    // are safe by construction — this grid is the one place building markup.)
    $('#gRows').innerHTML = state.channels
      .map((c, i) => {
        const cells = [c.now, c.next]
          .map((p) =>
            p
              ? `<div class="gp">
                   <div class="tm">${escapeHtml(clock(p.startUtc))}</div>
                   <div class="pt">${escapeHtml(p.title)}</div>
                   <div class="ps">${escapeHtml(p.subtitle || '')}</div>
                 </div>`
              : '<div class="gp"><div class="ps">—</div></div>'
          )
          .join('');
        return `<div class="grow ${i === state.guideIndex ? 'sel' : ''}">
          <div class="gc"><div class="n">${escapeHtml(String(c.channel.number).padStart(2, '0'))}</div>
          <div class="t">${escapeHtml(c.channel.name)}</div></div>
          ${cells}
          <div class="gp"></div>
        </div>`;
      })
      .join('');
  }
}

// ------------------------------------------------------------ tuning

function tuneTo(channelId) {
  if (channelId === state.channelId) {
    state.bannerUntil = Date.now() + 5000;
    return;
  }
  state.channelId = channelId;
  state.programId = null;
  state.bannerUntil = Date.now() + 5000;
  state.nextRevealedFor = null;
  // K-B3: a moment of snow between channels. Deliberately not awaited — the
  // tune must not wait on an animation, so the picture arrives underneath and
  // the static clears off it.
  snow.burst(200);
  poll();
}

function surf(dir) {
  const idx = state.channels.findIndex((c) => c.channel.id === state.channelId);
  const next = (idx + dir + state.channels.length) % state.channels.length;
  tuneTo(state.channels[next].channel.id);
}

function pressDigit(d) {
  state.digits = (state.digits + d).slice(-3);
  clearTimeout(state.digitTimer);
  state.digitTimer = setTimeout(() => {
    const num = Number(state.digits);
    state.digits = '';
    const hit = state.channels.find((c) => c.channel.number === num);
    if (hit) tuneTo(hit.channel.id);
    else flashNope();
  }, 2000);
}

// ------------------------------------------------------------ remote keys

const BLOCKED = new Set([' ', 'k', 'K', 'ArrowLeft', 'ArrowRight', 'j', 'J', 'l', 'L']);

document.addEventListener('keydown', async (e) => {
  if (BLOCKED.has(e.key)) {
    // No pausing, no seeking. That is the point.
    e.preventDefault();
    flashNope();
    return;
  }

  if (e.key >= '0' && e.key <= '9') {
    pressDigit(e.key);
    return;
  }

  switch (e.key) {
    case 'ArrowUp':
      e.preventDefault();
      if (state.guideOpen) {
        state.guideIndex = Math.max(0, state.guideIndex - 1);
      } else surf(-1);
      break;
    case 'ArrowDown':
      e.preventDefault();
      if (state.guideOpen) {
        state.guideIndex = Math.min(state.channels.length - 1, state.guideIndex + 1);
      } else surf(1);
      break;
    case 'Enter':
      if (state.guideOpen) {
        tuneTo(state.channels[state.guideIndex].channel.id);
        state.guideOpen = false;
      } else {
        state.bannerUntil = Date.now() + 5000;
      }
      break;
    case 'g':
    case 'G':
      state.guideOpen = !state.guideOpen;
      state.guideSig = '';   // force one rebuild on open/close
      if (state.guideOpen) {
        state.guideIndex = Math.max(
          0,
          state.channels.findIndex((c) => c.channel.id === state.channelId)
        );
      }
      break;
    case 'Escape':
      state.guideOpen = false;
      break;
    case 'i':
    case 'I':
      state.bannerUntil = Date.now() + 5000;
      break;
    case 'c':
    case 'C':
      state.captions = !state.captions;
      applyCaptions();
      api('/api/settings', { method: 'POST', body: { captions: state.captions ? 1 : 0 } }).catch(() => {});
      state.bannerUntil = Date.now() + 2000;
      break;
    case 'r':
    case 'R':
      try {
        const r = await api('/api/dvr', { method: 'POST', body: { channelId: state.channelId } });
        state.bannerUntil = Date.now() + 2500;
        console.log('Recorded', r.recorded);
      } catch {
        flashNope();
      }
      break;
    case 'f':
    case 'F':
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen().catch(() => {});
      break;
    case 'h':
    case 'H':
      state.helpUntil = Date.now() < state.helpUntil ? 0 : Date.now() + 30000;
      break;
  }
});

// Browsers block autoplay with sound until the page is interacted with.
document.addEventListener('click', () => {
  video.play().catch(() => {});
});

let cursorTimer;
document.addEventListener('mousemove', () => {
  document.body.classList.add('showcursor');
  clearTimeout(cursorTimer);
  cursorTimer = setTimeout(() => document.body.classList.remove('showcursor'), 2500);
});

// Apply captions once a file's tracks are known.
video.addEventListener('loadeddata', applyCaptions);

// A finished file should never leave a frozen frame on screen.
video.addEventListener('ended', () => {
  state.programId = null;
  poll();
});
video.addEventListener('error', () => {
  if (state.program && state.program.playable) {
    show('trouble', { message: 'That file would not play' });
  }
});

poll();
loadDisplaySettings();

// The tick re-derives what should be on air; the schedule is the source of
// truth, never a timer, so a missed tick costs nothing but a late correction.
// Back off to at most ~8s while the server is unreachable (U-4).
(function tick() {
  const delay = pollFails ? Math.min(8000, 1000 * 2 ** Math.min(pollFails, 3)) : 1000;
  setTimeout(() => { poll().finally(tick); }, delay);
})();

setInterval(() => { if (!document.hidden) paint(); }, 250);
// Pick up display-setting changes made from the config app.
setInterval(() => { if (!document.hidden) loadDisplaySettings(); }, 10000);

// Coming back to the tab should feel instant, not up-to-a-second stale.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { pollFails = 0; poll(); paint(); }
});
