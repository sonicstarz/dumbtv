// packs/install.js — register a built content pack into the library (Track I, P1).
//
// A built pack is a folder holding a `pack.json` runtime manifest (produced by
// scripts/build-pack.js) plus the media files. Installing = registering:
//   - a row in `packs` (id → root_path on disk)
//   - `media` rows for a shows-pack (parent_key = pack:<id>, so the existing
//     channel_sources → library assembly works with zero scheduler changes)
//   - `assets` rows for an ads-pack (wired straight into the ad-pod system)
//
// Playback resolves a `pack:<id>/<file>` key to `<root_path>/<file>` — the same
// direct-play-from-a-local-file path the demo (`local:`) already uses.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { db } from '../db.js';
import { config } from '../config.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// The download catalog (dumbtv.app/packs/index.json is the live copy; this
// bundled file is the offline fallback the pack picker reads).
const CATALOG_PATH = path.join(REPO_ROOT, 'packs', 'index.json');
// Downloaded packs live beside the DB, in the data dir.
const downloadedPacksDir = () => path.join(path.dirname(config.dbPath), 'packs');

export const PACK_PREFIX = 'pack:';
export const packRatingKey = (packId) => `${PACK_PREFIX}${packId}`;
export const packPartKey = (packId, file) => `${PACK_PREFIX}${packId}/${file}`;

const qPackRoot = db.prepare('SELECT root_path FROM packs WHERE id = ?');

/** `pack:<id>/<file>` → absolute path on disk, or null if the pack/file is gone. */
export function resolvePackPath(key) {
  if (typeof key !== 'string' || !key.startsWith(PACK_PREFIX)) return null;
  const rest = key.slice(PACK_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash < 0) return null; // bare pack:<id> is a source key, not a file
  const packId = rest.slice(0, slash);
  const file = rest.slice(slash + 1);
  const row = qPackRoot.get(packId);
  if (!row) return null;
  return path.join(row.root_path, file);
}

const upsertPack = db.prepare(`
  INSERT INTO packs (id, name, version, kind, origin, root_path, installed_at)
  VALUES (@id, @name, @version, @kind, @origin, @rootPath, @installedAt)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name, version = excluded.version, kind = excluded.kind,
    origin = excluded.origin, root_path = excluded.root_path, installed_at = excluded.installed_at
`);

const upsertMedia = db.prepare(`
  INSERT INTO media
    (rating_key, parent_key, kind, title, show_title, season_no, episode_no,
     aired, duration_ms, part_key, thumb, updated_at)
  VALUES
    (@ratingKey, @parentKey, @kind, @title, @showTitle, @seasonNo, @episodeNo,
     @aired, @durationMs, @partKey, NULL, @updatedAt)
  ON CONFLICT(rating_key) DO UPDATE SET
    parent_key=excluded.parent_key, kind=excluded.kind, title=excluded.title,
    show_title=excluded.show_title, season_no=excluded.season_no,
    episode_no=excluded.episode_no, aired=excluded.aired,
    duration_ms=excluded.duration_ms, part_key=excluded.part_key,
    updated_at=excluded.updated_at
`);

const upsertAsset = db.prepare(`
  INSERT INTO assets (path, title, kind, duration_ms, tags, part_key)
  VALUES (@path, @title, @kind, @durationMs, @tags, NULL)
  ON CONFLICT(path) DO UPDATE SET
    title=excluded.title, kind=excluded.kind, duration_ms=excluded.duration_ms, tags=excluded.tags
`);

/** Read + validate a built runtime manifest from a pack's dist dir. */
export function readPack(distDir) {
  const file = path.join(distDir, 'pack.json');
  if (!fs.existsSync(file)) throw new Error(`no pack.json in ${distDir}`);
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!p.id || !Array.isArray(p.items) || !p.items.length) throw new Error(`invalid pack.json: ${file}`);
  for (const it of p.items) {
    if (!it.file || !Number.isFinite(it.durationMs)) throw new Error(`pack ${p.id}: item ${it.id} missing file/durationMs`);
  }
  return p;
}

/**
 * Install a built pack from its dist dir. Idempotent (re-install upserts).
 * `origin` is 'bundled' (ships in the app) or 'downloaded' (fetched later).
 */
export const installPack = db.transaction((distDir, { origin = 'downloaded' } = {}) => {
  const pack = readPack(distDir);
  const now = Date.now();
  upsertPack.run({
    id: pack.id, name: pack.name, version: pack.version ?? 1,
    kind: pack.kind ?? 'shows', origin, rootPath: path.resolve(distDir), installedAt: now,
  });

  if ((pack.kind ?? 'shows') === 'ads') {
    for (const it of pack.items) {
      upsertAsset.run({
        path: packPartKey(pack.id, it.file), title: it.title || it.id,
        kind: 'ad', durationMs: it.durationMs, tags: `pack,${pack.id}`,
      });
    }
    // Reconcile: drop this pack's assets no longer in the manifest.
    const keep = new Set(pack.items.map((it) => packPartKey(pack.id, it.file)));
    for (const row of db.prepare('SELECT path FROM assets WHERE path LIKE ?').all(`${packPartKey(pack.id, '')}%`)) {
      if (!keep.has(row.path)) db.prepare('DELETE FROM assets WHERE path=?').run(row.path);
    }
  } else {
    for (const it of pack.items) {
      const kind = it.season != null && it.episode != null ? 'episode' : 'movie';
      upsertMedia.run({
        ratingKey: `${packRatingKey(pack.id)}:${it.id}`,
        parentKey: packRatingKey(pack.id),
        kind, title: it.title || it.id, showTitle: it.show ?? null,
        seasonNo: it.season ?? null, episodeNo: it.episode ?? null,
        aired: it.aired ?? null, durationMs: it.durationMs,
        partKey: packPartKey(pack.id, it.file), updatedAt: now,
      });
    }
    // Reconcile: drop pack media no longer in the manifest so a partial→full
    // upgrade has an exact count and no stale rows linger.
    const keep = new Set(pack.items.map((it) => `${packRatingKey(pack.id)}:${it.id}`));
    for (const row of db.prepare('SELECT rating_key FROM media WHERE parent_key=?').all(packRatingKey(pack.id))) {
      if (!keep.has(row.rating_key)) db.prepare('DELETE FROM media WHERE rating_key=?').run(row.rating_key);
    }
  }
  return { id: pack.id, name: pack.name, kind: pack.kind ?? 'shows', items: pack.items.length };
});

/** Create a channel that plays a shows-pack. Uses the manifest's channel hints. */
export const createChannelFromPack = db.transaction((packId, overrides = {}) => {
  const pack = db.prepare('SELECT * FROM packs WHERE id = ?').get(packId);
  if (!pack) throw new Error(`pack not installed: ${packId}`);
  if (pack.kind === 'ads') throw new Error(`pack ${packId} is ads — no channel`);
  const ch = { number: null, name: pack.name, ordering: 'sequential', seed: null, ...channelHints(pack.root_path), ...overrides };
  // N3: the manifest number is a HINT — fall back to next-free when it's taken
  // (a hint of 7 collided with the preload channel and 500'd the INSERT).
  const maxNo = db.prepare('SELECT MAX(number) m FROM channels').get().m || 1;
  let number = ch.number ?? maxNo + 1;
  if (db.prepare('SELECT 1 FROM channels WHERE number=?').get(number)) number = maxNo + 1;
  const info = db.prepare(
    `INSERT INTO channels
       (number, name, slot_minutes, ordering_mode, marathon_size, shuffle_seed,
        dark_start, dark_end, ads_enabled, max_ads_per_break, ad_tags, enabled, created_at)
     VALUES (?,?,30,?,3,?,NULL,NULL,?,10,'',1,?)`
  ).run(
    number, ch.name, ch.ordering,
    ch.seed ?? Math.floor(Math.random() * 2 ** 31),
    overrides.adsEnabled === false ? 0 : 1, // preload channels: ads ON (D2)
    Date.now(),
  );
  db.prepare('INSERT OR IGNORE INTO channel_sources (channel_id, rating_key, source_type, title) VALUES (?,?,?,?)')
    .run(info.lastInsertRowid, packRatingKey(packId), 'pack', pack.name);
  return { channelId: info.lastInsertRowid };
});

function channelHints(rootPath) {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(rootPath, 'pack.json'), 'utf8'));
    return p.channel || {};
  } catch { return {}; }
}

/** Remove a pack's media/assets and its row. Aired programs are left alone. */
export const uninstallPack = db.transaction((packId) => {
  db.prepare('DELETE FROM media WHERE parent_key = ?').run(packRatingKey(packId));
  db.prepare('DELETE FROM assets WHERE path LIKE ?').run(`${packPartKey(packId, '')}%`);
  db.prepare('DELETE FROM packs WHERE id = ?').run(packId);
});

export function listPacks() {
  return db.prepare('SELECT id, name, version, kind, origin, root_path, installed_at FROM packs ORDER BY installed_at').all();
}

// ── catalog + one-tap install (P3) ───────────────────────────────────────────

export function loadCatalog() {
  try { return JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8')); }
  catch { return { version: 1, packs: [] }; }
}

// In-flight/finished install state, keyed by packId, for progress polling.
const installProgress = new Map();
export const getInstallProgress = (id) => installProgress.get(id) ?? null;

async function downloadTo(url, dest) {
  const res = await fetch(url, { headers: { 'User-Agent': 'dumbTV' } });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
}

/** The web-UI pack picker's view: every catalogued pack + its install/channel state. */
export function packsOverview() {
  const installed = new Map(listPacks().map((p) => [p.id, p]));
  const packChannels = new Set(
    db.prepare("SELECT rating_key FROM channel_sources WHERE source_type='pack'").all().map((r) => r.rating_key));
  return loadCatalog().packs.map((p) => {
    const prog = installProgress.get(p.id);
    // How many items are actually installed on disk — a bundled preload may ship
    // a SUBSET (e.g. 1 Superman episode of 17), so the picker can offer "download
    // the rest" (C-1).
    const installedItemCount = p.kind === 'ads'
      ? db.prepare('SELECT COUNT(*) n FROM assets WHERE path LIKE ?').get(`${packPartKey(p.id, '')}%`).n
      : db.prepare('SELECT COUNT(*) n FROM media WHERE parent_key=?').get(packRatingKey(p.id)).n;
    return {
      id: p.id, name: p.name, kind: p.kind, description: p.description,
      itemCount: p.itemCount, runtimeMs: p.runtimeMs, downloadBytes: p.downloadBytes,
      installed: installed.has(p.id) || prog?.state === 'installed',
      installedItemCount,
      origin: installed.get(p.id)?.origin ?? null,
      hasChannel: packChannels.has(packRatingKey(p.id)),
      progress: prog ? { state: prog.state, done: prog.done, total: prog.total, error: prog.error } : null,
    };
  });
}

/**
 * Start downloading + installing a catalogued pack (D4: IA derivatives direct,
 * no re-encode). Returns immediately with progress; the download runs in the
 * background and the web UI polls GET /api/packs. Idempotent while in flight.
 */
export function startInstall(packId) {
  const entry = loadCatalog().packs.find((p) => p.id === packId);
  if (!entry) throw new Error(`unknown pack: ${packId}`);
  const existing = installProgress.get(packId);
  if (existing && existing.state === 'downloading') return existing;

  const dir = path.join(downloadedPacksDir(), packId);
  fs.mkdirSync(dir, { recursive: true });
  const prog = { state: 'downloading', done: 0, total: entry.items.length, error: null };
  installProgress.set(packId, prog);

  (async () => {
    try {
      for (const it of entry.items) {
        const dest = path.join(dir, it.file);
        if (!fs.existsSync(dest)) await downloadTo(it.url, dest);
        prog.done++;
      }
      // Write the runtime manifest, then register — same shape build-pack emits.
      const packJson = {
        id: entry.id, name: entry.name, version: 1, kind: entry.kind, channel: entry.channel,
        items: entry.items.map((it) => ({
          id: it.id, file: it.file, title: it.title, show: it.show, season: it.season,
          episode: it.episode, aired: it.aired, durationMs: it.durationMs, license: it.license,
        })),
      };
      fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify(packJson, null, 2));
      installPack(dir, { origin: 'downloaded' });
      prog.state = 'installed';
    } catch (e) {
      prog.state = 'error';
      prog.error = e.message;
    }
  })();

  return prog;
}
