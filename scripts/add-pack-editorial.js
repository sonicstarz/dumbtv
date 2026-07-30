#!/usr/bin/env node
// add-pack-editorial.js — the copy the pack detail screen shows.
//
// A pack manifest carried name + description + audience + contentNote, which is
// enough for a one-line row and nothing like enough for a detail page. This adds
// an `editorial` block: a rating, a kid-safe flag, an era, a short history of the
// series, and a synopsis of what is actually in the pack.
//
// Written from the documented history of each series. Where a pack contains
// material that has aged badly — minstrel caricature, wartime propaganda — the
// history says so plainly rather than selling around it. These are presented as
// animation history and the copy should read that way.
//
// Re-runnable: it overwrites `editorial` and touches nothing else.
//
// Usage: node scripts/add-pack-editorial.js [--write]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRITE = process.argv.includes('--write');

// rating: ALL AGES | PG | TEEN | ADULT — a plain-language advisory, not a
// certificate. None of this material was ever rated; inventing an MPAA-looking
// badge would imply a review that never happened.
const EDITORIAL = {
  space: {
    rating: 'ALL AGES', kidSafe: true, era: '1969–2011', tint: 'deepblue',
    history:
      'NASA has filmed and taped nearly everything it has ever done, and because a work made by a US federal employee in the course of their duties has never had copyright at all, essentially all of it is free. No renewal question, no reissue trap — this is the single most certain footing any pack here stands on.',
    synopsis:
      'A permanent loop of the Apollo programme and what came after: the Saturn V rolling out on the crawler, the launch itself, the restored moonwalk in full, the complete Apollo 11 mission film, and the last Space Shuttle launch in 2011. Channel 1, always on, never edited.',
  },
  superman: {
    rating: 'PG', kidSafe: false, era: '1941–1943', tint: 'steel',
    history:
      'Paramount wanted a Superman cartoon and asked Fleischer Studios to make it. Fleischer, hoping to be turned down, quoted roughly four times the going rate — and Paramount said yes, which made these briefly the most expensive animated shorts ever produced. The money is on the screen: Technicolor, rotoscoped human motion, and a moody deco skyline nobody had tried at this scale. The Fleischer brothers were forced out after the first nine; Paramount reorganised the studio as Famous Studios, and the remaining eight turn sharply toward wartime propaganda.',
    synopsis:
      'All 17 shorts in release order, from The Mad Scientist to Secret Agent. Roughly nine minutes each, one self-contained emergency apiece.',
    advisory:
      'Four of the Famous Studios entries lean on wartime racial caricature — Japoteurs, Eleventh Hour and Jungle Drums most heavily. Kept in, tagged individually, and presented as history rather than quietly cut.',
  },
  'popeye-color': {
    rating: 'ALL AGES', kidSafe: true, era: '1936–1939', tint: 'teal',
    history:
      "Fleischer's answer to Disney's move into features. Rather than a feature, Paramount let them make two-reel Technicolor specials at roughly triple the usual length and budget — and they used them to show off the studio's stereoptical process, a rotating three-dimensional miniature set placed behind the animation cels to give real depth on background pans. Nothing else in 1930s animation looks quite like it.",
    synopsis:
      'The three colour two-reelers: Popeye Meets Sindbad the Sailor, Popeye Meets Ali Baba\'s Forty Thieves, and Aladdin and His Wonderful Lamp. These three are the only Popeye films in the public domain — the regular black-and-white shorts are not.',
  },
  'bosko-and-friends': {
    rating: 'PG', kidSafe: false, era: '1929–1931', tint: 'sepia',
    history:
      'This is where Looney Tunes starts. Hugh Harman and Rudolf Ising, both ex-Disney, built a character called Bosko and sold a series to Leon Schlesinger, who sold it on to Warner Bros. The whole point of the line was to plug Warner\'s music catalogue, which is why so much of it is built around a song. Merrie Melodies began as the second series alongside it. Everything Warner animation later became — the timing, the musicality, Carl Stalling\'s scoring — grows out of this run.',
    synopsis:
      'The 1929–31 block in release order: Bosko\'s debut, the first Merrie Melodies, and the earliest Warner shorts to survive into the public domain.',
    advisory:
      'Bosko is a minstrel-derived caricature — that is what the character was in 1929, and this pack does not pretend otherwise. Pre-Code humour throughout. The one Censored Eleven title from this era is excluded outright.',
  },
  'early-disney': {
    rating: 'ALL AGES', kidSafe: true, era: '1928–1929', tint: 'cream',
    history:
      'Walt Disney lost Oswald the Lucky Rabbit to his distributor in 1928 and had to invent a replacement in a hurry. Mickey Mouse was drawn silent; two shorts were made and shopped without success before Disney gambled the studio on adding synchronised sound. Steamboat Willie was the third made and the first released, and it worked so completely that the two silent ones were re-cut with sound and released afterwards.',
    synopsis:
      'Plane Crazy and Steamboat Willie from 1928, plus The Skeleton Dance — the first Silly Symphony, and the first time Disney let the music lead the picture instead of the other way round.',
    advisory:
      'The films are public domain; the CHARACTER is not. Mickey remains a live Disney trademark, so this ships under a neutral channel name with no Disney branding anywhere.',
  },
  'snafu-and-co': {
    rating: 'ADULT', kidSafe: false, era: '1943–1945', tint: 'olive',
    history:
      'The US Army could not get soldiers to read training pamphlets, so it hired the Warner Bros. cartoon unit to make training films instead. Private Snafu — the name is a sanitised expansion of a piece of army slang — does everything wrong so the audience does not have to. Chuck Jones and Frank Tashlin directed, Theodor Geisel wrote most of them in rhyming verse years before he was Dr. Seuss to the general public, Mel Blanc voiced Snafu, and Carl Stalling scored them. They were classified, shown only to troops, and made without copyright because the Army made them.',
    synopsis:
      'All 26 released Private Snafu shorts, the three Mr. Hook Navy films, and three Warner-made government shorts including So Much for So Little, which won the 1949 Academy Award for Documentary Short.',
    advisory:
      'Made for an audience of adult soldiers and it shows: innuendo, pin-ups, heavy wartime propaganda and period racial caricature of Axis nations. Not for a kids\' lineup.',
  },
  'looney-tunes': {
    rating: 'PG', kidSafe: false, era: '1932–1943', tint: 'orange',
    history:
      'The stretch where Warner animation stops imitating Disney and becomes itself. Bosko gives way to Porky Pig, then to a duck and a rabbit who start out loud and abrasive and are gradually refined into Daffy and Bugs. Tex Avery, Bob Clampett, Frank Tashlin and Chuck Jones are all working in the same building. The public-domain run stops dead at Puss n\' Booty in 1943 — everything Warner released after it was renewed and is still under copyright.',
    synopsis:
      'The public-domain Warner run: Porky one-shots, early Daffy and early Bugs, and the Merrie Melodies musical one-offs, including The Dover Boys at Pimento University, A Corny Concerto and Falling Hare.',
    advisory:
      'Pre-Code and wartime humour throughout. A handful of titles carry racial caricature or propaganda and are tagged individually. Original black-and-white prints only — the 1970s redrawn and colorized versions were renewed in 1994 and are deliberately excluded.',
  },
  'saturday-morning': {
    rating: 'PG', kidSafe: true, era: '1932–1937', tint: 'rose',
    history:
      'Betty Boop began in 1930 as a caricature of a jazz-age singer — drawn, at first, with a dog\'s ears. She was rapidly redrawn as human and became the first cartoon character built around an adult woman rather than an animal. The Hays Code caught up with her in 1934 and the studio was made to lengthen her skirt, raise her neckline and put her in domestic settings; the pre-Code shorts and the post-Code ones barely look like the same series.',
    synopsis:
      'Fleischer Betty Boop shorts, including Minnie the Moocher with Cab Calloway performing and rotoscoped into the picture as a ghostly walrus.',
    advisory:
      'Only part of the Betty Boop catalogue is public domain — several were renewed and are excluded.',
  },
  'ad-break': {
    rating: 'ALL AGES', kidSafe: true, era: '1960', tint: 'yellow',
    history:
      'Sponsored films — made by a company to sell something, shown in cinemas, schools and at fairs, and then thrown away. Most were never renewed because nobody thought of them as property worth keeping. They are the best surviving record of what American advertising actually sounded like.',
    synopsis:
      'Period commercials and sponsored films used as ad breaks between programmes.',
  },
};

let changed = 0;
for (const [id, ed] of Object.entries(EDITORIAL)) {
  const file = path.join(ROOT, 'packs', id, 'manifest.json');
  if (!fs.existsSync(file)) { console.warn(`skip ${id}: no manifest`); continue; }
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  m.editorial = ed;
  if (WRITE) fs.writeFileSync(file, JSON.stringify(m, null, 2) + '\n');
  console.log(`${WRITE ? 'wrote' : 'would write'}  ${id.padEnd(20)} ${ed.rating.padEnd(9)} kidSafe=${ed.kidSafe}`);
  changed++;
}
console.log(`\n${changed} pack(s).`);
if (!WRITE) console.log('(dry run — re-run with --write)');
