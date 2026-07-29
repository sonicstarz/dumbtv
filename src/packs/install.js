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
import { db, getSetting, setSetting } from '../db.js';
import { config } from '../config.js';
import { assertSafePackFile } from './safe-file.js';
import { hashString } from '../util/rng.js';
import { regenerateChannel } from '../schedule/generator.js';

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
    // A hand-placed pack directory is the same hazard as a downloaded one:
    // resolvePackPath joins this onto root_path, so it must not escape it.
    assertSafePackFile(it.file, `pack ${p.id}/item ${it.id}`);
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
        dark_start, dark_end, ads_enabled, max_ads_per_break, ad_tags, enabled, locked, created_at)
     VALUES (?,?,30,?,3,?,NULL,NULL,?,10,'',1,?,?)`
  ).run(
    number, ch.name, ch.ordering,
    // A manifest may pin a seed; otherwise derive it from the pack id so the
    // same pack installed on two devices plays in the same order (invariant #5
    // across boxes, and the thing that makes "clone my lineup" truthful).
    ch.seed ?? (hashString(`pack:${packId}`) & 0x7fffffff),
    overrides.adsEnabled === false ? 0 : 1,
    // S3: a pack whose manifest declares `channel.system` creates a LOCKED
    // channel — SPACE at 1 is the first. Hideable, not editable.
    ch.system ? 1 : 0,
    Date.now(),
  );
  db.prepare('INSERT OR IGNORE INTO channel_sources (channel_id, rating_key, source_type, title) VALUES (?,?,?,?)')
    .run(info.lastInsertRowid, packRatingKey(packId), 'pack', pack.name);
  return { channelId: info.lastInsertRowid };
});

/**
 * One-time repair for installs seeded before build 13, when pack channels were
 * created with ads ON: turn ads off on every channel whose ONLY source is a
 * pack, then rebuild its future. A channel the user added their own sources to
 * is left alone.
 *
 * Safe against invariant #4 — `regenerateChannel` deletes only
 * `start_utc >= now`, so whatever is airing right now finishes as scheduled.
 * Returns the channel ids it changed.
 */
export function migratePreloadAdsOff() {
  if (getSetting('preload_ads_off', null)) return [];
  setSetting('preload_ads_off', '1');
  const changed = [];
  const channels = db.prepare('SELECT id FROM channels WHERE ads_enabled = 1').all();
  for (const { id } of channels) {
    const srcs = db.prepare('SELECT source_type FROM channel_sources WHERE channel_id = ?').all(id);
    if (!srcs.length || !srcs.every((s) => s.source_type === 'pack')) continue;
    db.prepare('UPDATE channels SET ads_enabled = 0 WHERE id = ?').run(id);
    regenerateChannel(id);
    changed.push(id);
  }
  return changed;
}

function channelHints(rootPath) {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(rootPath, 'pack.json'), 'utf8'));
    return p.channel || {};
  } catch { return {}; }
}

/**
 * Drop registrations for packs whose files are gone — the vanished-file rule,
 * applied to packs.
 *
 * The case this exists for: a pack that shipped bundled in one release and is
 * removed from the next (POPEYE went preload → download-only when its rights
 * basis needed re-checking). Its row survives pointing at a path that no longer
 * exists, so the picker reports it "installed" with no Download button —
 * unrecoverable — while its channel resolves every part key to a missing file.
 *
 * Dropping the registration keeps the channel: it stands by with the existing
 * "No content selected" card (invariant #7), the picker offers the download
 * again, and re-installing restores it EXACTLY — same pack id, same rating
 * keys, same deterministic schedule (invariant #5). Returns the ids dropped.
 */
export function reconcileMissingPacks() {
  const dropped = [];
  for (const p of listPacks()) {
    if (fs.existsSync(path.join(p.root_path, 'pack.json'))) continue;
    uninstallPack(p.id);
    dropped.push(p.id);
  }
  return dropped;
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

// A download is a remote party writing to our disk, so it gets a clock and a
// ceiling. Without them a hostile or simply mis-authored catalog entry can hang
// the install forever or fill the disk (S-9).
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;   // generous for ~300 MB on a slow line
const MIN_SIZE_CAP = 50 * 1024 * 1024;        // floor, for entries declaring nothing
const SIZE_CAP_HEADROOM = 1.5;                // IA derivatives vary from the declared size
const FLAT_SIZE_CAP = 4 * 1024 * 1024 * 1024; // absolute ceiling when size is unknown

/** How many bytes we're willing to accept for an item that declares `bytes`. */
const sizeCapFor = (declaredBytes) =>
  Number.isFinite(declaredBytes) && declaredBytes > 0
    ? Math.max(MIN_SIZE_CAP, Math.round(declaredBytes * SIZE_CAP_HEADROOM))
    : FLAT_SIZE_CAP;

async function downloadTo(url, dest, onBytes, { capBytes = FLAT_SIZE_CAP } = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'dumbTV' },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);

  // Refuse before reading a byte when the server is honest about the size.
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > capBytes) {
    throw new Error(`download too large: ${declared} bytes exceeds the ${capBytes}-byte cap`);
  }

  const rs = Readable.fromWeb(res.body);
  let written = 0;
  rs.on('data', (chunk) => {
    written += chunk.length;
    if (onBytes) onBytes(chunk.length);          // C4: byte progress
    // A server that lies about (or omits) content-length is stopped mid-stream.
    if (written > capBytes) {
      rs.destroy(new Error(`download too large: exceeded the ${capBytes}-byte cap`));
    }
  });
  await pipeline(rs, fs.createWriteStream(dest));
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
      progress: prog ? {
        state: prog.state, done: prog.done, total: prog.total, error: prog.error,
        bytesDone: prog.bytesDone ?? 0, bytesTotal: prog.bytesTotal ?? 0, startedAt: prog.startedAt ?? 0,
      } : null,
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
  const prog = {
    state: 'downloading', done: 0, total: entry.items.length, error: null,
    bytesDone: 0, bytesTotal: entry.downloadBytes ?? 0, startedAt: Date.now(),   // C4
  };
  installProgress.set(packId, prog);

  (async () => {
    try {
      for (const it of entry.items) {
        // S-1: the catalog is remote, so its file names are not ours to trust.
        // Validate BEFORE joining — path.join('../..') escapes the pack dir.
        assertSafePackFile(it.file, `pack ${entry.id}/item ${it.id}`);
        const dest = path.join(dir, it.file);
        // N1: accept an existing file ONLY if it's the expected size — a
        // truncated/partial download must be re-fetched, not treated as done.
        const complete = fs.existsSync(dest)
          && (!it.bytes || Math.abs(fs.statSync(dest).size - it.bytes) < 65536);
        if (complete) {
          prog.bytesDone += fs.statSync(dest).size;
        } else {
          // Download to a .part file and rename on success, so an interrupted
          // download never leaves a poisoned "complete" file (N1).
          const part = `${dest}.part`;
          try {
            await downloadTo(it.url, part, (n) => { prog.bytesDone += n; },
                             { capBytes: sizeCapFor(it.bytes) });
          } catch (e) {
            // Don't leave litter behind an aborted or capped download (S-9).
            fs.rmSync(part, { force: true });
            throw e;
          }
          fs.renameSync(part, dest);
        }
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
    } finally {
      // The picker polls for a while after an install settles, then stops
      // caring. Holding every finished entry forever is a slow leak in a
      // process that runs for months on a Pi (E-4).
      setTimeout(() => {
        const cur = installProgress.get(packId);
        if (cur && cur.state !== 'downloading') installProgress.delete(packId);
      }, 5 * 60 * 1000).unref?.();
    }
  })();

  return prog;
}
