#!/usr/bin/env node
// Install a small starter set of public-domain channel packs (Track I, P4).
// For the Pi / self-host, where nothing is bundled — downloads via the catalog
// (Internet Archive derivatives direct) and puts each on the air. Idempotent.
//
//   node scripts/install-starter-packs.js [packId ...]

import { startInstall, getInstallProgress, createChannelFromPack, loadCatalog } from '../src/packs/install.js';

const DEFAULT = ['saturday-morning', 'ad-break']; // small + safe; add more as curation grows
const want = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT;
const catalog = loadCatalog().packs;

for (const id of want) {
  const entry = catalog.find((p) => p.id === id);
  if (!entry) { console.log(`skip: no such pack "${id}"`); continue; }
  process.stdout.write(`Installing ${entry.name} (${Math.round((entry.downloadBytes || 0) / 1e6)} MB)… `);
  startInstall(id);
  let p;
  do { await new Promise((r) => setTimeout(r, 1000)); p = getInstallProgress(id); } while (p && p.state === 'downloading');
  if (p?.state === 'installed') {
    console.log('done');
    // Starter channels play back-to-back, no commercials — nobody should land
    // in an ad break on a channel they didn't build. The AD BREAK pack still
    // installs, so ads are there for channels the user makes.
    if (entry.kind !== 'ads') createChannelFromPack(id, { adsEnabled: false });
  } else {
    console.log(`FAILED (${p?.error || 'unknown'})`);
  }
}
console.log('Starter packs ready. Tune in from the TV or the guide.');
process.exit(0);
