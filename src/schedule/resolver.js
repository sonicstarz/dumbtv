import { db } from '../db.js';
import { parseVibe } from '../vibe.js';
import { streamUrl } from '../media/backend.js';
import { resolvePackPath } from '../packs/install.js';
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

// What a viewer means by "next": the next SHOW. A printed listing never
// announced the commercial standing between you and it, so anything that says
// "NEXT" on screen skips ad pods and bumpers. Same kinds the guide grid shows.
const qNextShow = db.prepare(`
  SELECT * FROM programs
  WHERE channel_id = ? AND start_utc > ?
    AND kind IN ('episode','movie','offair')
  ORDER BY start_utc ASC LIMIT ?
`);

const qMedia = db.prepare('SELECT * FROM media WHERE rating_key = ?');
const qAsset = db.prepare('SELECT * FROM assets WHERE id = ?');

// The guide grid, hoisted to module scope like every other statement here —
// these used to be prepared inside a per-program loop.
const qGuideRows = db.prepare(`
  SELECT * FROM programs
  WHERE channel_id = ? AND end_utc > ? AND start_utc < ?
    AND kind IN ('episode','movie','offair')
  ORDER BY start_utc
`);

/** Every slot's true end (ad pods included) for the window, in ONE query. */
const qSlotEnds = db.prepare(`
  SELECT slot_start, MAX(end_utc) AS e FROM programs
  WHERE channel_id = ? AND slot_start IN (
    SELECT DISTINCT slot_start FROM programs
    WHERE channel_id = ? AND end_utc > ? AND start_utc < ?
  )
  GROUP BY slot_start
`);

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

/** As `upNext`, but skipping ad pods and bumpers — what "NEXT" means on screen. */
export function upNextShow(channelId, count = 1, at = Date.now()) {
  return qNextShow.all(channelId, at, count).map((r) => decorate(r, at));
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
    airingNo: row.airing_no ?? 1,
    ruleId: row.rule_id ?? null,
    offsetMs,
    remainingMs: Math.max(0, row.end_utc - at),
    source: null,
    playable: false,
  };

  if (row.kind === 'episode' || row.kind === 'movie') {
    const m = qMedia.get(row.rating_key);
    if (m) out.seriesPartial = !!m.series_partial;
    if (m && m.part_key) {
      if (m.part_key.startsWith('local:')) {
        // Demo content, or anything you dropped in by hand rather than
        // through Plex.
        const p = m.part_key.slice(6);
        out.source = `/api/local?p=${encodeURIComponent(p)}`;
        out.localPath = p;
        out.playable = true;
      } else if (m.part_key.startsWith('pack:')) {
        // A curated content pack (Track I) — resolves to a local file.
        const abs = resolvePackPath(m.part_key);
        if (abs) {
          out.source = `/api/local?p=${encodeURIComponent(abs)}`;
          out.localPath = abs;
          out.playable = true;
        }
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
    if (a && a.gain_db != null) out.gainDb = a.gain_db; // loudness adjustment
    if (a && a.part_key) {
      // A commercial imported from Plex — direct-play, same as a show.
      try {
        out.source = streamUrl(a.part_key);
        out.playable = true;
      } catch {
        out.source = null;
      }
    } else if (a && a.path && a.path.startsWith('pack:')) {
      // A commercial from a content pack (Track I) — resolves to a local file.
      const abs = resolvePackPath(a.path);
      if (abs) {
        out.source = `/api/local?p=${encodeURIComponent(abs)}`;
        out.localPath = abs;
        out.playable = true;
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
    next: upNextShow(c.id, 1, at)[0] || null,
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

  return {
    from,
    to,
    channels: channels.map((c) => {
      const rows = qGuideRows.all(c.id, from, to);
      // A block runs until the END of its slot, ads included — that is what
      // makes the grid read like a listings page. Getting that per row used to
      // mean one MAX() query PER PROGRAM (and a fresh prepare inside the loop);
      // one grouped query per channel answers it for every slot at once.
      const slotEnds = new Map();
      for (const s of qSlotEnds.all(c.id, c.id, from, to)) slotEnds.set(s.slot_start, s.e);

      return {
        ...publicChannel(c),
        programs: rows.map((r) => ({
          id: r.id,
          startUtc: r.start_utc,
          endUtc: slotEnds.get(r.slot_start) ?? r.end_utc,
          airsUntil: r.end_utc,
          kind: r.kind,
          title: r.title,
          subtitle: r.subtitle,
          seasonNo: r.season_no,
          episodeNo: r.episode_no,
        })),
      };
    }),
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
    overrunPolicy: c.overrun_policy || 'protect',
    enabled: !!c.enabled,
    // S3: a channel dumbTV ships and stands behind. The web UI swaps its
    // edit/delete affordances for a lock chip.
    locked: !!c.locked,
    // L-V1: this channel's own look, or null to inherit the global default.
    // The player resolves the scopes; the API just carries the document.
    vibe: parseVibe(c.vibe),
    // R3: what the player draws during a scheduled off-air window.
    offairPattern: c.offair_pattern || 'bars',
    // PD Packs Task 2: warnings this channel refuses to air.
    excludeWarnings: String(c.exclude_warnings || '').split(',').map((w) => w.trim()).filter(Boolean),
    signoffAssetId: c.signoff_asset_id ?? null,
    generatedThru: c.generated_thru,
  };
}
