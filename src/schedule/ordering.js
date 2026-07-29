import { db } from '../db.js';
import { seededShuffle, hashString } from '../util/rng.js';
import { keysMatchingTags } from '../media/tags.js';

// A source is either a container (parent_key — a show, a pack, a folder) or a
// single item (rating_key). Both columns are indexed, but SQLite will not use
// both arms of an OR, so the disjunction scans the whole media table — once per
// source, per channel. UNION ALL gets two index lookups instead.
const selectSourceMedia = db.prepare(`
  SELECT * FROM (
    SELECT m.* FROM media m WHERE m.parent_key = ?
    UNION ALL
    SELECT m.* FROM media m WHERE m.rating_key = ?
  )
  ORDER BY COALESCE(season_no, 0), COALESCE(episode_no, 0), title
`);

function bySeasonEpisode(a, b) {
  const s = (a.season_no ?? 0) - (b.season_no ?? 0);
  if (s !== 0) return s;
  const e = (a.episode_no ?? 0) - (b.episode_no ?? 0);
  if (e !== 0) return e;
  return String(a.title).localeCompare(String(b.title));
}

function byAirDate(a, b) {
  const av = a.aired || '9999-99-99';
  const bv = b.aired || '9999-99-99';
  if (av !== bv) return av < bv ? -1 : 1;
  return bySeasonEpisode(a, b);
}

/** One array of playable rows per source, each already in its natural order.
 *
 *  THE one place content is filtered. Exclusions, tag selection (R8) and
 *  content warnings all narrow the pool HERE, before rotation, cooldown and
 *  airing counts ever see an item — which is what keeps those correct for free.
 *  Filtering anywhere downstream would make a skipped episode still count as
 *  aired. Do not add a second filter site.
 *
 *  @param {{tags?: string[], tagMode?: 'any'|'all'}} [opts] narrows the pool
 *         further for a daypart; omitted means the channel's whole library.
 */
function loadSourceBuckets(channelId, opts = {}) {
  const sources = db
    .prepare('SELECT * FROM channel_sources WHERE channel_id = ? ORDER BY id')
    .all(channelId);

  const excluded = new Set(
    db
      .prepare('SELECT rating_key FROM channel_excludes WHERE channel_id = ?')
      .all(channelId)
      .map((r) => r.rating_key)
  );

  // null means "no tag filter"; an empty Set would mean "nothing matches".
  const tagged = opts.tags && opts.tags.length
    ? keysMatchingTags(opts.tags, opts.tagMode || 'any')
    : null;

  // Content warnings the channel refuses to air (PD Packs Task 2). Same choke
  // point as everything else, so an excluded item never counts as aired.
  const refused = new Set(
    String(
      db.prepare('SELECT exclude_warnings FROM channels WHERE id = ?').get(channelId)?.exclude_warnings || ''
    ).split(',').map((w) => w.trim().toLowerCase()).filter(Boolean)
  );
  const carriesRefusedWarning = (row) => {
    if (refused.size === 0 || !row.content_warnings) return false;
    return String(row.content_warnings).split(',')
      .some((w) => refused.has(w.trim().toLowerCase()));
  };

  return sources
    .map((s) => {
      const rows = selectSourceMedia
        .all(s.rating_key, s.rating_key)
        .filter((r) => !excluded.has(r.rating_key))
        .filter((r) => !tagged || tagged.has(r.rating_key))
        .filter((r) => !carriesRefusedWarning(r));
      return { source: s, items: rows.sort(bySeasonEpisode) };
    })
    .filter((b) => b.items.length > 0);
}

/**
 * The full ordered playlist for a channel. The generator walks this with a
 * monotonic cursor and wraps at the end, so a channel never runs dry.
 *
 *  sequential    round-robin across shows, each advancing in episode order
 *  release_order everything sorted by original air date
 *  shuffle       seeded permutation, reshuffled each cycle
 *  marathon      N in a row from one show, then rotate
 */
export function buildPlaylist(channel, cycle = 0, opts = {}) {
  const buckets = loadSourceBuckets(channel.id, opts);
  if (buckets.length === 0) return [];

  const mode = channel.ordering_mode;

  if (mode === 'release_order') {
    return buckets.flatMap((b) => b.items).sort(byAirDate);
  }

  if (mode === 'shuffle') {
    const all = buckets.flatMap((b) => b.items);
    const seed =
      (channel.shuffle_seed >>> 0) ^
      hashString(`${channel.id}:${cycle}`);
    return seededShuffle(all, seed);
  }

  if (mode === 'marathon') {
    const size = Math.max(1, channel.marathon_size || 3);
    const out = [];
    const idx = buckets.map(() => 0);
    let exhausted = 0;
    let b = 0;
    while (exhausted < buckets.length) {
      const bucket = buckets[b];
      if (idx[b] < bucket.items.length) {
        for (let n = 0; n < size && idx[b] < bucket.items.length; n++) {
          out.push(bucket.items[idx[b]++]);
        }
        if (idx[b] >= bucket.items.length) exhausted++;
      }
      b = (b + 1) % buckets.length;
      if (out.length > 20000) break; // paranoia
    }
    return out;
  }

  // sequential: round-robin, one episode per show per pass
  const out = [];
  const idx = buckets.map(() => 0);
  let remaining = buckets.reduce((n, b) => n + b.items.length, 0);
  let b = 0;
  while (remaining > 0) {
    const bucket = buckets[b];
    if (idx[b] < bucket.items.length) {
      out.push(bucket.items[idx[b]++]);
      remaining--;
    }
    b = (b + 1) % buckets.length;
  }
  return out;
}

export const ORDERING_MODES = [
  {
    id: 'sequential',
    label: 'Sequential',
    blurb: 'Rotates through your shows, each one advancing episode by episode.',
  },
  {
    id: 'release_order',
    label: 'Release order',
    blurb: 'Everything sorted by original air date. Feels like syndication.',
  },
  {
    id: 'shuffle',
    label: 'Shuffle',
    blurb: 'Random, but locked in — the printed guide always matches.',
  },
  {
    id: 'marathon',
    label: 'Marathon',
    blurb: 'A few episodes of one show in a row, then on to the next.',
  },
];
