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

const tmp = path.join(os.tmpdir(), `dumbtv-selftest-${Date.now()}.db`);
process.env.DUMBTV_DB = tmp;
process.env.DUMBTV_PLAYER = 'none';

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

console.log('\nOverrun + cadence');

// cut-in: a pinned event hard-cuts the show it interrupts.
const chCut = makeChannel(11, 'CutIn', 'sequential', 30);
for (const s of shows) addSource.run(chCut, s.key, 'show', s.title);
db.prepare("UPDATE channels SET overrun_policy = 'cutin' WHERE id = ?").run(chCut);
const pinAt = Date.now() + 5 * HOUR;
db.prepare(
  `INSERT INTO schedule_rules (channel_id, name, kind, priority, enabled, starts_at_utc, source_type, rating_key)
   VALUES (?,?,?,?,1,?,?,?)`
).run(chCut, 'Breaking Special', 'pinned', 800, pinAt, 'episode', 'show-spidey-e5');
regenerateChannel(chCut);
const cutProg = db.prepare(
  "SELECT p.duration_ms pd, m.duration_ms md FROM programs p JOIN media m ON m.rating_key = p.rating_key WHERE p.channel_id = ? AND p.kind = 'episode' AND p.end_utc = ? AND p.duration_ms < m.duration_ms"
).get(chCut, pinAt);
check('cut-in: a show is hard-cut at the pinned start', !!cutProg,
  cutProg ? `(cut ${Math.round(cutProg.pd / 1000)}s of ${Math.round(cutProg.md / 1000)}s)` : '(none cut)');

// original_cadence: replays the show's spacing, compressed.
const chCad = makeChannel(12, 'Cadence', 'sequential', 30);
addSource.run(chCad, 'airdate-show', 'show', 'Airdate Show');
generateChannel(chCad, Date.now() + 2 * 24 * HOUR);
db.prepare(
  `INSERT INTO schedule_rules (channel_id, name, kind, priority, enabled, start_time, source_type, rating_key, airdate_mode, cadence_compress)
   VALUES (?,?,?,?,1,?,?,?,?,?)`
).run(chCad, 'Cadence run', 'airdate', 500, '08:00', 'show', 'airdate-show', 'original_cadence', 7);
regenerateChannel(chCad);
const cadProgs = db.prepare(
  "SELECT p.start_utc FROM programs p JOIN schedule_rules r ON r.id = p.rule_id WHERE r.kind = 'airdate' AND p.channel_id = ? ORDER BY p.start_utc"
).all(chCad);
const spanDays = cadProgs.length > 1
  ? (cadProgs[cadProgs.length - 1].start_utc - cadProgs[0].start_utc) / (24 * 3600 * 1000) : 0;
check('cadence: replays the show at compressed spacing', cadProgs.length >= 2 && spanDays > 7 && spanDays < 14,
  `(${cadProgs.length} eps over ${spanDays.toFixed(1)}d, original 77d ÷ 7)`);

// ---- regression: empty channel that gets content later --------------------
// A channel generated while it has no sources writes a "No content selected"
// placeholder spanning the whole window. Adding content must replace it, not
// leave the channel stuck on dead air (regenerate has to drop the placeholder
// even though it is currently airing).
const chLate = makeChannel(13, 'Added Later', 'sequential', 30);
generateChannel(chLate, until);           // built while empty → placeholder
const placeholderTitle = nowOn(chLate)?.title;
for (const s of shows) addSource.run(chLate, s.key, 'show', s.title);
regenerateChannel(chLate);                // content arrives
const nowLate = nowOn(chLate)?.title;
check('empty channel recovers when content is added later',
  placeholderTitle === 'No content selected' && nowLate && nowLate !== 'No content selected',
  `(was "${placeholderTitle}" → now "${nowLate}")`);

// ---- pin: a specific episode airs at a specific time ----------------------
// (chCut above pins show-spidey-e5 at pinAt; assert it lands exactly there.)
const pinnedAir = db.prepare(
  "SELECT 1 FROM programs WHERE channel_id = ? AND rating_key = 'show-spidey-e5' AND start_utc = ?"
).get(chCut, pinAt);
check('pin: a chosen episode airs exactly at its pinned start', !!pinnedAir);

// ---- filter: excluded episodes never air ----------------------------------
const chFilter = makeChannel(14, 'Filtered', 'sequential', 30);
addSource.run(chFilter, 'show-xmen', 'show', 'X-Men Evolution');
const banned = ['show-xmen-e3', 'show-xmen-e7', 'show-xmen-e11'];
const insExcl = db.prepare('INSERT INTO channel_excludes (channel_id, rating_key) VALUES (?,?)');
for (const k of banned) insExcl.run(chFilter, k);
generateChannel(chFilter, until);
const airedBanned = db.prepare(
  `SELECT COUNT(*) n FROM programs WHERE channel_id = ? AND rating_key IN (${banned.map(() => '?').join(',')})`
).get(chFilter, ...banned).n;
const airedOther = db.prepare(
  "SELECT COUNT(*) n FROM programs WHERE channel_id = ? AND kind = 'episode'"
).get(chFilter).n;
check('filter: excluded episodes never air', airedBanned === 0 && airedOther > 0,
  `(${airedBanned} banned aired, ${airedOther} others)`);

// ---- regression: a hole at "now" gets backfilled ---------------------------
// If the box is off long enough, the sweep removes aged programs while
// generated_thru stays far in the future — leaving nothing airing now and a
// hole up to that stale pointer. generateChannel must detect the hole (nothing
// on at now) and rebuild, not append past it.
const chHole = makeChannel(15, 'Hole', 'sequential', 30);
for (const s of shows) addSource.run(chHole, s.key, 'show', s.title);
generateChannel(chHole, Date.now() + 3 * 24 * HOUR);
// Simulate: wipe everything around now but keep generated_thru far ahead.
db.prepare('DELETE FROM programs WHERE channel_id = ? AND end_utc > ?').run(chHole, Date.now() - HOUR);
const holeThru = Date.now() + 3 * 24 * HOUR;
db.prepare('UPDATE channels SET generated_thru = ? WHERE id = ?').run(holeThru, chHole);
const onNowBefore = nowOn(chHole);
generateChannel(chHole, Date.now() + 3 * 24 * HOUR); // hourly top-up would call this
const onNowAfter = nowOn(chHole);
check('hole: a schedule gap at now is backfilled, not skipped',
  (!onNowBefore || onNowBefore.kind === 'offair') && onNowAfter && onNowAfter.kind === 'episode',
  `(before: ${onNowBefore?.title || 'nothing'} → after: ${onNowAfter?.title || 'nothing'})`);

// ---- content packs (Track I) ----------------------------------------------
console.log('\nContent packs');
const { installPack, createChannelFromPack, uninstallPack, resolvePackPath } =
  await import('../src/packs/install.js');

// A built pack is just a folder with a pack.json; scheduling needs only the
// durations, so the test writes a manifest with no actual media files.
const packDir = path.join(os.tmpdir(), `dumbtv-pack-${Date.now()}`);
fs.mkdirSync(packDir, { recursive: true });
const packManifest = {
  id: 'testpack', name: 'TEST PACK', version: 1, kind: 'shows',
  channel: { number: 90, name: 'TEST PACK', ordering: 'release_order', seed: 424242 },
  items: [
    { id: 'a', file: '01-a.mp4', title: 'Ep A', show: 'Testers', season: 1, episode: 1, aired: '1994-01-01', durationMs: 11 * MINUTE, bytes: 1, sha256: 'x' },
    { id: 'b', file: '02-b.mp4', title: 'Ep B', show: 'Testers', season: 1, episode: 2, aired: '1994-01-02', durationMs: 9 * MINUTE, bytes: 1, sha256: 'x' },
    { id: 'c', file: '03-c.mp4', title: 'Ep C', show: 'Testers', season: 1, episode: 3, aired: '1994-01-03', durationMs: 13 * MINUTE, bytes: 1, sha256: 'x' },
  ],
};
fs.writeFileSync(path.join(packDir, 'pack.json'), JSON.stringify(packManifest));

const installed = installPack(packDir, { origin: 'bundled' });
check('pack: install registers all items as media', installed.items === 3);
check('pack: media rows carry pack: part keys',
  db.prepare("SELECT COUNT(*) n FROM media WHERE part_key LIKE 'pack:testpack/%'").get().n === 3);
check('pack: resolvePackPath maps a key to a file under the pack root',
  resolvePackPath('pack:testpack/01-a.mp4') === path.join(path.resolve(packDir), '01-a.mp4'));

const { channelId: packCh } = createChannelFromPack('testpack');
generateChannel(packCh, Date.now() + 6 * HOUR);
const packRows = db.prepare('SELECT * FROM programs WHERE channel_id = ? ORDER BY start_utc').all(packCh);
check('pack: channel schedules programs', packRows.length > 0);
let packGap = false;
for (let i = 1; i < packRows.length; i++) if (packRows[i].start_utc !== packRows[i - 1].end_utc) packGap = true;
check('pack: schedule is gap-free', !packGap);
const packOnNow = nowOn(packCh);
check('pack: what airs now is playable + resolves to a local file',
  packOnNow && packOnNow.playable && (packOnNow.localPath || '').endsWith('.mp4'),
  `(${packOnNow?.title}, ${packOnNow?.source})`);

// Reinstall is idempotent — a re-registered pack keeps the same rating_keys, so
// regeneration stays stable on the same media. (The generator's shuffle/cycle
// determinism itself is covered by the Plex-channel tests above; packs feed the
// identical generate path.)
installPack(packDir, { origin: 'bundled' });   // re-register: same rating_keys, no dupes
check('pack: reinstall is idempotent (no duplicate media rows)',
  db.prepare("SELECT COUNT(*) n FROM media WHERE parent_key = 'pack:testpack'").get().n === 3);

// Uninstall = vanished content → media gone, aired schedule survives.
const airedBefore = db.prepare('SELECT COUNT(*) n FROM programs WHERE channel_id = ? AND end_utc <= ?').get(packCh, Date.now()).n;
uninstallPack('testpack');
check('pack: uninstall removes the media rows',
  db.prepare("SELECT COUNT(*) n FROM media WHERE parent_key = 'pack:testpack'").get().n === 0);
check('pack: uninstall leaves already-aired programs in place (append-only)',
  db.prepare('SELECT COUNT(*) n FROM programs WHERE channel_id = ? AND end_utc <= ?').get(packCh, Date.now()).n === airedBefore);
fs.rmSync(packDir, { recursive: true, force: true });

// ---- filename parsing (Track I, P5) ---------------------------------------
console.log('\nFilename parsing');
const { parseFilename } = await import('../src/media/filename.js');
const vectors = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'filename-vectors.json'), 'utf8'));
for (const v of vectors) {
  const r = parseFilename(v.file, v.folder);
  const ok = r.kind === v.kind && r.title === v.title
    && (v.showTitle === undefined || r.showTitle === v.showTitle)
    && (v.seasonNo === undefined || r.seasonNo === v.seasonNo)
    && (v.episodeNo === undefined || r.episodeNo === v.episodeNo)
    && (v.year === undefined || r.year === v.year);
  check(`parse: ${v.file}`, ok, JSON.stringify(r));
}

// ---- channel-number collisions (N2/N3) ------------------------------------
console.log('\nChannel number collisions');
const { createChannelFromLocalFolder } = await import('../src/media/localscan.js');
const takenNum = db.prepare('SELECT number FROM channels ORDER BY number LIMIT 1').get().number;
let collisionThrew = false;
let newNum = null;
try {
  const r = createChannelFromLocalFolder('folder:collisiontest', 'Collide', { number: takenNum });
  newNum = db.prepare('SELECT number FROM channels WHERE id=?').get(r.channelId).number;
} catch { collisionThrew = true; }
check('collision: a taken number falls back to next-free, no throw',
  !collisionThrew && newNum != null && newNum !== takenNum, `(asked ${takenNum} → got ${newNum})`);

const counts = db.prepare('SELECT COUNT(*) n FROM programs').get().n;
console.log(`\n${counts} programs across all channels`);
console.log(`${pass} passed, ${fail} failed\n`);

fs.rmSync(tmp, { force: true });
fs.rmSync(`${tmp}-wal`, { force: true });
fs.rmSync(`${tmp}-shm`, { force: true });

process.exit(fail === 0 ? 0 : 1);
