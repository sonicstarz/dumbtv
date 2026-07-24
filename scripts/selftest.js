/**
 * Proves the schedule engine works without needing a Plex server.
 * Seeds a fake library, builds channels, and checks the invariants that the
 * whole illusion depends on.
 *
 *   node scripts/selftest.js
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = path.join(os.tmpdir(), `cathode-selftest-${Date.now()}.db`);
process.env.CATHODE_DB = tmp;
process.env.CATHODE_PLAYER = 'none';

const { db } = await import('../src/db.js');
const { generateChannel, regenerateChannel } = await import('../src/schedule/generator.js');
const { nowOn, upNext, guide } = await import('../src/schedule/resolver.js');
const { inDarkWindow, MINUTE, HOUR } = await import('../src/util/time.js');

let pass = 0;
let fail = 0;
function check(label, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ok    ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label} ${detail}`);
  }
}

// ---- seed a fake library --------------------------------------------------

const shows = [
  { key: 'show-xmen', title: 'X-Men Evolution', eps: 26, mins: 22 },
  { key: 'show-spidey', title: 'Spider-Man', eps: 20, mins: 21 },
  { key: 'show-gargoyles', title: 'Gargoyles', eps: 18, mins: 23 },
];

const insertMedia = db.prepare(`
  INSERT INTO media (rating_key, parent_key, kind, title, show_title, season_no,
                     episode_no, aired, duration_ms, part_key, thumb, updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
`);

for (const s of shows) {
  for (let i = 1; i <= s.eps; i++) {
    const season = Math.ceil(i / 13);
    const epInSeason = ((i - 1) % 13) + 1;
    insertMedia.run(
      `${s.key}-e${i}`,
      s.key,
      'episode',
      `Episode ${i}`,
      s.title,
      season,
      epInSeason,
      `199${(i % 9) + 1}-0${(i % 9) + 1}-1${i % 9}`,
      s.mins * 60_000 + (i % 7) * 1000,
      `/library/parts/${s.key}-${i}/file.mkv`,
      null,
      Date.now()
    );
  }
}

for (let i = 1; i <= 6; i++) {
  insertMedia.run(
    `movie-${i}`, null, 'movie', `Kids Movie ${i}`, null, null, null,
    `199${i}-01-01`, (78 + i * 4) * 60_000, `/library/parts/movie-${i}/file.mkv`,
    null, Date.now()
  );
}

// fake ads
const insertAsset = db.prepare(
  'INSERT INTO assets (path, title, kind, duration_ms, tags) VALUES (?,?,?,?,?)'
);
[15, 30, 30, 45, 60, 20].forEach((s, i) =>
  insertAsset.run(`/fake/ads/ad${i}.mp4`, `Toy Ad ${i}`, 'ad', s * 1000, '90s,toys')
);
[5, 8, 10].forEach((s, i) =>
  insertAsset.run(`/fake/bumpers/b${i}.mp4`, `Station ID ${i}`, 'bumper', s * 1000, '')
);

// ---- build channels -------------------------------------------------------

function makeChannel(number, name, mode, slot, dark = [null, null]) {
  const info = db
    .prepare(
      `INSERT INTO channels (number, name, slot_minutes, ordering_mode, marathon_size,
        shuffle_seed, dark_start, dark_end, ads_enabled, max_ads_per_break, ad_tags,
        enabled, created_at)
       VALUES (?,?,?,?,?,?,?,?,1,4,'',1,?)`
    )
    .run(number, name, slot, mode, 3, 12345 + number, dark[0], dark[1], Date.now());
  return info.lastInsertRowid;
}

const chSeq = makeChannel(2, 'Retro Kids', 'sequential', 30);
const chShuffle = makeChannel(3, 'Shuffle Kids', 'shuffle', 30);
const chMovies = makeChannel(4, 'Kids Movies', 'release_order', 30);
const chDark = makeChannel(5, 'Bedtime Kids', 'marathon', 30, ['20:00', '07:00']);

const addSource = db.prepare(
  'INSERT INTO channel_sources (channel_id, rating_key, source_type, title) VALUES (?,?,?,?)'
);
for (const c of [chSeq, chShuffle, chDark]) {
  for (const s of shows) addSource.run(c, s.key, 'show', s.title);
}
for (let i = 1; i <= 6; i++) addSource.run(chMovies, `movie-${i}`, 'movie', `Kids Movie ${i}`);

console.log('\nGenerating 2 days of schedule for 4 channels...');
const t0 = Date.now();
const until = Date.now() + 2 * 24 * HOUR;
for (const c of [chSeq, chShuffle, chMovies, chDark]) generateChannel(c, until);
const genMs = Date.now() - t0;
console.log(`Generated in ${genMs}ms\n`);

// ---- invariants -----------------------------------------------------------

console.log('Schedule integrity');

const allChannels = [chSeq, chShuffle, chMovies, chDark];

let gaps = 0;
let overlaps = 0;
for (const c of allChannels) {
  const rows = db
    .prepare('SELECT start_utc, end_utc FROM programs WHERE channel_id = ? ORDER BY start_utc')
    .all(c);
  for (let i = 1; i < rows.length; i++) {
    const delta = rows[i].start_utc - rows[i - 1].end_utc;
    if (delta > 0) gaps++;
    if (delta < 0) overlaps++;
  }
}
check('no dead air between programs', gaps === 0, `(${gaps} gaps)`);
check('no overlapping programs', overlaps === 0, `(${overlaps} overlaps)`);

// programs run back-to-back at their natural length — no fixed 30-min grid
const starts = db
  .prepare(
    `SELECT DISTINCT slot_start s FROM programs
     WHERE channel_id = ? AND kind IN ('episode','movie') ORDER BY slot_start LIMIT 30`
  )
  .all(chSeq)
  .map((r) => r.s);
const offGrid = starts.filter((s) => {
  const d = new Date(s);
  return d.getMinutes() % 30 !== 0 || d.getSeconds() !== 0 || d.getMilliseconds() !== 0;
}).length;
check('blocks run back-to-back, not on a 30-min grid', offGrid > 0, `(${offGrid}/${starts.length} off-grid)`);

// channels are staggered — they aren't all showing the same block boundary
const heads = [chSeq, chShuffle, chMovies].map((c) => {
  const p = nowOn(c);
  return p ? p.startUtc : 0;
});
check('channels are staggered, not in lock-step', new Set(heads).size > 1);

console.log('\nJoin in progress');

const live = nowOn(chSeq);
check('something is on air right now', !!live);
if (live) {
  check(
    'offset lands inside the program',
    live.offsetMs >= 0 && live.offsetMs < live.durationMs + 1000,
    `(offset ${live.offsetMs}ms of ${live.durationMs}ms)`
  );
  console.log(
    `        on now: ${live.title}${live.subtitle ? ' — ' + live.subtitle : ''} ` +
      `(${Math.round(live.offsetMs / 1000)}s in, ${Math.round(live.remainingMs / 1000)}s left)`
  );
}

const laterOffsets = [5, 37, 61, 143].map((mins) => {
  const p = nowOn(chSeq, Date.now() + mins * MINUTE);
  return p ? `${mins}m -> ${p.title} @${Math.round(p.offsetMs / 1000)}s` : `${mins}m -> nothing`;
});
check('always something on at +5/37/61/143 min', !laterOffsets.some((s) => s.includes('nothing')));
laterOffsets.forEach((s) => console.log(`        ${s}`));

console.log('\nOrdering modes');

const seqTitles = db
  .prepare(
    `SELECT title FROM programs WHERE channel_id = ? AND kind = 'episode'
     ORDER BY start_utc LIMIT 6`
  )
  .all(chSeq)
  .map((r) => r.title);
check(
  'sequential rotates between shows',
  new Set(seqTitles.slice(0, 3)).size === 3,
  `(${seqTitles.slice(0, 3).join(', ')})`
);

const relDates = db
  .prepare(
    `SELECT p.start_utc, m.aired FROM programs p JOIN media m ON m.rating_key = p.rating_key
     WHERE p.channel_id = ? AND p.kind = 'movie' ORDER BY p.start_utc LIMIT 6`
  )
  .all(chMovies)
  .map((r) => r.aired);
check(
  'release order is chronological',
  relDates.every((d, i) => i === 0 || d >= relDates[i - 1]),
  `(${relDates.join(' ')})`
);

console.log('\nStable shuffle');

const before = db
  .prepare(
    `SELECT start_utc, rating_key FROM programs
     WHERE channel_id = ? AND start_utc > ? AND kind = 'episode'
     ORDER BY start_utc LIMIT 10`
  )
  .all(chShuffle, Date.now() + 4 * HOUR);

// Rebuilding must not move anything already generated.
generateChannel(chShuffle, until);
const after = db
  .prepare(
    `SELECT start_utc, rating_key FROM programs
     WHERE channel_id = ? AND start_utc > ? AND kind = 'episode'
     ORDER BY start_utc LIMIT 10`
  )
  .all(chShuffle, Date.now() + 4 * HOUR);

check(
  'top-up never moves an already published program',
  JSON.stringify(before) === JSON.stringify(after)
);

console.log('\nDark hours');

const offair = db
  .prepare(`SELECT * FROM programs WHERE channel_id = ? AND kind = 'offair' LIMIT 200`)
  .all(chDark);
check('bedtime channel goes off air', offair.length > 0, `(${offair.length} blocks)`);

let leaked = 0;
for (const r of db
  .prepare(`SELECT start_utc FROM programs WHERE channel_id = ? AND kind = 'episode'`)
  .all(chDark)) {
  if (inDarkWindow(r.start_utc, '20:00', '07:00')) leaked++;
}
check('nothing airs during dark hours', leaked === 0, `(${leaked} leaked)`);

console.log('\nAd breaks');

const adCount = db
  .prepare(`SELECT COUNT(*) n FROM programs WHERE channel_id = ? AND kind = 'ad'`)
  .get(chSeq).n;
check('ads got scheduled', adCount > 0, `(${adCount} spots)`);

const runs = db
  .prepare(
    `SELECT slot_start, COUNT(*) n FROM programs
     WHERE channel_id = ? AND kind = 'ad' GROUP BY slot_start ORDER BY n DESC LIMIT 1`
  )
  .get(chSeq);
check('never more than 4 ads in a break', !runs || runs.n <= 4, `(max ${runs ? runs.n : 0})`);

console.log('\nGuide');

const g = guide(Date.now(), 3);
check('guide returns every channel', g.channels.length === 4);
check(
  'every channel has listings',
  g.channels.every((c) => c.programs.length > 0),
  `(${g.channels.map((c) => c.programs.length).join(', ')})`
);

const sample = g.channels[0].programs.slice(0, 4);
console.log('        ' + sample.map((p) => `${new Date(p.startUtc).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} ${p.title}`).join('  |  '));

console.log('\nRegenerate after an edit');
const nowBefore = nowOn(chSeq);
regenerateChannel(chSeq);
const nowAfter = nowOn(chSeq);
check(
  'the in-progress program survives a rebuild',
  nowBefore && nowAfter && nowBefore.id === nowAfter.id
);

console.log('\nReservations (Backend v2)');

const chRules = makeChannel(6, 'Rules Test', 'sequential', 30);
for (const s of shows) addSource.run(chRules, s.key, 'show', s.title);
generateChannel(chRules, Date.now() + 2 * 24 * HOUR); // creates the rotation rule + baseline

// A pinned event claims an exact instant.
const pinnedAt = Date.now() + 6 * HOUR;
const pinnedKey = 'show-spidey-e3';
db.prepare(
  `INSERT INTO schedule_rules (channel_id, name, kind, priority, enabled, starts_at_utc, source_type, rating_key)
   VALUES (?,?,?,?,1,?,?,?)`
).run(chRules, 'Spidey Special', 'pinned', 800, pinnedAt, 'episode', pinnedKey);
regenerateChannel(chRules);

const pinnedProg = db
  .prepare('SELECT * FROM programs WHERE channel_id = ? AND rating_key = ? AND start_utc = ?')
  .get(chRules, pinnedKey, pinnedAt);
check('a pinned program starts to the millisecond', !!pinnedProg, `(wanted ${pinnedAt})`);

// A lower-priority event that overlaps must be reported, not silently dropped.
db.prepare(
  `INSERT INTO schedule_rules (channel_id, name, kind, priority, enabled, starts_at_utc, source_type, rating_key)
   VALUES (?,?,?,?,1,?,?,?)`
).run(chRules, 'Clashing Event', 'pinned', 700, pinnedAt + 60_000, 'episode', 'show-gargoyles-e2');
const regen = regenerateChannel(chRules);
check(
  'conflicts are reported, never silently dropped',
  (regen.conflicts || []).some((c) => c.rule === 'Clashing Event'),
  `(${JSON.stringify(regen.conflicts || [])})`
);

// Reservations must not create overlaps or gaps.
const rprog = db
  .prepare("SELECT start_utc, end_utc FROM programs WHERE channel_id = ? ORDER BY start_utc")
  .all(chRules);
let rovl = 0, rgap = 0;
for (let i = 1; i < rprog.length; i++) {
  const d = rprog[i].start_utc - rprog[i - 1].end_utc;
  if (d < 0) rovl++;
  if (d > 0) rgap++;
}
check('no overlaps once reservations are placed', rovl === 0, `(${rovl})`);
check('no gaps once reservations are placed', rgap === 0, `(${rgap})`);

// airing_no: the first time an item airs is a premiere.
const premiere = db
  .prepare("SELECT MIN(airing_no) m FROM programs WHERE channel_id = ? AND kind = 'episode'")
  .get(chSeq).m;
check('premiere/rerun tracked (airing_no starts at 1)', premiere === 1, `(min ${premiere})`);

// Repeat cooldown: a fresh channel with a big cooldown should not repeat an item
// while others remain unaired within the window.
// A shuffle channel would otherwise repeat an item across a cycle boundary;
// with a cooldown it airs every episode once before any repeat. Window sized to
// ~20 of the 26 episodes so uniqueness is achievable.
const chCool = makeChannel(7, 'Cooldown', 'shuffle', 30);
addSource.run(chCool, 'show-xmen', 'show', 'X-Men Evolution'); // 26 unique episodes
db.prepare('UPDATE channels SET cooldown_days = 7 WHERE id = ?').run(chCool);
generateChannel(chCool, Date.now() + 7 * HOUR); // ~19 episodes
const airedKeys = db
  .prepare("SELECT rating_key FROM programs WHERE channel_id = ? AND kind = 'episode'")
  .all(chCool).map((r) => r.rating_key);
const uniqueKeys = new Set(airedKeys);
check('repeat cooldown airs everything once before repeating', airedKeys.length === uniqueKeys.size,
  `(${airedKeys.length} aired, ${uniqueKeys.size} unique)`);

console.log('\nAirdate scheduling');

// A show whose episodes originally aired on consecutive Saturdays.
const satBase = Date.UTC(1994, 8, 3); // Sat 1994-09-03
for (let i = 1; i <= 12; i++) {
  const iso = new Date(satBase + (i - 1) * 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  insertMedia.run(`airdate-e${i}`, 'airdate-show', 'episode', `AD Ep ${i}`, 'Airdate Show',
    1, i, iso, 22 * 60_000, `/library/parts/ad-${i}/file.mkv`, null, Date.now());
}
const chAir = makeChannel(8, 'Airdate Test', 'sequential', 30);
addSource.run(chAir, 'airdate-show', 'show', 'Airdate Show');
generateChannel(chAir, Date.now() + 2 * 24 * HOUR); // baseline (creates rotation rule)
db.prepare(
  `INSERT INTO schedule_rules (channel_id, name, kind, priority, enabled, start_time, source_type, rating_key, airdate_mode)
   VALUES (?,?,?,?,1,?,?,?,?)`
).run(chAir, 'Saturday Mornings', 'airdate', 500, '08:00', 'show', 'airdate-show', 'original_weekday');
regenerateChannel(chAir);

const airProgs = db.prepare(
  "SELECT p.start_utc, p.rating_key FROM programs p JOIN schedule_rules r ON r.id = p.rule_id WHERE r.kind = 'airdate' AND p.channel_id = ?"
).all(chAir);
const allSat8 = airProgs.length > 0 && airProgs.every((p) => {
  const d = new Date(p.start_utc);
  return d.getDay() === 6 && d.getHours() === 8;
});
check('airdate: episodes air on the original weekday at the set time', allSat8, `(${airProgs.length} placed)`);
check('airdate: consecutive weeks advance through the show', airProgs.length < 2 ||
  airProgs[0].rating_key !== airProgs[1].rating_key, `(${airProgs.map((p) => p.rating_key).join(', ')})`);

console.log('\nAd timing modes');

// grid mode: blocks land back on :00 / :30 so the guide stays readable.
const chGrid = makeChannel(9, 'Grid', 'sequential', 30);
for (const s of shows) addSource.run(chGrid, s.key, 'show', s.title);
db.prepare("UPDATE channels SET timing_mode = 'grid', ads_between = 2 WHERE id = ?").run(chGrid);
generateChannel(chGrid, Date.now() + 2 * 24 * HOUR);
// Exclude the final slot — it's clamped to the window end, not a boundary.
const gridEnds = db.prepare(
  "SELECT slot_start, MAX(end_utc) e FROM programs WHERE channel_id = ? GROUP BY slot_start ORDER BY slot_start"
).all(chGrid).slice(0, -1);
let gridMiss = 0;
for (const r of gridEnds) {
  const d = new Date(r.e);
  if (d.getMinutes() % 30 !== 0 || d.getSeconds() !== 0 || d.getMilliseconds() !== 0) gridMiss++;
}
check('grid mode: blocks land on :00 / :30', gridMiss === 0, `(${gridMiss}/${gridEnds.length} off-grid)`);

// auto mode: each slot is a multiple of 5 minutes.
const chAuto = makeChannel(10, 'Auto', 'sequential', 30);
for (const s of shows) addSource.run(chAuto, s.key, 'show', s.title);
db.prepare("UPDATE channels SET timing_mode = 'auto', ads_between = 3 WHERE id = ?").run(chAuto);
generateChannel(chAuto, Date.now() + 2 * 24 * HOUR);
const autoSlots = db.prepare(
  "SELECT slot_start, MAX(end_utc) e FROM programs WHERE channel_id = ? GROUP BY slot_start ORDER BY slot_start"
).all(chAuto).slice(0, -1); // last slot is clamped to the window end
let notFive = 0;
for (const r of autoSlots) { if ((r.e - r.slot_start) % (5 * MINUTE) !== 0) notFive++; }
check('auto mode: slots round to 5 minutes', notFive === 0, `(${notFive} off)`);

const counts = db.prepare('SELECT COUNT(*) n FROM programs').get().n;
console.log(`\n${counts} programs across 4 channels / 2 days`);
console.log(`${pass} passed, ${fail} failed\n`);

fs.rmSync(tmp, { force: true });
fs.rmSync(`${tmp}-wal`, { force: true });
fs.rmSync(`${tmp}-shm`, { force: true });

process.exit(fail === 0 ? 0 : 1);
