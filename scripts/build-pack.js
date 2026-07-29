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
import { assertSafePackFile } from '../src/packs/safe-file.js';

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
  // Retry before concluding anything: IA rate-limits and hiccups, and a
  // transient failure must not be mistaken for a takedown (the catalog
  // excludes "dark" items, so a false dark silently prunes real content).
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, attempt * 4000));
    try {
      const res = await fetch(IA_META(identifier), { headers: { 'User-Agent': 'dumbTV-pack-builder' } });
      if (!res.ok) throw new Error(`IA metadata ${identifier}: HTTP ${res.status}`);
      const json = await res.json();
      if (!json || !Array.isArray(json.files)) throw new Error(`IA metadata ${identifier}: no files[]`);
      return json;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
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
  // The catalog derives each item's on-disk name from its id (`<id>.mp4`), and
  // installers join that onto the pack directory — so an id carrying a path
  // separator is a traversal waiting to be published. Same rule as the runtime.
  for (const i of m.items) assertSafePackFile(`${i.id}.mp4`, `pack ${packId}/item ${i.id}`);
  return m;
}

// ── the rights schema (v2) ───────────────────────────────────────────────────
//
// v1 recorded provenance as free prose: license.verified plus a paragraph. That
// cannot be audited, filtered, or reasoned about — "public-domain" covered both
// a US Army film with no copyright to check and a 1942 Warner short needing a
// Catalog of Copyright Entries lookup, at wildly different confidence.
//
// v2 makes three things machine-readable: what the claim RESTS ON, whether the
// MUSIC is separately encumbered (a cleanly-PD TV episode can still carry an
// uncleared theme), and what a viewer should be WARNED about — legally clear is
// not the same as airable, and a kids' channel needs to know the difference.

/** What a public-domain claim rests on, and what verifying it costs. */
const RIGHTS_BASIS = {
  GOV: 'US federal government work (17 USC §105) — never had copyright. Confirm the producing agency is genuinely federal.',
  AGE: 'Published 1930 or earlier — confirm the release date. Deterministic.',
  NR:  'Copyright not renewed — REQUIRES a Catalog of Copyright Entries lookup, recorded in license.verifiedBy.',
  CC:  'Openly licensed, not public domain.',
};

/** Closed on purpose: an open vocabulary cannot be filtered against. */
const CONTENT_WARNINGS = new Set([
  'racial-caricature', 'wartime-propaganda', 'smoking', 'graphic-violence', 'adult-humor',
]);

const MUSIC_RIGHTS = new Set(['cleared', 'unverified', 'encumbered']);

/**
 * The provenance gate. Every item must record a human-verified determination
 * that can be audited later — this is what stands between us and the "March of
 * the Wooden Soldiers" trap, where a missing notice on a reissue print made a
 * fully-copyrighted film look public domain for decades.
 */
function checkProvenance(manifest) {
  const errs = [];
  const label = (i) => `${i.id} (${i.title || '?'})`;

  for (const i of manifest.items) {
    const lic = i.license || {};

    // 1 · a claim needs a basis, a note, and a date. All three, always.
    if (!lic.verified) errs.push(`${label(i)}: no license.verified — needs a date after a real PD/renewal check`);
    if (!lic.note)     errs.push(`${label(i)}: no license.note — record WHY this is public domain`);
    if (!lic.basis) {
      errs.push(`${label(i)}: no license.basis — one of ${Object.keys(RIGHTS_BASIS).join(' | ')}`);
    } else if (!RIGHTS_BASIS[lic.basis]) {
      errs.push(`${label(i)}: unknown license.basis "${lic.basis}" — expected ${Object.keys(RIGHTS_BASIS).join(' | ')}`);
    }

    // 2 · encumbered music never ships. No override, no flag.
    if (lic.musicRights && !MUSIC_RIGHTS.has(lic.musicRights)) {
      errs.push(`${label(i)}: unknown license.musicRights "${lic.musicRights}" — expected ${[...MUSIC_RIGHTS].join(' | ')}`);
    }
    if (lic.musicRights === 'encumbered') {
      errs.push(`${label(i)}: license.musicRights is "encumbered" — this item cannot ship`);
    }

    // 3 · THE trap. An NR claim without a citation is a lead, not a clearance:
    // somebody has to have opened the year+27 / year+28 renewal volumes.
    if (lic.basis === 'NR' && !lic.verifiedBy) {
      errs.push(`${label(i)}: basis NR requires license.verifiedBy naming the CCE volume(s) checked — ` +
                `an unverified "not renewed" claim is a lead, not a clearance`);
    }

    // 4 · warnings come from a closed vocabulary the scheduler can filter on.
    if (i.contentWarning !== undefined) {
      if (!Array.isArray(i.contentWarning)) {
        errs.push(`${label(i)}: contentWarning must be an array`);
      } else {
        for (const w of i.contentWarning) {
          if (!CONTENT_WARNINGS.has(w)) {
            errs.push(`${label(i)}: unknown contentWarning "${w}" — expected ${[...CONTENT_WARNINGS].join(' | ')}`);
          }
        }
      }
    }

    // 5 · CC is not public domain and the question of whether we ship it at all
    // is an open owner decision (PD Packs Task 4). Until it is answered, no.
    // NonCommercial stays refused permanently regardless of that answer.
    if (lic.basis === 'CC') {
      errs.push(`${label(i)}: basis CC is not accepted — whether Creative Commons ships at all is an open ` +
                `decision (PD Packs Task 4). NonCommercial is refused permanently either way.`);
    }
    if (/noncommercial|\/by-nc/i.test(lic.url || '')) {
      errs.push(`${label(i)}: NonCommercial licence — refused`);
    }

    // 6 · tags (C3) are free-form — they feed dayparting in build 17 — but they
    // must at least be a list of non-empty strings so a rule can select on them.
    if (i.tags !== undefined) {
      if (!Array.isArray(i.tags) || i.tags.some((t) => typeof t !== 'string' || !t.trim())) {
        errs.push(`${label(i)}: tags must be an array of non-empty strings`);
      }
    }
  }

  // Pack level: the at-a-glance audit summary must not lie about its contents.
  const actualBases = [...new Set(manifest.items.map((i) => i.license?.basis).filter(Boolean))].sort();
  if (manifest.rightsBasisSummary !== undefined) {
    const claimed = [...manifest.rightsBasisSummary].sort();
    if (JSON.stringify(claimed) !== JSON.stringify(actualBases)) {
      errs.push(`pack rightsBasisSummary ${JSON.stringify(claimed)} does not match the items' actual bases ${JSON.stringify(actualBases)}`);
    }
  }
  if (manifest.partialSeries !== undefined && typeof manifest.partialSeries !== 'boolean') {
    errs.push('pack partialSeries must be a boolean');
  }

  if (errs.length) {
    throw new Error(
      `provenance gate: ${errs.length} problem(s) in ${manifest.id}:\n` +
      errs.map((e) => `  - ${e}`).join('\n'),
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
    const dark = [];
    for (const it of m.items) {
      let url, bytes, durationMs;
      try {
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
        file: assertSafePackFile(`${it.id}.mp4`, `pack ${m.id}/item ${it.id}`),
        url,
        bytes,
        license: it.license,
        ...(it.contentNote ? { contentNote: it.contentNote } : {}),
      });
      } catch (e) {
        // A vanished/darkened IA item is excluded and logged, never a crash —
        // the same rule as a vanished local file. LOUD, not silent (a takedown
        // means the manifest needs re-sourcing, like plane-crazy-1928 did).
        dark.push(it.id);
        console.warn(`\n⚠ ${m.id}/${it.id}: source unreachable (${e.message}) — EXCLUDED from catalog; re-source the manifest`);
      }
      process.stdout.write('.');
    }
    if (dark.length) console.warn(`⚠ ${m.id}: ${dark.length} item(s) excluded: ${dark.join(', ')}`);
    packs.push({
      id: m.id, name: m.name, kind: m.kind ?? 'shows', description: m.description ?? '',
      ...(m.audience ? { audience: m.audience } : {}),
      ...(m.contentNote ? { contentNote: m.contentNote } : {}),
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
      // Content advisories ride the manifest so the picker can disclose them
      // (wartime caricature, adult humor). Both engines' Codable/JSON readers
      // ignore unknown keys, so this is additive.
      ...(item.contentNote ? { contentNote: item.contentNote } : {}),
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
    ...(manifest.audience ? { audience: manifest.audience } : {}),
    ...(manifest.contentNote ? { contentNote: manifest.contentNote } : {}),
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
