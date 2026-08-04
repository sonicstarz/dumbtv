// ─────────────────────────────────────────────────────────────────────────────
// SHARED MODULE. Loaded by the browser from public/, and imported directly by
// scripts/ under Node for tests. No fs, no db, no DOM — everything that touches
// the outside world arrives as an injected `api`.
// ─────────────────────────────────────────────────────────────────────────────

// digest.js — what the planner is allowed to know about your library.
//
// The server-side version of this read SQLite and called Plex directly, which
// is exactly why it could never run on an Apple TV. This one asks the device
// the same questions over HTTP, using endpoints that Node and ConfigAPI have
// both served since long before this feature existed:
//
//     GET /api/library/sections
//     GET /api/library/sections/:key/items?type=show|movie
//     GET /api/packs
//     GET /api/channels
//
// So it works, unchanged, against a Pi, a Docker container, a Mac, an iPad or
// an Apple TV. There is no second implementation to keep in step.
//
// SHOWS AND FILMS ONLY, NEVER EPISODES. A channel source is a show; expanding
// to episodes would multiply the catalog by fifty and blow the context window
// for no gain — the planner picks shows, and the scheduler picks episodes.

/** Genres are the one fact the planner can't invent. Absent is reported, not guessed. */
const genresOf = (it) => (it.genres || []).map((g) => String(g).toLowerCase()).filter(Boolean);

/**
 * Build the digest.
 *
 * @param {object} opts
 * @param {(path:string)=>Promise<any>} opts.api   fetch-and-parse for this device
 * @param {(done:number,total:number,label:string)=>void} [opts.onProgress]
 */
export async function buildDigest({ api, onProgress } = {}) {
  const shows = [];
  const movies = [];
  let missingGenres = 0;

  let sections = [];
  try {
    sections = (await api('/api/library/sections')).sections || [];
  } catch (err) {
    // No media server linked is an ordinary state, not a crash — packs alone
    // are enough to build a lineup from, and someone with no Plex at all
    // should still get a working television.
    sections = [];
  }

  let done = 0;
  for (const sec of sections) {
    // A section is a movie section or a show section; asking for the wrong type
    // returns nothing at all, which is how the first run of this quietly
    // produced an empty digest against a real 437-film library.
    const type = sec.type === 'movie' ? 'movie' : 'show';
    onProgress?.(done, sections.length, sec.title);
    let items = [];
    try {
      items = (await api(`/api/library/sections/${encodeURIComponent(sec.key)}/items?type=${type}`)).items || [];
    } catch { items = []; }

    for (const it of items) {
      const genres = genresOf(it);
      if (!genres.length) missingGenres++;
      const entry = {
        key: String(it.ratingKey),
        title: it.title,
        year: it.year ?? null,
        genres,
        section: sec.title,
      };
      if (type === 'movie') movies.push(entry);
      else shows.push({ ...entry, episodes: it.leafCount ?? null });
    }
    done++;
  }
  onProgress?.(done, sections.length, '');

  // Installed packs are sources too (C3), and for someone with no media server
  // they are the ONLY sources — so a digest without them would tell the planner
  // the library is empty when it demonstrably is not.
  let packs = [];
  try {
    packs = ((await api('/api/packs')).packs || [])
      .filter((p) => p.installed)
      .map((p) => ({ key: `pack:${p.id}`, title: p.name, genres: [] }));
  } catch { packs = []; }

  // What already exists, so the validator can refuse to collide with it.
  let existingChannels = [];
  try {
    existingChannels = ((await api('/api/channels')).channels || [])
      .map((c) => ({ number: c.number, name: c.name }));
  } catch { existingChannels = []; }

  return {
    shows,
    movies,
    packs,
    existingChannels,
    counts: { shows: shows.length, movies: movies.length, packs: packs.length },
    missingGenres,
    // A rough guard so nobody sends a 20k-title library at a model and waits
    // two minutes to be told it didn't fit.
    get tooLargeForOnePass() { return estimateTokens(this) > 120_000; },
  };
}

/** Roughly four characters to the token — good enough to warn, not to bill. */
export function estimateTokens(digest) {
  const n = (a) => a.reduce((sum, t) => sum + (t.title?.length || 0) + 24, 0);
  return Math.round((n(digest.shows) + n(digest.movies) + n(digest.packs)) / 4);
}
