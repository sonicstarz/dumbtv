import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { db, getSetting } from './db.js';
import { config } from './config.js';

const execFileAsync = promisify(execFile);

const VIDEO_EXT = new Set([
  '.mp4', '.mkv', '.avi', '.mov', '.m4v', '.webm', '.mpg', '.mpeg', '.wmv', '.flv',
]);

/** Folder name decides what a file is, so importing is just drag and drop. */
const KIND_BY_DIR = {
  ads: 'ad',
  commercials: 'ad',
  bumpers: 'bumper',
  ids: 'bumper',
  bumps: 'bumper',
};

async function probeDuration(file) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      file,
    ]);
    const secs = parseFloat(stdout.trim());
    return Number.isFinite(secs) ? Math.round(secs * 1000) : null;
  } catch {
    return null;
  }
}

/**
 * Measure how far a clip's loudness sits from the target, in dB, using ffmpeg
 * loudnorm's analysis pass. Vintage ad rips are wildly hotter than show audio;
 * storing this gain lets playback pull them down so kids don't get blasted at 2am.
 * Returns the dB gain to apply (negative = quieter), or null if it can't measure.
 */
export async function measureGain(input, target = -23) {
  try {
    const { stderr } = await execFileAsync(
      'ffmpeg',
      ['-nostats', '-hide_banner', '-i', input, '-af', `loudnorm=I=${target}:print_format=json`, '-f', 'null', '-'],
      { maxBuffer: 8 * 1024 * 1024, timeout: 45000 }
    );
    const m = stderr.match(/\{[\s\S]*?"input_i"[\s\S]*?\}/);
    if (!m) return null;
    const inputI = parseFloat(JSON.parse(m[0]).input_i);
    if (!Number.isFinite(inputI) || inputI <= -70) return null; // silence / no reading
    return Math.round((target - inputI) * 10) / 10;
  } catch {
    return null;
  }
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (VIDEO_EXT.has(path.extname(e.name).toLowerCase())) out.push(full);
  }
  return out;
}

/**
 * Scan the media folder for ads and bumpers.
 * Durations come from ffprobe because a wrong duration makes the schedule
 * drift, and drift is what makes it stop feeling like television.
 */
export async function scanAssets() {
  const root = config.mediaDir;
  fs.mkdirSync(path.join(root, 'ads'), { recursive: true });
  fs.mkdirSync(path.join(root, 'bumpers'), { recursive: true });

  // Only the folders that are meant to hold commercials get scanned. Sweeping
  // the whole media tree would turn anything else living there into an ad.
  const files = Object.keys(KIND_BY_DIR).flatMap((dir) => walk(path.join(root, dir)));
  const existing = new Set(
    db.prepare('SELECT path FROM assets').all().map((r) => r.path)
  );

  const insert = db.prepare(
    `INSERT OR IGNORE INTO assets (path, title, kind, duration_ms, tags, gain_db)
     VALUES (?,?,?,?,?,?)`
  );
  const target = getSetting('loudness_target', -23);

  let added = 0;
  let skipped = 0;
  const problems = [];

  for (const file of files) {
    if (existing.has(file)) continue;

    const rel = path.relative(root, file);
    const parts = rel.split(path.sep);
    const kind = KIND_BY_DIR[parts[0]] || 'ad';

    // Sub-folders become tags: media/ads/90s/toys/foo.mp4 -> "90s,toys"
    const tags = parts.slice(1, -1).join(',').toLowerCase();

    const duration = await probeDuration(file);
    if (!duration || duration < 500) {
      skipped++;
      problems.push({ file: rel, reason: 'Could not read a duration' });
      continue;
    }

    const title = path
      .basename(file, path.extname(file))
      .replace(/[._-]+/g, ' ')
      .trim();

    const gain = await measureGain(file, target);
    insert.run(file, title, kind, duration, tags, gain);
    added++;
  }

  const removed = [];
  for (const p of existing) {
    // Plex-sourced ads live under a `plex:` key with no file on disk — the
    // local scan must never sweep them away.
    if (p.startsWith('plex:')) continue;
    if (!fs.existsSync(p)) {
      db.prepare('DELETE FROM assets WHERE path = ?').run(p);
      removed.push(p);
    }
  }

  const total = db.prepare('SELECT COUNT(*) n FROM assets').get().n;
  return { added, skipped, removed: removed.length, total, problems };
}
