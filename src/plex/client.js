import { PLEX_HEADERS } from '../config.js';
import { db, getSetting } from '../db.js';
import { getServer } from './auth.js';
import { measureGain } from '../assets.js';

function requireServer() {
  const server = getServer();
  if (!server || !server.uri) {
    throw new Error('No Plex server selected yet. Connect one in Setup.');
  }
  return server;
}

async function plexGet(path) {
  const server = requireServer();
  const url = `${server.uri}${path}${path.includes('?') ? '&' : '?'}X-Plex-Token=${server.accessToken}`;
  const res = await fetch(url, { headers: PLEX_HEADERS });
  if (!res.ok) {
    throw new Error(`Plex returned ${res.status} for ${path}`);
  }
  const data = await res.json();
  return data.MediaContainer || {};
}

export async function ping() {
  const server = requireServer();
  const res = await fetch(
    `${server.uri}/identity?X-Plex-Token=${server.accessToken}`,
    { headers: PLEX_HEADERS, signal: AbortSignal.timeout(5000) }
  );
  return res.ok;
}

export async function getSections() {
  const mc = await plexGet('/library/sections');
  return (mc.Directory || []).map((d) => ({
    key: d.key,
    title: d.title,
    type: d.type, // 'show' | 'movie' | 'artist' | ...
  }));
}

/** Top-level items in a library: shows or movies. */
export async function getSectionItems(sectionKey, type) {
  const typeParam = type === 'movie' ? 1 : 2;
  const mc = await plexGet(
    `/library/sections/${sectionKey}/all?type=${typeParam}`
  );
  return (mc.Metadata || []).map((m) => ({
    ratingKey: m.ratingKey,
    title: m.title,
    year: m.year,
    type: m.type,
    thumb: m.thumb,
    childCount: m.childCount,
    leafCount: m.leafCount,
    duration: m.duration,
  }));
}

function pickPartKey(meta) {
  const media = meta.Media && meta.Media[0];
  const part = media && media.Part && media.Part[0];
  return part ? part.key : null;
}

/** Every episode under a show, in one request. */
export async function getAllEpisodes(showKey) {
  const mc = await plexGet(`/library/metadata/${showKey}/allLeaves`);
  return (mc.Metadata || []).map((m) => ({
    ratingKey: m.ratingKey,
    parentKey: String(showKey),
    kind: 'episode',
    title: m.title,
    showTitle: m.grandparentTitle,
    seasonNo: m.parentIndex,
    episodeNo: m.index,
    aired: m.originallyAvailableAt || null,
    durationMs: m.duration || 0,
    partKey: pickPartKey(m),
    thumb: m.thumb,
  }));
}

export async function getMovie(movieKey) {
  const mc = await plexGet(`/library/metadata/${movieKey}`);
  const m = (mc.Metadata || [])[0];
  if (!m) return null;
  return {
    ratingKey: m.ratingKey,
    parentKey: null,
    kind: 'movie',
    title: m.title,
    showTitle: null,
    seasonNo: null,
    episodeNo: null,
    aired: m.originallyAvailableAt || null,
    durationMs: m.duration || 0,
    partKey: pickPartKey(m),
    thumb: m.thumb,
  };
}

const upsertMedia = db.prepare(`
  INSERT INTO media
    (rating_key, parent_key, kind, title, show_title, season_no, episode_no,
     aired, duration_ms, part_key, thumb, updated_at)
  VALUES
    (@ratingKey, @parentKey, @kind, @title, @showTitle, @seasonNo, @episodeNo,
     @aired, @durationMs, @partKey, @thumb, @updatedAt)
  ON CONFLICT(rating_key) DO UPDATE SET
    parent_key  = excluded.parent_key,
    kind        = excluded.kind,
    title       = excluded.title,
    show_title  = excluded.show_title,
    season_no   = excluded.season_no,
    episode_no  = excluded.episode_no,
    aired       = excluded.aired,
    duration_ms = excluded.duration_ms,
    part_key    = excluded.part_key,
    thumb       = excluded.thumb,
    updated_at  = excluded.updated_at
`);

const cacheMany = db.transaction((rows) => {
  for (const r of rows) upsertMedia.run(r);
});

/**
 * Pull a source's playable items into the local cache. Scheduling reads
 * only from the cache, so the TV keeps working if Plex goes away.
 */
export async function cacheSource(ratingKey, sourceType) {
  const now = Date.now();
  let items = [];

  if (sourceType === 'movie') {
    const m = await getMovie(ratingKey);
    if (m) items = [m];
  } else {
    items = await getAllEpisodes(ratingKey);
  }

  const usable = items.filter((i) => i.partKey && i.durationMs > 0);
  const skipped = items.length - usable.length;

  cacheMany(usable.map((i) => ({ ...i, updatedAt: now })));
  return { cached: usable.length, skipped };
}

/**
 * Every playable item in a library, with its part key — used to pull a whole
 * library of commercials into the ad pool. A commercials library is just a
 * movie-type library where each spot is a "movie" with one part.
 */
export async function getSectionAds(sectionKey) {
  const mc = await plexGet(`/library/sections/${sectionKey}/all`);
  const items = await Promise.all(
    (mc.Metadata || []).map(async (m) => {
      let partKey = pickPartKey(m);
      let durationMs = m.duration || 0;
      // Some list responses omit Media/Part; fetch the item to be sure.
      if (!partKey || !durationMs) {
        const full = await getMovie(m.ratingKey).catch(() => null);
        if (full) {
          partKey = full.partKey;
          durationMs = full.durationMs;
        }
      }
      return {
        ratingKey: String(m.ratingKey),
        title: m.title,
        durationMs,
        partKey,
      };
    })
  );
  return items.filter((i) => i.partKey && i.durationMs > 0);
}

const upsertAdAsset = db.prepare(`
  INSERT INTO assets (path, title, kind, duration_ms, tags, rating_key, part_key, gain_db)
  VALUES (@path, @title, 'ad', @durationMs, '', @ratingKey, @partKey, @gainDb)
  ON CONFLICT(path) DO UPDATE SET
    title       = excluded.title,
    duration_ms = excluded.duration_ms,
    part_key    = excluded.part_key,
    gain_db     = COALESCE(excluded.gain_db, assets.gain_db)
`);

/**
 * Pull a Plex library of commercials into the local ad pool. They land in the
 * same `assets` table as local ads, so the scheduler treats them identically —
 * the only difference is playback resolves to a Plex direct URL, not a file.
 */
export async function importPlexAds(sectionKey) {
  const spots = await getSectionAds(sectionKey);
  const target = getSetting('loudness_target', -23);
  // Measure loudness up front (async — can't run inside the write transaction).
  // Over the WAN this is the slow part of an import; best-effort per spot.
  for (const s of spots) {
    try { s.gainDb = await measureGain(streamUrl(s.partKey), target); } catch { s.gainDb = null; }
  }
  const run = db.transaction((rows) => {
    for (const s of rows) {
      upsertAdAsset.run({
        path: `plex:${s.ratingKey}`,
        title: s.title,
        durationMs: s.durationMs,
        ratingKey: s.ratingKey,
        partKey: s.partKey,
        gainDb: s.gainDb ?? null,
      });
    }
  });
  run(spots);
  return { imported: spots.length };
}

/** A URL mpv (or a browser) can play directly. No transcoding, ever. */
export function streamUrl(partKey) {
  const server = requireServer();
  return `${server.uri}${partKey}?X-Plex-Token=${server.accessToken}`;
}

/**
 * What the WEB UI is given for artwork. Deliberately NOT the Plex URL: that
 * carries X-Plex-Token, and handing it to a browser puts the token in page
 * source, history, devtools, and any screenshot of the config UI. The Apple
 * app has proxied artwork for exactly this reason since build 12; Node was
 * still handing the token out (S-5).
 */
export function imageUrl(thumb, width = 300, height = 450) {
  if (!getServer() || !thumb) return null;
  return `/api/image?path=${encodeURIComponent(thumb)}&w=${width}&h=${height}`;
}

// A thumb is a Plex library path and nothing else. Without this the proxy is an
// authenticated open proxy: anything on the LAN could ask us to make token-bearing
// requests to arbitrary Plex endpoints and read the replies back (S-6).
const SAFE_THUMB = /^\/library\/[A-Za-z0-9/_.-]+$/;

/** Fetch artwork server-side, so the token stays here. Returns {buf, type} or null. */
export async function fetchImage(thumb, width = 300, height = 450) {
  const server = getServer();
  if (!server || !thumb || !SAFE_THUMB.test(thumb)) return null;
  const inner = encodeURIComponent(`${thumb}?X-Plex-Token=${server.accessToken}`);
  const url = `${server.uri}/photo/:/transcode?width=${width}&height=${height}&minSize=1&url=${inner}&X-Plex-Token=${server.accessToken}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  return { buf, type: res.headers.get('content-type') || 'image/jpeg' };
}
