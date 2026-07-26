#!/usr/bin/env node
// build-pack.js — the Content-Without-Plex pack pipeline (Track I, P0).
//
// A "pack" is a curated, versioned folder of public-domain media + a runtime
// manifest. This tool turns a hand-authored SOURCE manifest (packs/<id>/
// manifest.json — a source per item + per-item PD provenance) into a built pack:
// uniform 480p h.264/AAC MP4s + packs/<id>/dist/pack.json carrying durations,
// sizes, and checksums. The built dist/ is a git-ignored artifact.
//
// An item's source is either an Internet Archive identifier or a direct URL:
//   "source": { "iaIdentifier": "bb_minnie_the_moocher" }
//   "source": { "url": "https://images-assets.nasa.gov/…mp4", "durationMs": 1470000 }
// The direct form (S1a) is what lets the SPACE pack pull from images.nasa.gov,
// which has no API key and no IA identifiers. An optional `downloadUrl` lets the
// CATALOG advertise a smaller derivative than the master we re-encode from — a
// 3-hour pack of NASA originals is 9 GB, and nobody one-taps that.
//
// Re-encoding PD content is fine: invariant #2 (never transcode) is about
// RUNTIME playback, not mastering. We normalise once, offline, so every device
// direct-plays the result — including the browser <video> tag on the config UI.
//
// No npm dependencies: global fetch (Node 18+) + ffmpeg/ffprobe.
//
// Usage:
//   node scripts/build-pack.js list <ia-identifier>     # discover video files to author a manifest
//   node scripts/build-pack.js build <packId> [opts]    # build packs/<packId>/
//   node scripts/build-pack.js verify <packId>          # provenance check only, no encode
//
// build opts:
//   --only <itemId>       build a single item (fast iteration)
//   --sample <seconds>    encode only the first N seconds (pipeline smoke test)
//   --allow-unverified    skip the PD-provenance gate (dev only — never ship)
//   --force               re-download/re-encode even if the output exists

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKS_DIR = path.join(ROOT, 'packs');

// ── Internet Archive ────────────────────────────────────────────────────────

const IA_META = (id) => `https://archive.org/metadata/${encodeURIComponent(id)}`;
const IA_DOWNLOAD = (id, file) =>
  `https://archive.org/download/${encodeURIComponent(id)}/${encodeURIComponent(file)}`;

// Formats that are actual playable video (skip thumbs, torrents, metadata, srt).
const VIDEO_FORMAT_RE = /mpeg4|h\.?264|mp4|mpeg2?|ogg video|matroska|quicktime|divx|avi|webm/i;
// Preference order when an item has several derivatives — smallest sensible
// h.264 first (retro-correct + web-friendly), original last.
function derivativeScore(f) {
  const fmt = (f.format || '').toLowerCase();
  if (/512kb mpeg4|h\.?264 ia|mp4/.test(fmt)) return 0;
  if (/mpeg4/.test(fmt)) return 1;
  if (/ogg video|webm|matroska/.test(fmt)) return 2;
  return 3; // mpeg2 original, etc.
}

async function iaMetadata(identifier) {
  const res = await fetch(IA_META(identifier), { headers: { 'User-Agent': 'dumbTV-pack-builder' } });
  if (!res.ok) throw new Error(`IA metadata ${identifier}: HTTP ${res.status}`);
  const json = await res.json();
  if (!json || !Array.isArray(json.files)) throw new Error(`IA metadata ${identifier}: no files[]`);
  return json;
}

function videoFiles(meta) {
  return meta.files
    .filter((f) => VIDEO_FORMAT_RE.test(f.format || '') && f.name && !/\.(srt|vtt|xml|txt|torrent)$/i.test(f.name))
    .map((f) => ({
      name: f.name,
      format: f.format,
      lengthSec: f.length ? parseFloat(f.length) : null,
      bytes: f.size ? parseInt(f.size, 10) : null,
    }));
}

// For on-device install (D4: IA derivatives direct, no re-encode), pick the
// SMALLEST MP4/h264 derivative — .ogv/.mpeg won't direct-play on iOS. A named
// iaFile still wins if present.
function downloadFile(meta, item) {
  const vids = videoFiles(meta);
  if (item.source?.iaFile) {
    const exact = vids.find((v) => v.name === item.source.iaFile);
    if (exact) return exact;
  }
  const mp4s = vids.filter((v) => /\.mp4$/i.test(v.name) && /mp4|h\.?264|mpeg4/i.test(v.format || ''));
  const pool = mp4s.length ? mp4s : vids;
  return pool.slice().sort((a, b) => (a.bytes ?? Infinity) - (b.bytes ?? Infinity))[0];
}

// Resolve which file to download for an item. If the manifest names an exact
// iaFile, use it; otherwise pick the best derivative by score.
function resolveSourceFile(meta, item) {
  const vids = videoFiles(meta);
  if (item.source?.iaFile) {
    const exact = vids.find((v) => v.name === item.source.iaFile);
    if (!exact) throw new Error(`item ${item.id}: iaFile "${item.source.iaFile}" not found in ${item.source.iaIdentifier}`);
    return exact;
  }
  if (!vids.length) throw new Error(`item ${item.id}: no video files in ${item.source.iaIdentifier}`);
  return [...vids].sort((a, b) => derivativeScore(a) - derivativeScore(b))[0];
}

// ── direct URL sources (S1a) ─────────────────────────────────────────────────
//
// The builder was Internet-Archive-only. NASA publishes its own video library at
// images.nasa.gov (no API key, and NASA material is generally not subject to US
// copyright), and that is the primary source for the SPACE channel — so an item
// may name a plain URL instead of an IA identifier:
//
//   "source": { "url": "https://images-assets.nasa.gov/video/…~orig.mp4",
//               "durationMs": 1470000 }
//
// Everything downstream is unchanged: it still downloads, re-encodes to uniform
// 480p, ffprobes the real duration, and hashes the result. `durationMs` is only
// a hint for `catalog`, which reports sizes without encoding anything.
const isDirect = (item) => !!item.source?.url;

/** Content-Length for a URL, or null. Used by `catalog` — no body is fetched. */
async function remoteBytes(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': 'dumbTV-pack-builder' } });
    const n = parseInt(res.headers.get('content-length') || '', 10);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

/**
 * What the download catalog should point at. Building re-encodes from the best
 * master we can get (`url`), but an on-device one-tap install pulls the source
 * file as-is (D4) — so a pack may name a smaller derivative for that. NASA's
 * `~mobile` renditions are ~1/30th the size of `~orig` and already look like the
 * 480p we'd have made anyway.
 */
const catalogURL = (item) => item.source.downloadUrl ?? item.source.url;

/** A filesystem-safe local name for a direct-URL download. */
function directSrcName(item) {
  const tail = decodeURIComponent(item.source.url.split('/').pop() || `${item.id}.mp4`);
  return `${item.id}--${tail}`.replace(/[^\w.-]/g, '_');
}

// ── media helpers ────────────────────────────────────────────────────────────

async function downloadTo(url, dest) {
  const res = await fetch(url, { headers: { 'User-Agent': 'dumbTV-pack-builder' } });
  if (!res.ok || !res.body) throw new Error(`download ${url}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
}

async function probeDurationMs(file) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', file,
  ]);
  const secs = parseFloat(stdout.trim());
  return Number.isFinite(secs) ? Math.round(secs * 1000) : null;
}

// Re-encode to a uniform 480p h.264/AAC MP4 with faststart (seekable, web-safe).
function encode(input, output, enc, sampleSec) {
  const height = enc?.height ?? 480;
  const crf = String(enc?.crf ?? 23);
  const preset = enc?.preset ?? 'medium';
  const abitrate = enc?.abitrate ?? '128k';
  const args = [
    '-hide_banner', '-y', '-i', input,
    ...(sampleSec ? ['-t', String(sampleSec)] : []),
    '-vf', `scale=-2:${height}`,
    '-c:v', 'libx264', '-crf', crf, '-preset', preset, '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', abitrate, '-ac', '2',
    '-movflags', '+faststart',
    output,
  ];
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'inherit'] });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
  });
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

// ── manifest ─────────────────────────────────────────────────────────────────

function loadManifest(packId) {
  const file = path.join(PACKS_DIR, packId, 'manifest.json');
  if (!fs.existsSync(file)) throw new Error(`no manifest: ${file}`);
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (m.id !== packId) throw new Error(`manifest id "${m.id}" != folder "${packId}"`);
  if (!Array.isArray(m.items) || !m.items.length) throw new Error(`pack ${packId}: no items`);
  const sourceless = m.items.filter((i) => !i.source?.iaIdentifier && !i.source?.url);
  if (sourceless.length) {
    throw new Error(
      `pack ${packId}: ${sourceless.length} item(s) have no source.iaIdentifier and no source.url:\n` +
      sourceless.map((i) => `  - ${i.id}`).join('\n'),
    );
  }
  return m;
}

// The provenance gate: every item must record a human-verified PD determination.
// This is what stands between us and the "March of the Wooden Soldiers" trap.
function checkProvenance(manifest) {
  const bad = manifest.items.filter((i) => !i.license || !i.license.verified);
  if (bad.length) {
    throw new Error(
      `provenance gate: ${bad.length}/${manifest.items.length} item(s) lack license.verified:\n` +
      bad.map((i) => `  - ${i.id} (${i.title || '?'})`).join('\n') +
      `\nEach item needs license.verified = "<date>" after a real PD/renewal check.`,
    );
  }
}

// ── commands ─────────────────────────────────────────────────────────────────

async function cmdList(identifier) {
  const meta = await iaMetadata(identifier);
  const vids = videoFiles(meta).sort((a, b) => derivativeScore(a) - derivativeScore(b));
  console.log(`\n${identifier} — ${vids.length} video file(s):\n`);
  for (const v of vids) {
    const mins = v.lengthSec ? `${(v.lengthSec / 60).toFixed(1)}m` : '?';
    const mb = v.bytes ? `${(v.bytes / 1e6).toFixed(0)}MB` : '?';
    console.log(`  [${derivativeScore(v)}] ${v.format.padEnd(14)} ${mins.padStart(6)} ${mb.padStart(7)}  ${v.name}`);
  }
  console.log('\nAuthor manifest items with source.iaFile = the exact name above (score 0 preferred).\n');
}

async function cmdVerify(packId) {
  const m = loadManifest(packId);
  checkProvenance(m);
  console.log(`✓ ${packId}: ${m.items.length} item(s), all PD-verified.`);
}

// Generate packs/index.json — the download catalog the web-UI pack picker reads
// (served at dumbtv.app/packs/index.json + bundled as a fallback). Each item
// carries the IA download URL, a sanitized local filename, duration (from IA
// metadata — no probing), size, and PD provenance. No media is downloaded here.
async function cmdCatalog() {
  const ids = fs.readdirSync(PACKS_DIR).filter((d) =>
    fs.existsSync(path.join(PACKS_DIR, d, 'manifest.json')));
  const packs = [];
  for (const id of ids) {
    const m = loadManifest(id);
    checkProvenance(m); // only ship PD-verified packs in the catalog
    const items = [];
    for (const it of m.items) {
      let url, bytes, durationMs;
      if (isDirect(it)) {
        // No metadata service to ask: the size comes from a HEAD, and the
        // duration from the manifest's hint (the built pack.json carries the
        // real probed value — this catalog is only for sizing a download).
        url = catalogURL(it);
        bytes = await remoteBytes(url);
        durationMs = it.source.durationMs ?? 0;
      } else {
        const meta = await iaMetadata(it.source.iaIdentifier);
        const f = downloadFile(meta, it);
        url = IA_DOWNLOAD(it.source.iaIdentifier, f.name);
        bytes = f.bytes ?? null;
        durationMs = Math.round((f.lengthSec ?? 0) * 1000);
      }
      items.push({
        id: it.id, title: it.title, show: it.show ?? null, season: it.season ?? null,
        episode: it.episode ?? null, aired: it.aired ?? null,
        durationMs,
        file: `${it.id}.mp4`,
        url,
        bytes,
        license: it.license,
      });
      process.stdout.write('.');
    }
    packs.push({
      id: m.id, name: m.name, kind: m.kind ?? 'shows', description: m.description ?? '',
      channel: m.channel ?? null, itemCount: items.length,
      runtimeMs: items.reduce((n, i) => n + i.durationMs, 0),
      downloadBytes: items.reduce((n, i) => n + (i.bytes ?? 0), 0),
      items,
    });
  }
  const catalog = { version: 1, packs };  // (generatedAt omitted — keeps the file diff-stable)
  fs.writeFileSync(path.join(PACKS_DIR, 'index.json'), JSON.stringify(catalog, null, 2));
  console.log(`\nwrote packs/index.json: ${packs.length} pack(s)`);
  for (const p of packs) {
    console.log(`  ${p.id.padEnd(18)} ${String(p.itemCount).padStart(2)} items  ` +
      `${String(Math.round(p.runtimeMs / 60000)).padStart(3)}m  ${(p.downloadBytes / 1e6).toFixed(0)}MB  [${p.kind}]`);
  }
}

async function cmdBuild(packId, opts) {
  const manifest = loadManifest(packId);
  if (!opts.allowUnverified) checkProvenance(manifest);
  else console.warn('⚠️  --allow-unverified: provenance gate SKIPPED (dev only).');

  const distDir = path.join(PACKS_DIR, packId, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  const tmpDir = path.join(distDir, '.src');
  fs.mkdirSync(tmpDir, { recursive: true });

  const items = opts.only ? manifest.items.filter((i) => i.id === opts.only) : manifest.items;
  if (opts.only && !items.length) throw new Error(`--only ${opts.only}: no such item`);

  const built = [];
  for (const [i, item] of items.entries()) {
    const outName = `${String(i + 1).padStart(2, '0')}-${item.id}.mp4`;
    const outFile = path.join(distDir, outName);
    console.log(`\n[${i + 1}/${items.length}] ${item.title || item.id}`);

    if (!opts.force && fs.existsSync(outFile) && !opts.sample) {
      console.log('  ↳ exists, skipping (use --force to rebuild)');
    } else {
      let srcPath, srcURL, label;
      if (isDirect(item)) {
        srcPath = path.join(tmpDir, directSrcName(item));
        srcURL = item.source.url;
        label = `direct — ${decodeURIComponent(srcURL.split('/').pop() || '')}`;
      } else {
        const meta = await iaMetadata(item.source.iaIdentifier);
        const src = resolveSourceFile(meta, item);
        srcPath = path.join(tmpDir, src.name.replace(/[^\w.-]/g, '_'));
        srcURL = IA_DOWNLOAD(item.source.iaIdentifier, src.name);
        label = `${src.format} — ${src.name}`;
      }
      console.log(`  ↓ ${label}`);
      if (opts.force || !fs.existsSync(srcPath)) await downloadTo(srcURL, srcPath);
      console.log(`  ⚙ encoding → ${outName}${opts.sample ? ` (first ${opts.sample}s)` : ''}`);
      await encode(srcPath, outFile, manifest.encode, opts.sample);
    }

    const durationMs = await probeDurationMs(outFile);
    const bytes = fs.statSync(outFile).size;
    const hash = await sha256(outFile);
    built.push({
      id: item.id,
      file: outName,
      title: item.title,
      show: item.show ?? null,
      season: item.season ?? null,
      episode: item.episode ?? null,
      aired: item.aired ?? null,
      durationMs,
      bytes,
      sha256: hash,
      license: item.license,
    });
    console.log(`  ✓ ${(durationMs / 1000 / 60).toFixed(1)}m, ${(bytes / 1e6).toFixed(1)}MB`);
  }

  // Runtime manifest — this is what the engines (P1) consume at install time.
  const pack = {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version ?? 1,
    kind: manifest.kind ?? 'shows',
    channel: manifest.channel ?? null,
    items: built,
    bytes: built.reduce((n, b) => n + b.bytes, 0),
    builtAt: new Date().toISOString(),
    partial: !!(opts.only || opts.sample),
  };
  const packJson = path.join(distDir, 'pack.json');
  fs.writeFileSync(packJson, JSON.stringify(pack, null, 2));
  console.log(
    `\n✓ ${packId}: ${built.length} item(s), ${(pack.bytes / 1e6).toFixed(0)}MB total → ${path.relative(ROOT, packJson)}` +
    (pack.partial ? '  (PARTIAL build)' : ''),
  );
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseOpts(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--only') o.only = argv[++i];
    else if (a === '--sample') o.sample = parseInt(argv[++i], 10);
    else if (a === '--allow-unverified') o.allowUnverified = true;
    else if (a === '--force') o.force = true;
  }
  return o;
}

const [cmd, arg, ...rest] = process.argv.slice(2);
try {
  if (cmd === 'list' && arg) await cmdList(arg);
  else if (cmd === 'verify' && arg) await cmdVerify(arg);
  else if (cmd === 'catalog') await cmdCatalog();
  else if (cmd === 'build' && arg) await cmdBuild(arg, parseOpts(rest));
  else {
    console.log('Usage:\n  build-pack.js list <ia-identifier>\n  build-pack.js verify <packId>\n  build-pack.js catalog\n  build-pack.js build <packId> [--only id] [--sample sec] [--allow-unverified] [--force]');
    process.exit(1);
  }
} catch (e) {
  console.error(`\n✗ ${e.message}`);
  process.exit(1);
}
