#!/usr/bin/env node
// make-pack.js — turn catalog.json rows into a real, buildable pack manifest.
//
// This is the step between "we know the title is public domain" and "the app
// can download it": every item needs a FILE inside an Internet Archive item,
// and the mapping from title to filename is the work.
//
//   node scripts/make-pack.js <packId> --ia <identifier> --series <series> [--write]
//
// Matching is by normalised title, with the year as a tiebreak. Anything it
// cannot match is reported rather than guessed — a wrong file is worse than a
// missing one, because it ships silently.
//
// THE EXCLUSION THAT MATTERS: an IA public-domain compilation routinely holds
// the 1970s "redrawn"/"computer colorized" versions in the SAME item as the
// originals, sitting alphabetically adjacent. Those were renewed in 1994 and
// are separately copyrighted even where the original is free. Every one of them
// is rejected here by filename, and the count is printed, because silently
// picking one is the single easiest way to ship an infringing file while
// believing the manifest is clean.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG = path.join(ROOT, 'content', 'catalog.json');

const argv = process.argv.slice(2);
const packId = argv[0];
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : argv[i + 1]; };
const WRITE = argv.includes('--write');
const iaId = flag('ia');
const seriesFilter = flag('series');
if (!packId || !iaId) {
  console.error('usage: make-pack.js <packId> --ia <identifier> [--series <series>] [--write]');
  process.exit(1);
}

// Derivatives and commercial-restoration rips. Rejected on sight.
const REJECT = /\b(redrawn|colorized|colourized|computer|blu-?ray|dvd|laserdisc|remaster)/i;

const norm = (s) => s.toLowerCase()
  .replace(/\.ia\.mp4$|\.mp4$|\.mkv$|\.avi$/i, '')
  .replace(/\(\d{4}[^)]*\)/g, ' ')         // drop "(1942)" and "(1940, Colorized)"
  .replace(/[''´`]/g, '').replace(/&/g, 'and')
  .replace(/[^a-z0-9]+/g, ' ').trim();

const yearOf = (f) => { const m = f.match(/\((\d{4})/); return m ? +m[1] : null; };

const IA_META = (id) => `https://archive.org/metadata/${encodeURIComponent(id)}`;
const meta = await (await fetch(IA_META(iaId))).json();
const VIDEO = /\.(mp4|mkv|avi|ogv|webm)$/i;
const files = (meta.files || []).filter((f) => VIDEO.test(f.name));

const catalog = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
const wanted = catalog.titles.filter((t) =>
  t.iaItem === iaId && t.basis !== 'BLOCKED' && t.status === 'candidate' &&
  (!seriesFilter || t.series === seriesFilter));

console.log(`${files.length} video file(s) in ${iaId}`);
console.log(`${wanted.length} catalog title(s) targeting it\n`);

// Index the usable files. Rejected derivatives are counted, never matched.
const rejected = [];
const byTitle = new Map();
for (const f of files) {
  if (REJECT.test(f.name)) { rejected.push(f.name); continue; }
  const k = norm(f.name);
  if (!byTitle.has(k)) byTitle.set(k, []);
  byTitle.get(k).push(f);
}

const items = [];
const missed = [];
for (const t of wanted) {
  const cands = byTitle.get(norm(t.title)) || [];
  // Prefer an exact year match; fall back to the sole candidate.
  const pick = cands.find((f) => yearOf(f.name) === t.year) || (cands.length === 1 ? cands[0] : null);
  if (!pick) { missed.push(`${t.title} (${t.year || '?'})${cands.length > 1 ? ' — ambiguous' : ''}`); continue; }
  items.push({
    id: t.id.replace(/^wb-/, ''),
    title: t.title,
    aired: t.year ? `${t.year}-01-01` : null,
    source: { iaIdentifier: iaId, iaFile: pick.name },
    license: {
      url: t.claimedBy && t.claimedBy.startsWith('http') ? t.claimedBy : `https://archive.org/details/${iaId}`,
      verified: new Date().toISOString().slice(0, 10),
      note: `Listed as public domain by: ${t.claimedBy || 'the source compilation'}. ` +
            `NOT independently verified — basis CLAIMED. Original print only; ` +
            `redrawn/colorized derivatives in the same IA item are excluded by the pack builder.`,
      basis: t.basis,
      claimedBy: t.claimedBy || `https://archive.org/details/${iaId}`,
      musicRights: 'unverified',
      ...(t.verifiedBy ? { verifiedBy: t.verifiedBy } : {}),
    },
    ...(t.cceVolumes ? { cceVolumes: t.cceVolumes } : {}),
    ...(t.contentWarning?.length ? { contentWarning: t.contentWarning } : {}),
    tags: [t.year ? `${Math.floor(t.year / 10) * 10}s` : null, 'cartoon'].filter(Boolean),
  });
}

items.sort((a, b) => (a.aired || '').localeCompare(b.aired || '') || a.title.localeCompare(b.title));

console.log(`✓ matched   ${items.length}`);
console.log(`⛔ rejected  ${rejected.length} derivative/restoration file(s) — NOT eligible, renewed 1994`);
if (missed.length) {
  console.log(`\n⚠ ${missed.length} catalog title(s) with no usable file:`);
  for (const m of missed) console.log(`   - ${m}`);
}
if (rejected.length) {
  console.log(`\n  rejected sample: ${rejected.slice(0, 4).join(' · ')}${rejected.length > 4 ? ' …' : ''}`);
}

const dest = path.join(ROOT, 'packs', packId, 'manifest.json');
if (WRITE) {
  const existing = fs.existsSync(dest) ? JSON.parse(fs.readFileSync(dest, 'utf8')) : {};
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify({ ...existing, items }, null, 2) + '\n');
  console.log(`\nwrote ${path.relative(ROOT, dest)} (${items.length} items)`);
} else {
  console.log('\n(dry run — re-run with --write)');
}
