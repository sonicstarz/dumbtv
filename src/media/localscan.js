// localscan.js — "bring your own files" (Track I, P5). Point dumbTV at a folder
// of video files and it becomes schedulable content, no Plex. Files are grouped
// under a stable folder key (folder:<hash-of-path>) and play through the same
// direct-play local: path the demo already uses. Filenames are parsed for
// show/episode with NO network metadata lookups (see filename.js).

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { db } from '../db.js';
import { parseFilename } from './filename.js';

const execFileAsync = promisify(execFile);
const VIDEO_EXT = new Set(['.mp4', '.mkv', '.avi', '.mov', '.m4v', '.webm', '.mpg', '.mpeg', '.ogv']);

// FNV-1a → 8 hex chars. Stable across runs (unlike autoincrement), so a rescan
// of the same file yields the same rating_key — the guide/shuffle stay put (#5).
function fnv(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

export const localFolderId = (dir) => `folder:${fnv(path.resolve(dir))}`;

async function probeMs(file) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', file]);
    const s = parseFloat(stdout.trim());
    return Number.isFinite(s) ? Math.round(s * 1000) : null;
  } catch { return null; }
}

function walk(dir) {
  const out = [];
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (VIDEO_EXT.has(path.extname(e.name).toLowerCase())) out.push(p);
  }
  return out.sort();
}

const upsertMedia = db.prepare(`
  INSERT INTO media (rating_key, parent_key, kind, title, show_title, season_no,
                     episode_no, aired, duration_ms, part_key, updated_at)
  VALUES (@ratingKey,@parentKey,@kind,@title,@showTitle,@seasonNo,@episodeNo,@aired,@durationMs,@partKey,@updatedAt)
  ON CONFLICT(rating_key) DO UPDATE SET
    parent_key=excluded.parent_key, kind=excluded.kind, title=excluded.title,
    show_title=excluded.show_title, season_no=excluded.season_no, episode_no=excluded.episode_no,
    aired=excluded.aired, duration_ms=excluded.duration_ms, part_key=excluded.part_key,
    updated_at=excluded.updated_at`);

/**
 * Scan (or re-scan) a folder into the library. Files that won't probe (exotic
 * containers) are skipped + counted, never fatal. Files that vanished since the
 * last scan are dropped (matching the "vanished file → exclude" rule). Returns
 * counts; call createChannelFromLocalFolder to put it on the air.
 */
export async function scanLocalFolder(dir) {
  const root = path.resolve(dir);
  if (!fs.existsSync(root)) throw new Error(`no such folder: ${root}`);
  const parent = localFolderId(root);
  const folderName = path.basename(root);
  const files = walk(root);

  const rows = [];
  for (const f of files) {
    const ms = await probeMs(f);
    if (!ms) continue; // unreadable / exotic → skip
    const rel = path.relative(root, f);
    const showFolder = path.dirname(f) === root ? folderName : path.basename(path.dirname(f));
    const meta = parseFilename(path.basename(f), showFolder);
    rows.push({
      ratingKey: `${parent}:${fnv(rel)}`, parentKey: parent, kind: meta.kind,
      title: meta.title, showTitle: meta.showTitle, seasonNo: meta.seasonNo, episodeNo: meta.episodeNo,
      aired: meta.year ? `${meta.year}-01-01` : null, durationMs: ms, partKey: `local:${f}`, updatedAt: Date.now(),
    });
  }

  const seen = new Set(rows.map((r) => r.ratingKey));
  db.transaction(() => {
    for (const r of rows) upsertMedia.run(r);
    const existing = db.prepare('SELECT rating_key FROM media WHERE parent_key = ?').all(parent).map((x) => x.rating_key);
    const del = db.prepare('DELETE FROM media WHERE rating_key = ?');
    for (const rk of existing) if (!seen.has(rk)) del.run(rk); // vanished files
  })();

  return { folderId: parent, name: folderName, path: root, added: rows.length, skipped: files.length - rows.length };
}

/** What a scan WOULD produce — the parse preview shown before you commit. */
export async function previewLocalFolder(dir) {
  const root = path.resolve(dir);
  const folderName = path.basename(root);
  const items = [];
  for (const f of walk(root)) {
    const showFolder = path.dirname(f) === root ? folderName : path.basename(path.dirname(f));
    const meta = parseFilename(path.basename(f), showFolder);
    items.push({ file: path.relative(root, f), ...meta });
  }
  return { name: folderName, path: root, items };
}

export function createChannelFromLocalFolder(folderId, name, opts = {}) {
  const maxNo = db.prepare('SELECT MAX(number) m FROM channels').get().m || 1;
  const seed = parseInt(fnv(folderId), 16) & 0x7fffffff; // deterministic per folder
  let number = opts.number ?? maxNo + 1;                  // N3: next-free if taken
  if (db.prepare('SELECT 1 FROM channels WHERE number=?').get(number)) number = maxNo + 1;
  const info = db.prepare(`
    INSERT INTO channels (number, name, slot_minutes, ordering_mode, marathon_size, shuffle_seed,
                          dark_start, dark_end, ads_enabled, max_ads_per_break, ad_tags, enabled, created_at)
    VALUES (?,?,30,?,3,?,NULL,NULL,?,10,'',1,?)`
  ).run(number, name || 'Local', opts.ordering || 'sequential', seed,
        opts.adsEnabled === true ? 1 : 0, Date.now()); // user channels: ads OFF by default (D2)
  db.prepare('INSERT OR IGNORE INTO channel_sources (channel_id, rating_key, source_type, title) VALUES (?,?,?,?)')
    .run(info.lastInsertRowid, folderId, 'local', name || 'Local');
  return { channelId: info.lastInsertRowid };
}
