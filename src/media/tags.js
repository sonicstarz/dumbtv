// tags.js — what a piece of media IS, so a rule can select by it (R8).
//
// Channels have always been built by hand-picking sources. Tags are the other
// half: "everything tagged cartoon", which is what makes DAYPARTING (R1)
// possible — a daypart needs a subset to draw from, and until now a rule could
// only name one rating_key.
//
// ── why a table and not a CSV column ─────────────────────────────────────────
// `channels.ad_tags` is a CSV string and that is correct there: it is only ever
// read for one channel. These are QUERIED across the library ("find everything
// tagged cartoon"), so they get a table and an index. Copying the CSV pattern
// here would mean a LIKE scan of the media table on every generation.
//
// ── provenance matters more than it looks ───────────────────────────────────
// `source` records WHO said so:
//   user    — applied by hand. A rescan must NEVER touch these. Losing a
//             hand-curated tag because a pack was reinstalled would be
//             infuriating and impossible to notice.
//   pack    — declared by a pack manifest. Build 15 added per-item `tags` to
//             the manifests, so the preload lineup arrives already tagged and
//             dayparting works out of the box with no user effort.
//   derived — computed from what we know (decade from `aired`). Recomputed
//             freely, never worth preserving.
//   plex    — what the MEDIA SERVER says a title is. Genres, essentially.
//             Deliberately its own source and not 'derived': a derived tag is
//             something we worked out and may recompute differently tomorrow,
//             whereas this is a third party's claim that we are relaying. It
//             refreshes on rescan like 'derived', but if it is ever wrong the
//             answer is to fix it upstream, not to argue with it here.
//   ai      — a model's opinion, from the lineup builder. Same refresh
//             behaviour as 'pack'; kept separate so every AI-applied tag can be
//             removed in one statement by someone who disagrees with all of it.
//
// Provenance is the whole point of the column: `user` outranks everything and
// is never touched by any automated pass.

import { db } from '../db.js';

export const TAG_SOURCES = ['user', 'pack', 'derived', 'plex', 'ai'];

const insertTag = db.prepare(
  'INSERT OR REPLACE INTO media_tags (rating_key, tag, source) VALUES (?,?,?)'
);
const deleteBySource = db.prepare(
  'DELETE FROM media_tags WHERE rating_key = ? AND source = ?'
);

/** Normalise: lowercase, trimmed, no empties, no duplicates. */
export function normalizeTags(tags) {
  const out = new Set();
  for (const t of tags || []) {
    const s = String(t || '').trim().toLowerCase();
    if (s) out.add(s);
  }
  return [...out].sort();
}

/**
 * Replace one media item's tags FOR ONE SOURCE, leaving the other sources
 * alone. This is the whole point of the provenance column: reinstalling a pack
 * refreshes its own tags without disturbing anything applied by hand.
 */
export const setTags = db.transaction((ratingKey, tags, source = 'user') => {
  if (!TAG_SOURCES.includes(source)) throw new Error(`unknown tag source: ${source}`);
  deleteBySource.run(String(ratingKey), source);
  for (const t of normalizeTags(tags)) insertTag.run(String(ratingKey), t, source);
});

/** Every tag on an item, from every source, deduped. */
export function tagsFor(ratingKey) {
  return db.prepare('SELECT DISTINCT tag FROM media_tags WHERE rating_key = ? ORDER BY tag')
    .all(String(ratingKey)).map((r) => r.tag);
}

/** The whole vocabulary in use, with counts — for the tag picker. */
export function allTags() {
  return db.prepare(
    `SELECT tag, COUNT(DISTINCT rating_key) AS n FROM media_tags GROUP BY tag ORDER BY n DESC, tag`
  ).all();
}

/**
 * Tags implied by what we already know about an item. Kept deliberately small:
 * a decade is a fact, a genre is a guess, and this project does not do metadata
 * lookups (the no-network-metadata rule from Track I).
 */
export function derivedTagsFor(media) {
  const out = [];
  const year = parseInt(String(media.aired || '').slice(0, 4), 10);
  if (Number.isFinite(year) && year > 1800) out.push(`${Math.floor(year / 10) * 10}s`);
  if (media.kind === 'movie') out.push('movie');
  if (media.kind === 'episode') out.push('episode');
  const mins = Math.round((media.duration_ms || 0) / 60000);
  if (mins > 0 && mins <= 15) out.push('short');
  if (mins >= 70) out.push('feature');
  return normalizeTags(out);
}

/** Recompute derived tags for every media row. Cheap; safe to run on demand. */
export const refreshDerivedTags = db.transaction(() => {
  const rows = db.prepare('SELECT rating_key, kind, aired, duration_ms FROM media').all();
  let n = 0;
  for (const m of rows) {
    setTags(m.rating_key, derivedTagsFor(m), 'derived');
    n++;
  }
  return n;
});

/**
 * The rating_keys matching a tag selection.
 *   mode 'any' — has at least one of these tags (the useful default)
 *   mode 'all' — has every one of them
 */
export function keysMatchingTags(tags, mode = 'any') {
  const list = normalizeTags(tags);
  if (list.length === 0) return null;         // null = "no filter", not "nothing"
  const placeholders = list.map(() => '?').join(',');
  const rows = mode === 'all'
    ? db.prepare(
        `SELECT rating_key FROM media_tags WHERE tag IN (${placeholders})
         GROUP BY rating_key HAVING COUNT(DISTINCT tag) = ?`
      ).all(...list, list.length)
    : db.prepare(
        `SELECT DISTINCT rating_key FROM media_tags WHERE tag IN (${placeholders})`
      ).all(...list);
  // Sorted so downstream iteration order never depends on SQLite's plan —
  // the determinism gate exists to catch exactly this class of mistake.
  return new Set(rows.map((r) => r.rating_key).sort());
}
