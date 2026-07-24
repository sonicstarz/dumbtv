import { db } from '../db.js';
import { streamUrl } from '../plex/client.js';
import { HOUR } from '../util/time.js';

const qNow = db.prepare(`
  SELECT * FROM programs
  WHERE channel_id = ? AND start_utc <= ? AND end_utc > ?
  ORDER BY start_utc DESC LIMIT 1
`);

const qNext = db.prepare(`
  SELECT * FROM programs
  WHERE channel_id = ? AND start_utc > ?
  ORDER BY start_utc ASC LIMIT ?
`);

const qMedia = db.prepare('SELECT * FROM media WHERE rating_key = ?');
const qAsset = db.prepare('SELECT * FROM assets WHERE id = ?');

/**
 * The one query the whole illusion rests on: what is airing right now, and
 * how far into it are we? Seek that many ms in and you have joined a
 * broadcast in progress.
 */
export function nowOn(channelId, at = Date.now()) {
  const row = qNow.get(channelId, at, at);
  if (!row) return null;
  return decorate(row, at);
}

export function upNext(channelId, count = 1, at = Date.now()) {
  return qNext.all(channelId, at, count).map((r) => decorate(r, at));
}

function decorate(row, at) {
  const offsetMs = Math.max(0, at - row.start_utc);
  const out = {
    id: row.id,
    channelId: row.channel_id,
    startUtc: row.start_utc,
    endUtc: row.end_utc,
    durationMs: row.duration_ms,
    kind: row.kind,
    title: row.title,
    subtitle: row.subtitle,
    seasonNo: row.season_no,
    episodeNo: row.episode_no,
    ratingKey: row.rating_key,
    offsetMs,
    remainingMs: Math.max(0, row.end_utc - at),
    source: null,
    playable: false,
  };

  if (row.kind === 'episode' || row.kind === 'movie') {
    const m = qMedia.get(row.rating_key);
    if (m && m.part_key) {
      if (m.part_key.startsWith('local:')) {
        // Demo content, or anything you dropped in by hand rather than
        // through Plex.
        const p = m.part_key.slice(6);
        out.source = `/api/local?p=${encodeURIComponent(p)}`;
        out.localPath = p;
        out.playable = true;
      } else {
        try {
          out.source = streamUrl(m.part_key);
          out.playable = true;
        } catch {
          out.source = null;
        }
      }
      out.thumb = m.thumb;
    }
  } else if (row.kind === 'ad' || row.kind === 'bumper') {
    const a = qAsset.get(row.asset_id);
    if (a && a.part_key) {
      // A commercial imported from Plex — direct-play, same as a show.
      try {
        out.source = streamUrl(a.part_key);
        out.playable = true;
      } catch {
        out.source = null;
      }
    } else if (a) {
      out.source = `/api/local?p=${encodeURIComponent(a.path)}`;
      out.localPath = a.path;
      out.playable = true;
    }
  }
  // 'filler' and 'offair' have no source — the player draws a card instead.

  return out;
}

/** Everything airing on every channel right now. Powers the ON AIR strip. */
export function nowOnAll(at = Date.now()) {
  const channels = db
    .prepare('SELECT * FROM channels WHERE enabled = 1 ORDER BY number')
    .all();
  return channels.map((c) => ({
    channel: publicChannel(c),
    now: nowOn(c.id, at),
    next: upNext(c.id, 1, at)[0] || null,
  }));
}

/**
 * Guide grid. Programs are grouped by their slot so ad breaks collapse into
 * the block they belong to — exactly how a real listings grid reads.
 */
export function guide(fromTs, hours = 3) {
  const from = fromTs;
  const to = fromTs + hours * HOUR;
  const channels = db
    .prepare('SELECT * FROM channels WHERE enabled = 1 ORDER BY number')
    .all();

  const rows = db.prepare(`
    SELECT * FROM programs
    WHERE channel_id = ? AND end_utc > ? AND start_utc < ?
      AND kind IN ('episode','movie','offair')
    ORDER BY start_utc
  `);

  return {
    from,
    to,
    channels: channels.map((c) => ({
      ...publicChannel(c),
      programs: rows.all(c.id, from, to).map((r) => {
        const slotEnd = db
          .prepare(
            `SELECT MAX(end_utc) AS e FROM programs
             WHERE channel_id = ? AND slot_start = ?`
          )
          .get(c.id, r.slot_start);
        return {
          id: r.id,
          startUtc: r.start_utc,
          endUtc: slotEnd && slotEnd.e ? slotEnd.e : r.end_utc,
          airsUntil: r.end_utc,
          kind: r.kind,
          title: r.title,
          subtitle: r.subtitle,
          seasonNo: r.season_no,
          episodeNo: r.episode_no,
        };
      }),
    })),
  };
}

export function publicChannel(c) {
  return {
    id: c.id,
    number: c.number,
    name: c.name,
    slotMinutes: c.slot_minutes,
    orderingMode: c.ordering_mode,
    marathonSize: c.marathon_size,
    darkStart: c.dark_start,
    darkEnd: c.dark_end,
    adsEnabled: !!c.ads_enabled,
    maxAdsPerBreak: c.max_ads_per_break,
    adTags: c.ad_tags,
    timingMode: c.timing_mode || 'continuous',
    adsBetween: c.ads_between ?? 4,
    cooldownDays: c.cooldown_days ?? 0,
    enabled: !!c.enabled,
    generatedThru: c.generated_thru,
  };
}
