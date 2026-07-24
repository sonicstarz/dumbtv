/**
 * Import commercials and bumpers from the media folder.
 *   npm run scan-assets
 */
import { scanAssets } from '../src/assets.js';

const r = await scanAssets();
console.log(`\nAdded ${r.added}, skipped ${r.skipped}, removed ${r.removed}. ${r.total} total.\n`);
for (const p of r.problems) console.log(`  skipped  ${p.file} — ${p.reason}`);
process.exit(0);
