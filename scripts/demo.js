/**
 * Builds a complete working lineup with no Plex server involved.
 *
 *   npm run demo
 *
 * Generates short stand-in "episodes" that burn a running timecode into the
 * picture, then wires up four channels on five minute slots. Start Cathode,
 * open /tv, and you will land in the middle of something with the timecode
 * already running — which is the proof that joining in progress works.
 *
 * Needs ffmpeg. Undo it all with: npm run demo -- --clean
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../src/db.js';
import { config } from '../src/config.js';
import { scanAssets } from '../src/assets.js';
import { generateChannel } from '../src/schedule/generator.js';

const run = promisify(execFile);
const DEMO_DIR = path.join(config.mediaDir, 'demo-shows');

const SHOWS = [
  { key: 'demo-mutants', title: 'Mutant Academy', colour: '#3b2f63', eps: 4, secs: 150 },
  { key: 'demo-webhead', title: 'The Web Slinger', colour: '#7a2222', eps: 4, secs: 130 },
  { key: 'demo-stone', title: 'Stone Guardians', colour: '#1f4a3d', eps: 3, secs: 170 },
  { key: 'demo-space', title: 'Rocket Rangers', colour: '#1d3f6b', eps: 3, secs: 140 },
];

const MOVIES = [
  { key: 'demo-movie-1', title: 'The Great Balloon Race', colour: '#6b4f1d', secs: 420 },
  { key: 'demo-movie-2', title: 'Winter at Pine Lodge', colour: '#2b3a5c', secs: 380 },
];

if (process.argv.includes('--clean')) {
  db.prepare(`DELETE FROM programs WHERE channel_id IN
    (SELECT id FROM channels WHERE name LIKE 'Demo %')`).run();
  db.prepare(`DELETE FROM channels WHERE name LIKE 'Demo %'`).run();
  db.prepare(`DELETE FROM media WHERE rating_key LIKE 'demo-%'`).run();
  fs.rmSync(DEMO_DIR, { recursive: true, force: true });
  console.log('\nDemo lineup removed.\n');
  process.exit(0);
}

const fontCandidates = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
  '/System/Library/Fonts/Helvetica.ttc',
  'C:/Windows/Fonts/arialbd.ttf',
];
const font = fontCandidates.find((f) => fs.existsSync(f));
const fontArg = font ? `:fontfile=${font}` : '';

fs.mkdirSync(DEMO_DIR, { recursive: true });

// drawtext needs an ffmpeg built with libfreetype. Plenty of installs (and a
// stranger's Saturday laptop) don't have it. When it's missing we fall back to
// testsrc2, which draws its own running timer with no font dependency — that
// moving clock is the whole point of demo mode, so the proof survives even
// though the show/episode captions don't.
async function ffmpegHasFilter(name) {
  try {
    const { stdout } = await run('ffmpeg', ['-hide_banner', '-filters']);
    return stdout.split('\n').some((l) => l.trim().split(/\s+/).includes(name));
  } catch {
    return false;
  }
}
const hasDrawtext = await ffmpegHasFilter('drawtext');
if (!hasDrawtext) {
  console.log(
    '  ffmpeg has no drawtext filter (built without libfreetype) — using\n' +
    '  test-pattern clips with a built-in running timer instead. The\n' +
    '  join-in-progress proof still works; only the captions are gone.\n'
  );
}

async function makeClip(file, secs, colour, line1, line2) {
  if (fs.existsSync(file)) return false;

  const args = ['-y'];
  if (hasDrawtext) {
    const filters = [
      `drawtext=text='${line1}':fontcolor=white:fontsize=44:x=(w-text_w)/2:y=h/2-90${fontArg}`,
      `drawtext=text='${line2}':fontcolor=0xf2b134:fontsize=30:x=(w-text_w)/2:y=h/2-20${fontArg}`,
      `drawtext=text='%{pts\\:hms}':fontcolor=white:fontsize=64:x=(w-text_w)/2:y=h/2+50${fontArg}`,
    ].join(',');
    args.push('-f', 'lavfi', '-i', `color=c=${colour}:s=640x480:d=${secs}:r=24`);
    args.push('-f', 'lavfi', '-i', `sine=frequency=220:duration=${secs}`);
    args.push('-vf', filters);
  } else {
    args.push('-f', 'lavfi', '-i', `testsrc2=s=640x480:r=24:d=${secs}`);
    args.push('-f', 'lavfi', '-i', `sine=frequency=220:duration=${secs}`);
  }
  args.push(
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest',
    file,
  );

  await run('ffmpeg', args);
  return true;
}

console.log('\nBuilding demo content (this takes a minute)...\n');

const insertMedia = db.prepare(`
  INSERT INTO media (rating_key, parent_key, kind, title, show_title, season_no,
                     episode_no, aired, duration_ms, part_key, thumb, updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(rating_key) DO UPDATE SET duration_ms = excluded.duration_ms,
                                        part_key = excluded.part_key
`);

let built = 0;
for (const s of SHOWS) {
  for (let e = 1; e <= s.eps; e++) {
    const file = path.join(DEMO_DIR, `${s.key}-s01e0${e}.mp4`);
    if (await makeClip(file, s.secs, s.colour, s.title, `Season 1, Episode ${e}`)) built++;
    insertMedia.run(
      `${s.key}-e${e}`, s.key, 'episode', `Episode ${e}`, s.title, 1, e,
      `199${e}-0${e}-01`, s.secs * 1000, `local:${file}`, null, Date.now()
    );
    process.stdout.write(`  ${s.title} — episode ${e}\r`);
  }
  console.log(`  built  ${s.title} (${s.eps} episodes)          `);
}

for (const m of MOVIES) {
  const file = path.join(DEMO_DIR, `${m.key}.mp4`);
  if (await makeClip(file, m.secs, m.colour, m.title, 'Feature Presentation')) built++;
  insertMedia.run(
    m.key, null, 'movie', m.title, null, null, null,
    '1995-01-01', m.secs * 1000, `local:${file}`, null, Date.now()
  );
  console.log(`  built  ${m.title}`);
}

console.log(`\n${built} clip(s) generated.\n`);

// ---- commercials ----------------------------------------------------------

const scan = await scanAssets();
if (scan.total === 0) {
  console.log('No commercials found. Run "npm run demo-ads" for stand-ins, then');
  console.log('"npm run demo" again to get ad breaks between the shows.\n');
} else {
  console.log(`${scan.total} commercial(s) and bumper(s) available for breaks.\n`);
}

// ---- channels -------------------------------------------------------------

function makeChannel(number, name, mode, sources, extra = {}) {
  db.prepare('DELETE FROM channels WHERE number = ?').run(number);
  const id = db
    .prepare(
      `INSERT INTO channels (number, name, slot_minutes, ordering_mode, marathon_size,
        shuffle_seed, dark_start, dark_end, ads_enabled, max_ads_per_break, ad_tags,
        enabled, created_at)
       VALUES (?,?,?,?,?,?,?,?,1,10,'',1,?)`
    )
    .run(
      number, name, extra.slot ?? 5, mode, 3,
      Math.floor(Math.random() * 2 ** 31),
      extra.darkStart ?? null, extra.darkEnd ?? null, Date.now()
    ).lastInsertRowid;

  const addSrc = db.prepare(
    'INSERT INTO channel_sources (channel_id, rating_key, source_type, title) VALUES (?,?,?,?)'
  );
  for (const s of sources) addSrc.run(id, s.key, s.type, s.title);
  generateChannel(id);
  return id;
}

makeChannel(2, 'Demo Retro Kids', 'shuffle', [
  { key: 'demo-mutants', type: 'show', title: 'Mutant Academy' },
  { key: 'demo-webhead', type: 'show', title: 'The Web Slinger' },
  { key: 'demo-stone', type: 'show', title: 'Stone Guardians' },
]);

makeChannel(3, 'Demo Movies', 'release_order', [
  { key: 'demo-movie-1', type: 'movie', title: 'The Great Balloon Race' },
  { key: 'demo-movie-2', type: 'movie', title: 'Winter at Pine Lodge' },
], { slot: 10 });

makeChannel(4, 'Demo Modern Kids', 'sequential', [
  { key: 'demo-space', type: 'show', title: 'Rocket Rangers' },
  { key: 'demo-mutants', type: 'show', title: 'Mutant Academy' },
]);

makeChannel(5, 'Demo Bedtime', 'marathon', [
  { key: 'demo-stone', type: 'show', title: 'Stone Guardians' },
], { darkStart: '20:00', darkEnd: '07:00' });

const programs = db.prepare('SELECT COUNT(*) n FROM programs').get().n;

console.log('Demo lineup ready.');
console.log(`  4 channels, ${programs} scheduled programs`);
console.log('  Channels run on short slots so you see turnover fast.\n');
console.log('  npm start   then open http://localhost:8080/tv');
console.log('  The timecode burned into the picture is the elapsed');
console.log('  broadcast time — if it is not at 00:00:00 when you tune in,');
console.log('  you joined a show already in progress. That is the point.\n');
console.log('  Remove it all later with: npm run demo -- --clean\n');

process.exit(0);
