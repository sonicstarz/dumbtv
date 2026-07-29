#!/usr/bin/env node
// migrate-manifests.js — carry pack manifests from the v1 rights shape to v2.
//
// v1 recorded provenance as prose: `license.verified` plus a paragraph. v2 adds
// `license.basis` (GOV|AGE|NR|CC), `license.verifiedBy`, `license.musicRights`,
// per-item `contentWarning[]` and `tags[]`, and pack-level `rightsBasisSummary`
// + `partialSeries`. See scripts/build-pack.js for what the gate enforces.
//
// What this script will and will not do:
//
//   ✅ It applies the UNIFORM, derivable fields — the basis a pack's own prose
//      already states, the decade tag implied by `aired`, the music-rights call
//      that follows from the basis.
//
//   ⛔ It does NOT invent a CCE citation. An `NR` claim needs somebody to have
//      opened the year+27 / year+28 renewal volumes, and a script cannot do
//      that. Items needing one are marked `basis: "NR"` and left WITHOUT
//      `verifiedBy`, so `verify` fails loudly with exactly what is missing.
//
//   ⛔ It does NOT guess which titles carry a content warning. A pack-level
//      note says the warning applies SOMEWHERE in the pack, not to which
//      cartoons. Those are printed as a checklist for a human pass.
//
// Usage:  node scripts/migrate-manifests.js [--write]
//         (without --write it is a dry run and prints the plan)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKS_DIR = path.join(ROOT, 'packs');
const WRITE = process.argv.includes('--write');

// Per-pack rights determination, read off each manifest's OWN documented prose.
// `basis: 'byYear'` means the call depends on the item's release year, which is
// the BOSKO case: 1929–30 clear by age today, 1931 does not clear until
// 2027-01-01 and rests on non-renewal until then — a caveat that pack's own
// rightsNote already spells out.
const PLAN = {
  'snafu-and-co': {
    basis: 'GOV',
    // Stalling's scores were work-for-hire on a federal production, so the
    // music is covered by the same §105 determination as the picture.
    musicRights: 'cleared',
    tags: ['cartoon', 'wartime', 'government-film'],
  },
  space: {
    basis: 'GOV',
    musicRights: 'cleared',
    tags: ['documentary', 'space', 'government-film'],
  },
  'early-disney': {
    basis: 'AGE',
    musicRights: 'unverified',
    tags: ['cartoon', 'silent-era'],
  },
  'bosko-and-friends': {
    basis: 'byYear',           // ≤1930 → AGE, 1931 → NR (needs a citation)
    ageCutoff: 1930,
    musicRights: 'unverified',
    tags: ['cartoon'],
  },
  superman: {
    basis: 'NR',
    musicRights: 'unverified',
    tags: ['cartoon', 'superhero'],
  },
  'popeye-color': {
    basis: 'NR',
    musicRights: 'unverified',
    tags: ['cartoon'],
  },
  'saturday-morning': {
    basis: 'NR',
    musicRights: 'unverified',
    tags: ['cartoon'],
  },
  'ad-break': {
    basis: 'NR',
    musicRights: 'unverified',
    tags: ['commercial'],
  },
};

const decadeTag = (aired) => {
  const y = parseInt(String(aired || '').slice(0, 4), 10);
  return Number.isFinite(y) ? `${Math.floor(y / 10) * 10}s` : null;
};

const needsCitation = [];
const needsWarningReview = [];
let changed = 0;

for (const [packId, plan] of Object.entries(PLAN)) {
  const file = path.join(PACKS_DIR, packId, 'manifest.json');
  if (!fs.existsSync(file)) { console.warn(`skip ${packId}: no manifest`); continue; }
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));

  for (const item of m.items) {
    const lic = item.license || (item.license = {});
    const year = parseInt(String(item.aired || '').slice(0, 4), 10);

    // Basis
    if (plan.basis === 'byYear') {
      lic.basis = Number.isFinite(year) && year <= plan.ageCutoff ? 'AGE' : 'NR';
    } else {
      lic.basis = plan.basis;
    }

    if (!lic.musicRights) lic.musicRights = plan.musicRights;

    // An NR claim without a citation is a lead, not a clearance — record the
    // gap rather than papering over it.
    if (lic.basis === 'NR' && !lic.verifiedBy) {
      needsCitation.push(`${packId}/${item.id}  (${item.title || '?'}${year ? `, ${year}` : ''})`);
    }

    // Tags (C3): pack tags + the decade implied by the release year. Dayparting
    // in build 17 selects on these, so a curated pack arrives usable.
    const tags = new Set([...(item.tags || []), ...plan.tags]);
    const dec = decadeTag(item.aired);
    if (dec) tags.add(dec);
    item.tags = [...tags].sort();
  }

  // Pack-level summary must match what the items actually claim.
  m.rightsBasisSummary = [...new Set(m.items.map((i) => i.license.basis))].sort();
  if (m.partialSeries === undefined) m.partialSeries = false;

  // A pack-level content note means a warning applies somewhere in the pack.
  // Which titles is a human call.
  if (m.contentNote && !m.items.some((i) => i.contentWarning?.length)) {
    needsWarningReview.push({ packId, note: m.contentNote, count: m.items.length });
  }

  if (WRITE) fs.writeFileSync(file, JSON.stringify(m, null, 2) + '\n');
  changed++;
  console.log(`${WRITE ? 'wrote' : 'would write'}  ${packId.padEnd(20)} bases=${m.rightsBasisSummary.join('+')}  items=${m.items.length}`);
}

console.log(`\n${changed} manifest(s) ${WRITE ? 'migrated' : 'planned'}.`);

if (needsCitation.length) {
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`⛔ ${needsCitation.length} item(s) claim NR and have NO Catalog of Copyright Entries citation.`);
  console.log('   These WILL fail `build-pack.js verify` until a human records');
  console.log('   license.verifiedBy naming the year+27 / year+28 volumes checked.');
  console.log('   This is deliberate: an unverified "not renewed" is a lead, not a clearance.\n');
  for (const l of needsCitation) console.log(`   - ${l}`);
}

if (needsWarningReview.length) {
  console.log(`\n${'─'.repeat(70)}`);
  console.log('📋 Content-warning review — a human must decide WHICH titles carry these.');
  console.log('   The pack-level note says the warning applies somewhere, not where.\n');
  for (const w of needsWarningReview) {
    console.log(`   ${w.packId} (${w.count} items):`);
    console.log(`     "${w.note.slice(0, 160)}${w.note.length > 160 ? '…' : ''}"\n`);
  }
}

if (!WRITE) console.log('\n(dry run — re-run with --write to apply)');
