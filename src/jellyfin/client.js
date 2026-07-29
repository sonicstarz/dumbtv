import { db, getSetting } from '../db.js';
import { getJfServer, JF_AUTH_HEADER } from './auth.js';
import { measureLoudnessGain } from '../assets.js';

// VERIFIED LIVE against Jellyfin 10.11.11 (build 13): AuthenticateByName,
// /Users/:id/Views, /Users/:id/Items, /Shows/:id/Episodes, the movie lookup,
// cacheSource, /Items/:id/Images/Primary, and the ?static=true stream URL — which
// serves real bytes and honours Range requests, so join-in-progress seeks work.
// Never transcoded: every stream URL uses ?static=true so Jellyfin direct-plays.

function requireServer() {
  const s = getJfServer();
  if (!s || !s.url || !s.token) throw new Error('No Jellyfin server connected yet.');
  return s;
}

function headers(s) {
  return { 'X-Emby-Token': s.token, 'X-Emby-Authorization': JF_AUTH_HEADER };
}

async function jfGet(path) {
  const s = requireServer();
  const res = await fetch(`${s.url}${path}`, { headers: headers(s) });
  if (!res.ok) throw new Error(`Jellyfin returned ${res.status} for ${path}`);
  return res.json();
}

const ticksToMs = (t) => (t ? Math.round(t / 10000) : 0);
const airedOf = (iso) => (iso ? String(iso).slice(0, 10) : null);

// Verified live (10.11.11): an item with no artwork 404s on
// /Items/:id/Images/Primary, and `ImageTags.Primary` is how you know in advance.
// This used to return the item id unconditionally, so every artless item claimed
// a poster and the picker asked for an image that could not exist.
const thumbOf = (m) => (m.ImageTags && m.ImageTags.Primary ? m.Id : null);

export async function ping() {
  const s = requireServer();
  const res = await fetch(`${s.url}/System/Info/Public`, { signal: AbortSignal.timeout(5000) });
  return res.ok;
}

/** Libraries, mapped to dumbTV's show/movie section types. */
export async function getSections() {
  const s = requireServer();
  const data = await jfGet(`/Users/${s.userId}/Views`);
  return (data.Items || [])
    .map((v) => ({
      key: v.Id,
      title: v.Name,
      type: v.CollectionType === 'movies' ? 'movie' : v.CollectionType === 'tvshows' ? 'show' : v.CollectionType,
    }))
    .filter((v) => v.type === 'show' || v.type === 'movie');
}

/** Top-level items in a library: series or movies. */
export async function getSectionItems(sectionKey, type) {
  const s = requireServer();
  const kind = type === 'movie' ? 'Movie' : 'Series';
  const data = await jfGet(
    `/Users/${s.userId}/Items?ParentId=${sectionKey}&IncludeItemTypes=${kind}&Recursive=true&SortBy=SortName&Fields=ChildCount,RecursiveItemCount`
  );
  return (data.Items || []).map((m) => ({
    ratingKey: m.Id,
    title: m.Name,
    year: m.ProductionYear,
    type: type === 'movie' ? 'movie' : 'show',
    thumb: thumbOf(m), // imageUrl() builds from the item id; null = no artwork
    leafCount: m.RecursiveItemCount ?? m.ChildCount,
    duration: ticksToMs(m.RunTimeTicks),
  }));
}

/** Every episode under a series, in one request. */
export async function getAllEpisodes(seriesId) {
  const s = requireServer();
  const data = await jfGet(
    `/Shows/${seriesId}/Episodes?userId=${s.userId}&Fields=PremiereDate,MediaSources`
  );
  return (data.Items || []).map((m) => ({
    ratingKey: m.Id,
    parentKey: String(seriesId),
    kind: 'episode',
    title: m.Name,
    showTitle: m.SeriesName,
    seasonNo: m.ParentIndexNumber,
    episodeNo: m.IndexNumber,
    aired: airedOf(m.PremiereDate),
    durationMs: ticksToMs(m.RunTimeTicks),
    partKey: `jf:${m.Id}`,
    thumb: thumbOf(m),
  }));
}

export async function getMovie(movieId) {
  const s = requireServer();
  const m = await jfGet(`/Users/${s.userId}/Items/${movieId}`);
  if (!m || !m.Id) return null;
  return {
    ratingKey: m.Id,
    parentKey: null,
    kind: 'movie',
    title: m.Name,
    showTitle: null,
    seasonNo: null,
    episodeNo: null,
    aired: airedOf(m.PremiereDate),
    durationMs: ticksToMs(m.RunTimeTicks),
    partKey: `jf:${m.Id}`,
    thumb: thumbOf(m),
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
    parent_key=excluded.parent_key, kind=excluded.kind, title=excluded.title,
    show_title=excluded.show_title, season_no=excluded.season_no,
    episode_no=excluded.episode_no, aired=excluded.aired,
    duration_ms=excluded.duration_ms, part_key=excluded.part_key,
    thumb=excluded.thumb, updated_at=excluded.updated_at
`);
const cacheMany = db.transaction((rows) => {
  for (const r of rows) upsertMedia.run(r);
});

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
  cacheMany(usable.map((i) => ({ ...i, updatedAt: now })));
  return { cached: usable.length, skipped: items.length - usable.length };
}

/** Every playable item in a library — used to pull a library of commercials. */
export async function getSectionAds(sectionKey) {
  const s = requireServer();
  const data = await jfGet(
    `/Users/${s.userId}/Items?ParentId=${sectionKey}&IncludeItemTypes=Movie&Recursive=true&Fields=MediaSources`
  );
  return (data.Items || [])
    .map((m) => ({
      ratingKey: m.Id,
      title: m.Name,
      durationMs: ticksToMs(m.RunTimeTicks),
      partKey: `jf:${m.Id}`,
    }))
    .filter((a) => a.durationMs > 0);
}

// Ads land in the same `assets` table as local/Plex ads. The unique key is
// `path`, so we key on jellyfin:<id> (ON CONFLICT(path)), same as Plex uses
// plex:<id>. The part_key stays jf:<id> so streamUrl direct-plays it.
const upsertAdAsset = db.prepare(`
  INSERT INTO assets (path, title, kind, duration_ms, tags, rating_key, part_key, gain_db)
  VALUES (@path, @title, 'ad', @durationMs, '', @ratingKey, @partKey, @gainDb)
  ON CONFLICT(path) DO UPDATE SET
    title       = excluded.title,
    duration_ms = excluded.duration_ms,
    part_key    = excluded.part_key,
    gain_db     = COALESCE(excluded.gain_db, assets.gain_db)
`);

export async function importJellyfinAds(sectionKey) {
  const ads = await getSectionAds(sectionKey);
  const target = getSetting('loudness_target', -23);
  for (const a of ads) {
    try { a.gainDb = await measureLoudnessGain(streamUrl(a.partKey), target); } catch { a.gainDb = null; }
  }
  const run = db.transaction((rows) => {
    for (const a of rows) {
      upsertAdAsset.run({
        path: `jellyfin:${a.ratingKey}`,
        title: a.title,
        durationMs: a.durationMs,
        ratingKey: a.ratingKey,
        partKey: a.partKey,
        gainDb: a.gainDb ?? null,
      });
    }
  });
  run(ads);
  return { imported: ads.length };
}

/** A URL mpv (or a browser) can play directly. static=true = never transcode. */
export function streamUrl(partKey) {
  const s = requireServer();
  const id = partKey.startsWith('jf:') ? partKey.slice(3) : partKey;
  return `${s.url}/Videos/${id}/stream?static=true&mediaSourceId=${id}&api_key=${s.token}`;
}

/** Proxied, like Plex — the api_key must not reach the browser (S-5). */
export function imageUrl(itemId, width = 300, height = 450) {
  if (!getJfServer() || !itemId) return null;
  return `/api/image?path=${encodeURIComponent(itemId)}&w=${width}&h=${height}`;
}

// A Jellyfin "thumb" is an item id, so anything with a slash or a dot is not one
// — and would otherwise let a caller steer the request elsewhere (S-6).
const SAFE_ITEM_ID = /^[A-Za-z0-9-]{8,64}$/;

/** Fetch artwork server-side. Returns {buf, type} or null. */
export async function fetchImage(itemId, width = 300, height = 450) {
  const s = getJfServer();
  if (!s || !itemId || !SAFE_ITEM_ID.test(itemId)) return null;
  const url = `${s.url}/Items/${itemId}/Images/Primary?fillWidth=${width}&fillHeight=${height}&api_key=${s.token}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) return null;   // an item with no artwork 404s — verified in build 13
  const buf = Buffer.from(await res.arrayBuffer());
  return { buf, type: res.headers.get('content-type') || 'image/jpeg' };
}
