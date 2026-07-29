#!/usr/bin/env node
// apply-cce-findings.js — write the 2026-07-29 CCE research into the manifests.
//
// Source: "CCE Renewal Research — Public Domain Clearance Findings", 29 Jul 2026.
// Catalog of Copyright Entries, Third Series, Parts 12–13 (Motion Pictures and
// Filmstrips), volume scans via the Internet Archive.
//
// This fills in `license.verifiedBy` — the field the v2 validator refuses to
// build without, because an "NR" claim with no citation is a lead rather than a
// clearance. Each entry records the actual volumes searched, so a future reader
// can retrace the work rather than trusting it.
//
// Two things the research established that a bare "not found" would not:
//
//   1. Two passes per pack. An OCR full-text search of every relevant half-year
//      renewal section, AND a visual check of the alphabetical neighbourhood on
//      the page scans — because OCR silently drops entries, and an absence you
//      cannot see is not an absence.
//
//   2. The negatives are meaningful. The same volumes show these rights holders
//      actively renewing SIBLING shorts: Paramount's 1941 one-reelers renewed in
//      bulk by Supat Industries, the Popeye one-reelers by United Artists
//      Associated, Paramount's 1943 Speaking of Animals by National Telefilm
//      Associates. The renewal machinery was demonstrably running across these
//      libraries in these very volumes, and these titles are simply not in it.
//
// Usage: node scripts/apply-cce-findings.js [--write]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKS = path.join(ROOT, 'packs');
const WRITE = process.argv.includes('--write');

const CCE = 'CCE 3rd Series, Parts 12-13 (Motion Pictures and Filmstrips)';
const METHOD =
  'Method: OCR full-text search of every relevant half-year renewal section, ' +
  'plus a visual alphabetical-neighbourhood check on the page scans (OCR can drop entries). ' +
  'Negative is substantive: the same volumes show the rights holders renewing sibling shorts in bulk. ' +
  'Best published evidence short of a Copyright Office Form 4 search report. ' +
  'Researched 2026-07-29.';

// Which volumes were searched, per production year, and the bracketing entries
// confirmed on the scans.
const FINDINGS = {
  superman: {
    1941: `${CCE}, renewal sections 1968 Jan-Jun, 1968 Jul-Dec, 1969 Jan-Jun, 1969 Jul-Dec — NO RENEWAL FOUND. ` +
          `Neighbourhood confirmed on scans: 1968 Jul-Dec p.110 (Sunset in Wyoming → Swing It, Soldier); ` +
          `1969 Jan-Jun p.43 (Sunday Punch → Surprised Parties). ${METHOD}`,
    1942: `${CCE}, renewal sections 1969 Jan-Jun, 1969 Jul-Dec, 1970 Jan-Jun, 1970 Jul-Dec — NO RENEWAL FOUND. ` +
          `Neighbourhood confirmed on scans: 1969 Jul-Dec p.114 (Strictly in the Groove → Sweet Spirits of Nighter); ` +
          `1970 Jan-Jun p.54 (The Sundown Kid → Super Mouse in Pandora's Box); ` +
          `1970 Jul-Dec p.125 (Submarine Signal → Super Mouse in Down With Cats). ${METHOD}`,
    1943: `${CCE}, renewal sections 1970 Jan-Jun, 1970 Jul-Dec, 1971 Jan-Jun, 1971 Jul-Dec — NO RENEWAL FOUND. ` +
          `Neighbourhood confirmed on scans: 1971 Jan-Jun p.66 (The Sultan's Daughter → Super Rabbit); ` +
          `1971 Jul-Dec p.154 (Sundown Valley → Swing Out the Blues). ${METHOD}`,
  },
  'popeye-color': {
    1936: `${CCE}, renewal sections 1963 Jul-Dec, 1964 Jan-Jun, 1964 Jul-Dec — NO RENEWAL FOUND. ` +
          `Pages examined: 1963 Jul-Dec p.125, 1964 Jan-Jun p.61, 1964 Jul-Dec p.122. ${METHOD}`,
    1937: `${CCE}, renewal sections 1964 Jul-Dec, 1965 Jan-Jun, 1965 Jul-Dec — NO RENEWAL FOUND. ` +
          `Pages examined: 1964 Jul-Dec p.122, 1965 Jan-Jun p.61, 1965 Jul-Dec p.124. ${METHOD}`,
    1939: `${CCE}, renewal sections 1966 Jul-Dec, 1967 Jan-Jun, 1967 Jul-Dec — NO RENEWAL FOUND. ` +
          `Aladdin checked in the A run: 1966 Jul-Dec p.89, 1967 Jan-Jun p.43, 1967 Jul-Dec p.107. ${METHOD}`,
  },
  'bosko-and-friends': {
    1931: `${CCE}, renewal sections 1958 Jan-Jun, 1958 Jul-Dec, 1959 Jan-Jun, 1959 Jul-Dec — NO RENEWAL FOUND. ` +
          `MOOT IN ANY CASE: the 95-year term expires 2026-12-31, so this clears by AGE on 2027-01-01 ` +
          `with no renewal question at all. ${METHOD}`,
  },
};

let changed = 0;
const stillOutstanding = [];

for (const [packId, byYear] of Object.entries(FINDINGS)) {
  const file = path.join(PACKS, packId, 'manifest.json');
  if (!fs.existsSync(file)) { console.warn(`skip ${packId}: no manifest`); continue; }
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  let hit = 0;
  for (const item of m.items) {
    const lic = item.license || {};
    if (lic.basis !== 'NR' || lic.verifiedBy) continue;
    const year = parseInt(String(item.aired || '').slice(0, 4), 10);
    const citation = byYear[year];
    if (!citation) { stillOutstanding.push(`${packId}/${item.id} (${year || 'no year'})`); continue; }
    lic.verifiedBy = citation;
    lic.verified = '2026-07-29';
    hit++;
  }
  if (hit && WRITE) fs.writeFileSync(file, JSON.stringify(m, null, 2) + '\n');
  console.log(`${WRITE ? 'wrote' : 'would write'}  ${packId.padEnd(20)} ${hit} item(s) cited`);
  changed += hit;
}

// Packs the research has not reached yet — named so nothing is quietly assumed.
for (const packId of ['saturday-morning', 'ad-break']) {
  const file = path.join(PACKS, packId, 'manifest.json');
  if (!fs.existsSync(file)) continue;
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const i of m.items) {
    if ((i.license || {}).basis === 'NR' && !(i.license || {}).verifiedBy) {
      stillOutstanding.push(`${packId}/${i.id} — "${i.title}" (${(i.aired || '').slice(0, 4) || 'year?'})`);
    }
  }
}

console.log(`\n${changed} item(s) ${WRITE ? 'cited' : 'would be cited'}.`);
if (stillOutstanding.length) {
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`⏳ ${stillOutstanding.length} item(s) still need a CCE search:\n`);
  for (const l of stillOutstanding) console.log(`   - ${l}`);
}
if (!WRITE) console.log('\n(dry run — re-run with --write)');
