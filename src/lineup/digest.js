// digest.js — what the lineup planner sees.
//
// One compact description of a library, built server-side and handed to EVERY
// provider unchanged: the rule-based planner, a local model, an on-device model.
// Feeding them all the same thing is what makes A0's comparison honest — if the
// baseline and the model see different data, "the model did better" means
// nothing.
//
// ── the size trick ──────────────────────────────────────────────────────────
// The digest describes SHOWS AND MOVIES, never episodes. A channel is built from
// sources, so the planner only ever needs to say "these six shows go together";
// the generator expands that into thousands of airings by itself. That is the
// difference between ~20k tokens and a library that cannot be described at all:
// 518 titles fit in one pass, where 40,000 episodes never would.
//
// Episode COUNTS and aired ranges are aggregates, computed here, because "635
// episodes" is exactly the fact that makes a planner say "this show IS a
// channel" — and that judgement is the whole point.

import { db } from '../db.js';
import { getSections, getSectionItems } from '../plex/client.js';
import { setTags, derivedTagsFor } from '../media/tags.js';

/** Roughly how many titles fit one planning pass before it needs clustering. */
export const DIGEST_ONE_PASS_LIMIT = 1500;

/**
 * Build the digest from the live library.
 *
 * `enrich` fetches genres from Plex and stores them as tags with source
 * 'plex' — provenance matters here as much as anywhere else in tags.js: this is
 * PLEX's claim about a title, not the user's ('user') and not ours ('derived'),
 * so a rescan may refresh it freely and a hand-applied tag still outranks it.
 */
export async function buildDigest({ enrich = true } = {}) {
  const sections = await getSections();
  const usable = sections.filter((s) => s.type === 'show' || s.type === 'movie');

  const shows = [];
  const movies = [];
  let missingGenres = 0;

  for (const s of usable) {
    const items = await getSectionItems(s.key, s.type);
    for (const it of items) {
      const genres = it.genres || [];
      if (!genres.length) missingGenres++;
      if (enrich && genres.length) {
        setTags(String(it.ratingKey), genres.map((g) => g.toLowerCase()), 'plex');
      }
      const entry = {
        key: String(it.ratingKey),
        title: it.title,
        year: it.year ?? null,
        genres,
        contentRating: it.contentRating || null,
        runtimeMin: it.duration ? Math.round(it.duration / 60000) : null,
        decade: it.year ? `${Math.floor(it.year / 10) * 10}s` : null,
      };
      if (s.type === 'show') {
        shows.push({ ...entry, episodes: it.leafCount ?? null, seasons: it.childCount ?? null });
      } else {
        movies.push(entry);
      }
    }
  }

  // Packs are sources too, and a planner that ignores them would build a lineup
  // that pretends the shipped channels aren't there.
  const packs = db.prepare('SELECT id, name, kind FROM packs').all()
    .filter((p) => p.kind !== 'ads')
    .map((p) => ({ key: `pack:${p.id}`, title: p.name }));

  // What already exists. The planner is told so it can COMPLEMENT the lineup —
  // and the committer is additive-only regardless, so this is guidance, not a
  // permission slip (the D-3 lesson: an import once cleared the channels table
  // and destroyed SPACE).
  const existingChannels = db
    .prepare('SELECT number, name, locked FROM channels ORDER BY number')
    .all()
    .map((c) => ({ number: c.number, name: c.name, locked: !!c.locked }));

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    counts: { shows: shows.length, movies: movies.length, packs: packs.length },
    // Said out loud rather than left for the planner to discover. A library with
    // no genre data needs the rule-based planner (which degrades to decade and
    // runtime) rather than a model inventing categories it cannot see.
    missingGenres,
    shows,
    movies,
    packs,
    existingChannels,
    tooLargeForOnePass: shows.length + movies.length > DIGEST_ONE_PASS_LIMIT,
  };
}

/** Recompute decade tags for everything the digest just described. */
export function refreshDerivedTags() {
  const rows = db.prepare('SELECT rating_key, aired FROM media').all();
  for (const m of rows) setTags(m.rating_key, derivedTagsFor(m), 'derived');
  return rows.length;
}

/** Rough token cost, so the harness can say whether a library fits one pass. */
export function estimateTokens(digest) {
  // ~4 characters per token is the usual rule of thumb, and close enough for a
  // "does this fit?" question. Deliberately not exact — being exact would mean
  // shipping a tokenizer per provider for a number only used as a warning.
  return Math.round(JSON.stringify(digest).length / 4);
}
