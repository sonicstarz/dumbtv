import { db } from '../db.js';
import { config } from '../config.js';
import { buildPlaylist } from './ordering.js';
import { makeRng, hashString } from '../util/rng.js';
import {
  MINUTE,
  DAY,
  inDarkWindow,
  darkWindowEnd,
} from '../util/time.js';

const insertProgram = db.prepare(`
  INSERT INTO programs
    (channel_id, start_utc, end_utc, duration_ms, kind, rating_key, asset_id,
     title, subtitle, season_no, episode_no, slot_start)
  VALUES
    (@channelId, @startUtc, @endUtc, @durationMs, @kind, @ratingKey, @assetId,
     @title, @subtitle, @seasonNo, @episodeNo, @slotStart)
`);

const insertMany = db.transaction((rows) => {
  for (const r of rows) insertProgram.run(r);
});

function adPool(channel) {
  const tags = String(channel.ad_tags || '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

  const all = db
    .prepare(`SELECT * FROM assets WHERE kind IN ('ad','bumper') ORDER BY id`)
    .all();

  if (tags.length === 0) return all;

  const tagged = all.filter((a) => {
    const at = String(a.tags || '')
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    return at.some((t) => tags.includes(t));
  });

  // Falling back to the whole library beats an empty break.
  return tagged.length > 0 ? tagged : all;
}

// Aim for a short commercial break between shows, like real TV. There's no slot
// boundary to fill any more, so a break is just a couple of minutes of ads.
const AD_BREAK_TARGET_MS = 150 * 1000;

/**
 * A commercial break to sit between two programs. Ads up to the per-break cap or
 * ~2.5 minutes, then an optional station-ID bumper. No filler card — without a
 * slot boundary to hit, programs run straight into each other when there are no
 * ads, exactly like channel-surfing real broadcast TV.
 */
function buildAdBreak(channel, pool, seedKey) {
  const items = [];
  if (!channel.ads_enabled || pool.length === 0) return items;

  const rng = makeRng(hashString(seedKey));
  const ads = pool.filter((a) => a.kind === 'ad');
  const usable = ads.length > 0 ? ads : pool.filter((a) => a.kind !== 'bumper');
  const used = new Set();
  let placed = 0;
  let filled = 0;
  while (placed < channel.max_ads_per_break && filled < AD_BREAK_TARGET_MS) {
    let fits = usable.filter((a) => !used.has(a.id));
    // Only start repeating once every spot has already run this break.
    if (fits.length === 0) {
      used.clear();
      fits = usable;
    }
    if (fits.length === 0) break;
    const pick = fits[Math.floor(rng() * fits.length)];
    used.add(pick.id);
    items.push({ kind: 'ad', assetId: pick.id, title: pick.title, durationMs: pick.duration_ms });
    filled += pick.duration_ms;
    placed++;
  }

  const bumpers = pool.filter((a) => a.kind === 'bumper');
  if (bumpers.length > 0) {
    const pick = bumpers[Math.floor(rng() * bumpers.length)];
    items.push({ kind: 'bumper', assetId: pick.id, title: pick.title, durationMs: pick.duration_ms });
  }

  return items;
}

// A deterministic per-channel head start (up to 20 min) so channels aren't all
// in lock-step — switch channels and you land in the middle of different shows.
function staggerOffset(channel) {
  const rng = makeRng(hashString(`stagger:${channel.id}:${channel.shuffle_seed}`));
  return Math.floor(rng() * 20 * MINUTE);
}

/**
 * Extend a channel's schedule forward to `until`.
 * Append-only: already-generated programs are never rewritten, so a guide
 * you printed this morning is still correct tonight.
 */
export function generateChannel(channelId, until = Date.now() + config.scheduleWindowDays * DAY) {
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  if (!channel) throw new Error(`No channel ${channelId}`);

  const now = Date.now();

  // Where this channel's timeline begins. Topping up an existing schedule, we
  // continue from the end of what's already built. Building fresh, we back-date
  // by a per-channel stagger so the channel is already mid-show right now and
  // isn't aligned with every other channel.
  let t;
  if (channel.generated_thru && channel.generated_thru > now) {
    t = channel.generated_thru;
  } else {
    t = now - staggerOffset(channel);
  }
  if (t >= until) return { added: 0, reason: 'already built' };

  const playlist = buildPlaylist(channel, 0);
  const pool = adPool(channel);
  const rows = [];

  if (playlist.length === 0) {
    // No content picked yet — run colour bars rather than a black screen.
    rows.push({
      channelId: channel.id,
      startUtc: t,
      endUtc: until,
      durationMs: until - t,
      kind: 'offair',
      ratingKey: null,
      assetId: null,
      title: 'No content selected',
      subtitle: 'Add shows or movies to this channel',
      seasonNo: null,
      episodeNo: null,
      slotStart: t,
    });
    insertMany(rows);
    db.prepare('UPDATE channels SET generated_thru = ? WHERE id = ?').run(until, channel.id);
    return { added: 1, reason: 'no sources' };
  }

  let cursor = channel.cursor || 0;
  let cachedCycle = -1;
  let cachedList = playlist;

  const nextItem = () => {
    const len = cachedList.length || playlist.length;
    const cycle = Math.floor(cursor / len);
    if (cycle !== cachedCycle) {
      cachedCycle = cycle;
      cachedList =
        channel.ordering_mode === 'shuffle'
          ? buildPlaylist(channel, cycle)
          : playlist;
    }
    const item = cachedList[cursor % cachedList.length];
    cursor++;
    return item;
  };

  let guard = 0;
  while (t < until && guard++ < 20000) {
    if (inDarkWindow(t, channel.dark_start, channel.dark_end)) {
      const end = Math.min(darkWindowEnd(t, channel.dark_start, channel.dark_end), until);
      rows.push({
        channelId: channel.id,
        startUtc: t,
        endUtc: end,
        durationMs: end - t,
        kind: 'offair',
        ratingKey: null,
        assetId: null,
        title: 'Off air',
        subtitle: null,
        seasonNo: null,
        episodeNo: null,
        slotStart: t,
      });
      t = end;
      continue;
    }

    const item = nextItem();
    if (!item || !item.duration_ms) continue;

    // The program plays at its natural length, then straight into a break, then
    // the next program — no rounding to a slot boundary. The whole block (show +
    // its trailing ads) shares one slotStart so the guide groups it as one entry.
    const blockStart = t;
    const programEnd = t + item.duration_ms;

    rows.push({
      channelId: channel.id,
      startUtc: t,
      endUtc: programEnd,
      durationMs: item.duration_ms,
      kind: item.kind === 'movie' ? 'movie' : 'episode',
      ratingKey: item.rating_key,
      assetId: null,
      title: item.show_title || item.title,
      subtitle: item.show_title ? item.title : null,
      seasonNo: item.season_no,
      episodeNo: item.episode_no,
      slotStart: blockStart,
    });

    t = programEnd;

    const breakItems = buildAdBreak(channel, pool, `${channel.id}:${blockStart}`);
    for (const bi of breakItems) {
      rows.push({
        channelId: channel.id,
        startUtc: t,
        endUtc: t + bi.durationMs,
        durationMs: bi.durationMs,
        kind: bi.kind,
        ratingKey: null,
        assetId: bi.assetId,
        title: bi.title,
        subtitle: null,
        seasonNo: null,
        episodeNo: null,
        slotStart: blockStart,
      });
      t += bi.durationMs;
    }
  }

  insertMany(rows);
  db.prepare('UPDATE channels SET cursor = ?, generated_thru = ? WHERE id = ?').run(
    cursor,
    t,
    channel.id
  );

  return { added: rows.length, through: t };
}

/** Throw away everything not yet aired and rebuild. Use after editing a channel. */
export function regenerateChannel(channelId) {
  const now = Date.now();
  db.prepare('DELETE FROM programs WHERE channel_id = ? AND start_utc >= ?').run(
    channelId,
    now
  );
  const last = db
    .prepare(
      'SELECT MAX(end_utc) AS e FROM programs WHERE channel_id = ? AND start_utc < ?'
    )
    .get(channelId, now);
  const through = last && last.e ? last.e : now;
  db.prepare('UPDATE channels SET generated_thru = ? WHERE id = ?').run(through, channelId);
  return generateChannel(channelId);
}

/** Top every channel up to the rolling window, and sweep old programs. */
export function ensureSchedule() {
  const until = Date.now() + config.scheduleWindowDays * DAY;
  const channels = db.prepare('SELECT id FROM channels WHERE enabled = 1').all();
  const results = [];
  for (const c of channels) {
    results.push({ channelId: c.id, ...generateChannel(c.id, until) });
  }
  db.prepare('DELETE FROM programs WHERE end_utc < ?').run(Date.now() - 2 * DAY);
  return results;
}
