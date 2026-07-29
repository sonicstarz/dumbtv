#!/usr/bin/env node
// seed-catalog.js — build content/catalog.json from every source we have.
//
// Three inputs, merged into one row per title:
//
//   1. The shipped packs (packs/*/manifest.json) — these already carry a real,
//      cited basis. They win over anything below.
//   2. The 2026-07-26 field guide (~/Downloads/dumbtv-starter-pack-titles.md),
//      transcribed here so it is version-controlled rather than sitting in a
//      Downloads folder. Everything from it that is not already shipped comes
//      in as CLAIMED — a credible source lists it, we have not checked it.
//   3. The field guide's do-not-include list, as BLOCKED rows. These are titles
//      that appear on PD compilations and are NOT public domain. Recording them
//      is the point: it stops a future pass from "discovering" them again.
//
// Re-runnable. Existing rows are preserved and only ever upgraded — a row that
// has been researched into NR/AGE/GOV is never knocked back down to CLAIMED.
//
// Usage: node scripts/seed-catalog.js [--write]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKS = path.join(ROOT, 'packs');
const OUT = path.join(ROOT, 'content', 'catalog.json');
const WRITE = process.argv.includes('--write');

const slug = (s) => s.toLowerCase()
  .replace(/[''´]/g, '').replace(/&/g, 'and')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// The renewal window: a work published in year Y had to be renewed in Y+28,
// and filings straddle the boundary, so a research pass opens Y+27 and Y+28.
const cceWindow = (year) =>
  !year || year > 1963 ? null : `${year + 27}, ${year + 28}`;

// The IA PD compilation each block is sourced from.
const IA = {
  wb: 'ltmm-publicdomain',
  flip: 'flip-the-frog',
  vanbeuren: 'van-beurens-tom-and-jerry-the-complete-collection',
};

const rows = [];
const add = (r) => rows.push({
  contentWarning: [], characterRisk: false, pack: null, notes: null,
  claimedBy: null, verifiedBy: null, iaItem: null,
  ...r,
  cceVolumes: r.cceVolumes ?? cceWindow(r.year),
});

// A block of same-year titles from one studio, all CLAIMED.
function block({ titles, year, studio, series, iaItem, pack, claimedBy, prefix, warn }) {
  for (const raw of titles) {
    // Trailing markers in the field guide: ⚠️ = caricature/wartime, 🎀 = Blue
    // Ribbon reissue (a reissue can carry its own registration — highest-risk
    // subgroup, and exactly the March-of-the-Wooden-Soldiers shape).
    const caution = raw.includes('⚠️');
    const ribbon = raw.includes('🎀');
    const title = raw.replace(/[⚠️🎀]/g, '').trim();
    const notes = [
      ribbon ? 'Blue Ribbon reissue — the reissue may carry its own registration. Verify individually.' : null,
      warn && caution ? warn : null,
    ].filter(Boolean).join(' ') || null;
    add({
      id: `${prefix}-${slug(title)}`,
      title, year, studio, series, iaItem, pack,
      basis: 'CLAIMED',
      claimedBy,
      status: 'candidate',
      contentWarning: caution ? ['racial-caricature'] : [],
      notes,
    });
  }
}

// ── 1 · Already shipped ─────────────────────────────────────────────────────
// Real bases, real citations. Read straight from the manifests so this file can
// never disagree with what is actually in a pack.
const SHIPPED_PACK_STUDIO = {
  'snafu-and-co': ['US Government', 'Private Snafu'],
  'space': ['NASA', 'Space'],
  'superman': ['Fleischer / Famous', 'Superman'],
  'popeye-color': ['Fleischer / Famous', 'Popeye'],
  'bosko-and-friends': ['Warner Bros.', 'Looney Tunes'],
  'early-disney': ['Disney', 'Mickey Mouse / Silly Symphonies'],
  'saturday-morning': ['Fleischer', 'Betty Boop'],
  'ad-break': ['Sponsored film', 'Commercials'],
};
for (const dir of fs.readdirSync(PACKS)) {
  const f = path.join(PACKS, dir, 'manifest.json');
  if (!fs.existsSync(f)) continue;
  const m = JSON.parse(fs.readFileSync(f, 'utf8'));
  const [studio, series] = SHIPPED_PACK_STUDIO[dir] || ['?', '?'];
  for (const it of m.items) {
    const lic = it.license || {};
    const year = parseInt(String(it.aired || '').slice(0, 4), 10) || null;
    add({
      id: it.id, title: it.title, year, studio, series,
      basis: lic.basis || 'CLAIMED',
      claimedBy: lic.url ?? null,
      verifiedBy: lic.verifiedBy ?? null,
      iaItem: it.source?.iaIdentifier ?? null,
      pack: dir,
      // An NR row with no citation is still blocking its pack — say so here
      // rather than letting it read as shipped.
      status: (lic.basis === 'NR' && !lic.verifiedBy) ? 'needs-research' : 'shipped',
      contentWarning: it.contentWarning || [],
      characterRisk: dir === 'superman' || dir === 'popeye-color' || dir === 'early-disney',
      notes: lic.note ?? null,
    });
  }
}

// ── 2 · Field guide, section A — Warner Bros. (121) ─────────────────────────
const WB_CLAIM = 'https://archive.org/details/ltmm-publicdomain (Looney Tunes Wiki PD list, sourced from Hurst\'s Film Superlist)';
const wbWarn = 'Censored Eleven / wartime caricature — legally clear but never on a kids channel.';
const wb = (titles, year) => block({
  titles, year, studio: 'Warner Bros.', series: 'Looney Tunes / Merrie Melodies',
  iaItem: IA.wb, pack: null, claimedBy: WB_CLAIM, prefix: 'wb', warn: wbWarn,
});

wb(['Hittin\' the Trail for Hallelujah Land ⚠️'], 1931);
wb(['Bosko at the Zoo', 'Pagan Moon', 'Battling Bosko', 'Freddy the Freshman',
    'Big-Hearted Bosko', 'Crosby, Columbo, and Vallee', 'Bosko\'s Party', 'Goopy Geer',
    'Bosko and Bruno', 'It\'s Got Me Again!', 'Moonlight for Two', 'Bosko\'s Dog Race',
    'The Queen Was in the Parlor', 'Bosko at the Beach', 'I Love a Parade', 'Bosko\'s Store',
    'Bosko the Lumberjack', 'You\'re Too Careless with Your Kisses!', 'I Wish I Had Wings',
    'A Great Big Bunch of You', 'Bosko\'s Dizzy Date ⚠️'], 1932);
wb(['Three\'s a Crowd', 'The Shanty Where Santy Claus Lives'], 1933);
wb(['Hollywood Capers'], 1935);
wb(['Boom Boom', 'Westward Whoa'], 1936);
wb(['Porky\'s Railroad', 'Get Rich Quick Porky', 'Porky\'s Garden', 'I Wanna Be a Sailor 🎀'], 1937);
wb(['Jungle Jitters ⚠️', 'Have You Got Any Castles? 🎀'], 1938);
wb(['Hamateur Night', 'Robin Hood Makes Good 🎀', 'Gold Rush Daze', 'A Day at the Zoo 🎀',
    'Prest-O Change-O 🎀', 'Bars and Stripes Forever', 'Daffy Duck and the Dinosaur'], 1939);
wb(['The Early Worm Gets the Bird 🎀', 'Ali-Baba Bound', 'The Timid Toreador'], 1940);
wb(['The Haunted Mouse', 'Joe Glow, the Firefly', 'Porky\'s Bear Facts', 'Porky\'s Preview',
    'Porky\'s Ant', 'Farm Frolics 🎀', 'A Coy Decoy', 'Porky\'s Prize Pony', 'Meet John Doughboy',
    'We, the Animals – Squeak!', 'Sport Chumpions', 'The Henpecked Duck',
    'All This and Rabbit Stew ⚠️', 'Notes to You', 'Robinson Crusoe Jr.', 'Rookie Revue',
    'Porky\'s Midnight Matinee', 'Porky\'s Pooch'], 1941);
wb(['Porky\'s Pastry Pirates', 'Who\'s Who in the Zoo', 'Porky\'s Cafe',
    'The Wabbit Who Came to Supper', 'Saps in Chaps', 'Daffy\'s Southern Exposure',
    'The Wacky Wabbit', 'Nutty News', 'Hobby Horse-Laffs', 'Gopher Goofy', 'Wacky Blackout',
    'Foney Fables', 'The Ducktators', 'Eatin\' on the Cuff', 'Fresh Hare ⚠️',
    'The Impatient Patient', 'Fox Pop 🎀', 'The Dover Boys at Pimento University',
    'The Sheepish Wolf 🎀', 'The Daffy Duckaroo', 'A Tale of Two Kitties 🎀',
    'Ding Dog Daddy', 'Case of the Missing Hare'], 1942);
wb(['Confusions of a Nutzy Spy', 'Pigs in a Polka 🎀', 'To Duck .... or Not to Duck',
    'The Fifth-Column Mouse 🎀', 'Hop and Go', 'Tokio Jokio ⚠️', 'Yankee Doodle Daffy',
    'Wackiki Wabbit', 'Porky Pig\'s Feat', 'Scrap Happy Daffy', 'A Corny Concerto',
    'Falling Hare', 'Inki and the Minah Bird 🎀', 'Daffy – The Commando', 'Puss n\' Booty'], 1943);

// ── 3 · Section D — Warner government shorts not yet shipped ────────────────
block({ titles: ['Point Rationing of Foods'], year: 1943, studio: 'US Government',
  series: 'Warner government', iaItem: null, pack: 'snafu-and-co', prefix: 'gov',
  claimedBy: 'Field guide section D — US government work' });
block({ titles: ['90 Day Wondering'], year: 1956, studio: 'US Government',
  series: 'Warner government', iaItem: null, pack: 'snafu-and-co', prefix: 'gov',
  claimedBy: 'Field guide section D — US government work' });
block({ titles: ['Drafty, Isn\'t It?'], year: 1957, studio: 'US Government',
  series: 'Warner government', iaItem: null, pack: 'snafu-and-co', prefix: 'gov',
  claimedBy: 'Field guide section D — US government work' });
block({ titles: ['Secrets of the Caribbean'], year: 1945, studio: 'US Government',
  series: 'Private Snafu', iaItem: null, pack: 'snafu-and-co', prefix: 'snafu',
  claimedBy: 'Field guide section B — unreleased Private Snafu, US government work' });

// ── 4 · Section F — Silly Symphonies (AGE, 1929–30) ─────────────────────────
for (const [titles, year] of [
  [['El Terrible Toreador', 'Springtime', 'Hell\'s Bells', 'The Merry Dwarfs'], 1929],
  [['Summer', 'Autumn', 'Cannibal Capers', 'Frolicking Fish', 'Arctic Antics', 'Night',
    'Midnight in a Toy Shop', 'Monkey Melodies', 'Winter', 'Playful Pan'], 1930],
]) {
  for (const t of titles) add({
    id: `disney-${slug(t)}`, title: t, year, studio: 'Disney', series: 'Silly Symphonies',
    // ≤1930 is deterministic — the only risk is a wrong release date, so this
    // is AGE on arrival rather than CLAIMED.
    basis: 'AGE',
    claimedBy: 'Field guide section F — published 1930 or earlier',
    pack: 'early-disney', status: 'candidate', characterRisk: true,
    notes: 'Disney trademark exposure is the real risk here, not copyright. Ships only under a neutral channel name with no Disney branding.',
  });
}

// ── 5 · Section G — Ub Iwerks (7 of 38 enumerated) ──────────────────────────
block({ titles: ['Fiddlesticks'], year: 1930, studio: 'Ub Iwerks', series: 'Flip the Frog',
  iaItem: IA.flip, pack: null, prefix: 'flip',
  claimedBy: 'https://archive.org/details/flip-the-frog (first colour sound cartoon)' });
for (const t of ['Little Orphan Willie', 'The Soup Song', 'The Goal Rush', 'Techno-Cracked',
                 'Funny Face', 'Soda Squirt']) {
  add({ id: `flip-${slug(t)}`, title: t, year: null, studio: 'Ub Iwerks',
    series: 'Flip the Frog', basis: 'CLAIMED', iaItem: IA.flip, pack: null,
    claimedBy: 'https://archive.org/details/flip-the-frog',
    status: 'candidate', notes: 'Year unconfirmed (1930–33 range) — needed before the CCE window can be computed.' });
}

// ── 6 · Section H — Van Beuren (6 of ~25 enumerated) ────────────────────────
for (const [t, year] of [['Wot a Night', 1931], ['Polar Pals', 1932], ['Trouble', 1932],
                         ['Piano Tooners', 1932], ['Jolly Fish', 1933], ['Galloping Fanny', 1933]]) {
  add({ id: `vb-${slug(t)}`, title: t, year, studio: 'Van Beuren',
    series: 'Tom & Jerry (the human duo)', basis: 'CLAIMED', iaItem: IA.vanbeuren, pack: null,
    claimedBy: 'Field guide section H — studio dissolved 1936, nothing maintained',
    status: 'candidate',
    notes: 'Later retitled "Dick and Larry". NOT the MGM Tom and Jerry, which is fully copyrighted.' });
}

// ── 7 · Section K — feature films ───────────────────────────────────────────
const FEATURES = [
  ['Night of the Living Dead', 1968, 'horror', 'The cleanest famous case: the distributor retitled from Night of the Flesh Eaters and omitted the copyright notice on the new title card.'],
  ['Nosferatu', 1922, 'horror', null], ['The Cabinet of Dr. Caligari', 1920, 'horror', null],
  ['Phantom of the Opera', 1925, 'horror', null], ['Carnival of Souls', 1962, 'horror', null],
  ['House on Haunted Hill', 1959, 'horror', null], ['Little Shop of Horrors', 1961, 'horror', null],
  ['A Bucket of Blood', 1959, 'horror', null], ['Dementia 13', 1963, 'horror', null],
  ['The Killer Shrews', 1959, 'horror', null], ['Attack of the Giant Leeches', 1959, 'horror', null],
  ['Night Tide', 1963, 'horror', null], ['Maniac', 1934, 'horror', null],
  ['His Girl Friday', 1940, 'comedy', null], ['My Man Godfrey', 1936, 'comedy', null],
  ['The Flying Deuces', 1939, 'comedy', 'Laurel & Hardy.'],
  ['Charade', 1963, 'comedy', 'Lapsed because Universal omitted the required ©/Copyright/Copr. from the notice.'],
  ['Detour', 1945, 'comedy', null], ['Beat the Devil', 1953, 'comedy', null],
  ['The Inspector General', 1949, 'comedy', null], ['My Favorite Brunette', 1947, 'comedy', null],
  ['At War With the Army', 1950, 'comedy', null], ['The Road to Bali', 1952, 'comedy', null],
  ['Jack and the Beanstalk', 1952, 'comedy', null],
  ['The General', 1926, 'silent', 'Keaton.'], ['Sherlock Jr.', 1924, 'silent', null],
  ['A Trip to the Moon', 1902, 'silent', null],
  ['The Hunchback of Notre Dame', 1923, 'silent', 'Lon Chaney.'],
  ['Metropolis', 1927, 'silent', 'ORIGINAL ONLY — every modern restoration carries its own new copyright.'],
];
for (const [title, year, genre, note] of FEATURES) {
  add({
    id: `feat-${slug(title)}`, title, year, studio: 'Feature film', series: `Features — ${genre}`,
    // Pre-1930 features are deterministic; the rest are claims.
    basis: year <= 1930 ? 'AGE' : 'CLAIMED',
    claimedBy: 'Field guide section K — feature film shortlist',
    pack: null, status: 'candidate', notes: note,
  });
}

// ── 8 · Section J — the do-not-include list ─────────────────────────────────
// Recorded so a later pass cannot "discover" them again. This is the cheapest
// row in the file and the one that saves the most.
const BLOCKED = [
  ...['Hollywood Steps Out', 'An Itch in Time', 'Crowing Pains', 'The Goofy Gophers',
      'Fin \'n\' Catty', 'The Unruly Hare', 'The Rattled Rooster', 'Flop Goes the Weasel',
      'Gift Wrapped', 'Lumber Jerks', 'Mr. Whiskers\' Birthday', 'Porky in Wackyland']
      .map((t) => [t, 'Warner Bros.', 'Appears on unofficial PD compilations and is still under copyright.']),
  ['It\'s a Wonderful Life', 'Republic', 'THE classic trap — listed as PD on half the sites out there. Republic reasserted control in 1993 through the underlying short story and the score.'],
  ['Betty Boop for President', 'Fleischer', 'Confirmed still copyrighted.'],
  ['Betty Boop, M.D.', 'Fleischer', 'Confirmed still copyrighted.'],
  ['Betty Boop Limited', 'Fleischer', 'Confirmed still copyrighted.'],
  ['Be Up to Date', 'Fleischer', 'Confirmed still copyrighted.'],
  ['Little Dutch Mill', 'Fleischer', 'One of the five Color Classics still copyrighted.'],
  ['Educated Fish', 'Fleischer', 'One of the five Color Classics still copyrighted.'],
  ['The Playful Polar Bears', 'Fleischer', 'One of the five Color Classics still copyrighted.'],
  ['Little Lamby', 'Fleischer', 'One of the five Color Classics still copyrighted.'],
  ['The Tears of an Onion', 'Fleischer', 'One of the five Color Classics still copyrighted.'],
  ['Goonland', 'Fleischer', 'Popeye — not public domain.'],
  ['Popeye the Sailor', 'Fleischer', 'The 1933 animated debut does not clear until 2029.'],
  ['MGM Tom and Jerry (all shorts)', 'MGM', 'Every short, no exceptions.'],
  ['Any 1970s redrawn/colorized WB short', 'Warner Bros.', 'Renewed 1994. Separately copyrighted even where the original is free, and they sit in the SAME Internet Archive item as the originals.'],
  ['Any restored/remastered edition', '—', 'A restoration is its own derivative copyright. Always pull the raw Archive scan, never a boutique Blu-ray/DVD/LaserDisc rip.'],
  ['All post-1943 Warner shorts', 'Warner Bros.', 'Puss n\' Booty (1943) is the last PD one.'],
  ['All 1934 Warner releases', 'Warner Bros.', 'Clear in 2030.'],
];
for (const [title, studio, why] of BLOCKED) {
  add({ id: `blocked-${slug(title)}`, title, year: null, studio, series: 'DO NOT INCLUDE',
    basis: 'BLOCKED', pack: null, status: 'blocked', notes: why, cceVolumes: null });
}

// ── merge & write ───────────────────────────────────────────────────────────
// Re-runnable: an existing row that has been researched is never downgraded.
const RANK = { BLOCKED: 5, GOV: 4, AGE: 3, NR: 2, CC: 2, CLAIMED: 1 };
let prev = {};
if (fs.existsSync(OUT)) {
  for (const r of JSON.parse(fs.readFileSync(OUT, 'utf8')).titles) prev[r.id] = r;
}
const byId = new Map();
for (const r of rows) {
  const old = prev[r.id] || byId.get(r.id);
  if (old && (RANK[old.basis] ?? 0) >= (RANK[r.basis] ?? 0)) {
    byId.set(r.id, { ...r, ...old });   // keep the stronger, researched row
  } else {
    byId.set(r.id, { ...old, ...r });
  }
}
const titles = [...byId.values()].sort((a, b) =>
  (a.studio || '').localeCompare(b.studio || '') ||
  (a.year || 9999) - (b.year || 9999) ||
  a.title.localeCompare(b.title));

const out = { version: 1, titles };
const tally = titles.reduce((m, t) => (m[t.basis] = (m[t.basis] || 0) + 1, m), {});
const stat = titles.reduce((m, t) => (m[t.status] = (m[t.status] || 0) + 1, m), {});
console.log(`${titles.length} titles\n`);
console.log('by basis: ', Object.entries(tally).map(([k, v]) => `${k}=${v}`).join('  '));
console.log('by status:', Object.entries(stat).map(([k, v]) => `${k}=${v}`).join('  '));
const shippable = titles.filter((t) => t.basis !== 'BLOCKED').length;
console.log(`\n${shippable} shippable · ${tally.BLOCKED || 0} blocked`);
if (WRITE) { fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n'); console.log(`\nwrote ${path.relative(ROOT, OUT)}`); }
else console.log('\n(dry run — re-run with --write)');
