// ─────────────────────────────────────────────────────────────────────────────
// SHARED MODULE. Loaded by the browser from public/, and imported directly by
// scripts/ under Node for tests. It must therefore use nothing platform-
// specific: no fs, no db, no DOM. Anything that touches the outside world
// arrives as an injected `api` or `fetch`.
//
// This is deliberate and it is the whole point. The lineup builder used to live
// in src/ and run on the Node server, which meant the Apple apps — the actual
// v1 product — could not have it without a second implementation in Swift. The
// builder only ever needs endpoints that BOTH backends already serve, so
// running it in the config UI makes it work everywhere with no port at all,
// and there is only ever one copy of the logic to be wrong.
// ─────────────────────────────────────────────────────────────────────────────

// rules.js — build a lineup with no AI at all.
//
// NO TAG FILTERS ON RULES. The server-side ancestor of this file emitted
// `selectTags` on its dayparts and wrote matching rows into `media_tags`. Both
// halves of that are gone: ConfigAPI has no selectTags field and the Swift
// schema has no media_tags table, so on an Apple TV the filter would be
// silently dropped — and on Node it would match nothing, because nothing writes
// the tags any more, blanking that daypart into dead air.
//
// It was redundant anyway. A filter saying "during mornings, pick the
// animation" is pointless on a channel whose every source is animation. The
// channel already IS the theme; the rule only needs to say WHEN.

//
// This exists for three reasons, and it would be worth shipping for any one of
// them:
//
//   1. It turns "linked to Plex" into "a working television" in one press,
//      which is the actual problem the AI feature was asked to solve.
//   2. It is the FALLBACK whenever a model is unreachable, too slow, or returns
//      something that fails validation — on every platform, offline, forever.
//   3. It is the BASELINE. If a language model cannot clearly beat genre-and-era
//      grouping, the honest answer is to ship this alone and stop. Having the
//      baseline is what makes that judgement possible instead of rhetorical.
//
// Every step is a pure function of (digest, answers): same inputs, same lineup.
// That is not incidental — it is what lets A0 compare providers repeatably, and
// it matches invariant #5's spirit at the layer above scheduling.


/** Channel-count bands, from the questionnaire's Q8. */
const COUNT_BANDS = { 'a-few': 5, 'a-dial-full': 10, 'cable-box': 16 };

/**
 * Genres that mean roughly the same thing for the purpose of "do these belong
 * on one channel". Deliberately small and hand-written: this is the kind of
 * table that rots the moment it tries to be complete, and its whole job is to
 * stop a library fragmenting into fifteen channels of two titles each.
 */
const NEIGHBOURS = [
  ['action', 'adventure', 'thriller', 'war', 'crime'],
  ['comedy', 'sitcom', 'stand-up'],
  ['sci-fi', 'science fiction', 'fantasy'],
  ['animation', 'cartoon', 'anime', 'family', 'kids'],
  ['documentary', 'biography', 'history', 'news'],
  ['drama', 'romance'],
  ['horror', 'mystery'],
  ['western'],
  ['music', 'musical'],
];

const normGenre = (g) => String(g || '').trim().toLowerCase();

function neighbourhood(genre) {
  const g = normGenre(genre);
  const row = NEIGHBOURS.find((r) => r.includes(g));
  return row ? row[0] : g;
}

/** Names that sound like a channel rather than a database query. */
const NAMES = {
  animation: (era) => (era && era < 1970 ? 'SATURDAY MORNING' : 'CARTOON'),
  western: () => 'FRONTIER',
  horror: () => 'CREATURE FEATURE',
  'sci-fi': () => 'OUTER LIMITS',
  documentary: () => 'THE RECORD',
  comedy: () => 'LAUGH TRACK',
  drama: () => 'THE PLAYHOUSE',
  action: () => 'PRIME TIME',
  music: () => 'THE JUKEBOX',
};

const channelName = (group, era) =>
  (NAMES[group] ? NAMES[group](era) : `${group.toUpperCase()} CHANNEL`).slice(0, 20);

/**
 * Plan a lineup.
 *
 * @param {object} digest  from digest.js
 * @param {object} answers questionnaire document
 * @returns {object} a LineupProposal (docs/ai-lineup-builder.md §5)
 */
export function planRuleBased(digest, answers = {}) {
  const maxChannels = COUNT_BANDS[answers.channelCount] ?? 8;
  const never = new Set((answers.never || []).map(normGenre));
  const loves = new Set((answers.loves || []).map(normGenre));

  const titles = [
    ...digest.shows.map((s) => ({ ...s, type: 'show' })),
    ...digest.movies.map((m) => ({ ...m, type: 'movie' })),
  ].filter((t) => !(t.genres || []).some((g) => never.has(normGenre(g))));

  // Group by genre neighbourhood. A title with no genre at all falls back to its
  // decade, which is a fact we always have — this is exactly where the
  // rule-based planner degrades more gracefully than a model, because it never
  // has to pretend it knows what an untagged file is.
  const groups = new Map();
  for (const t of titles) {
    const g = t.genres?.length ? neighbourhood(t.genres[0]) : (t.decade || 'assorted');
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(t);
  }

  // Fold anything too thin to be a channel into its nearest neighbour, else into
  // a catch-all. Three titles is the floor: two is a loop you notice.
  const MIN = 3;
  const thin = [];
  for (const [g, list] of [...groups]) {
    if (list.length < MIN) { thin.push(...list); groups.delete(g); }
  }
  if (thin.length) {
    const target = groups.size ? [...groups.keys()][0] : 'assorted';
    if (!groups.has(target)) groups.set(target, []);
    groups.get(target).push(...thin);
  }

  // Rank: what the person said they love first, then sheer weight of material —
  // a channel needs enough to not repeat within an evening.
  const ranked = [...groups.entries()]
    .map(([g, list]) => ({
      group: g,
      list,
      loved: [...loves].some((l) => neighbourhood(l) === g),
      weight: list.reduce((n, t) => n + (t.episodes || 1), 0),
    }))
    .sort((a, b) => (b.loved - a.loved) || (b.weight - a.weight))
    .slice(0, maxChannels);

  const channels = ranked.map(({ group, list, loved }) => {
    // TYPICAL year, not the earliest. Taking the minimum let a single 1930s
    // short label a channel of modern drama "1930s", which then picked the
    // wrong name and the wrong ad policy. A median describes the group.
    const years = list.map((t) => t.year).filter(Boolean).sort((a, b) => a - b);
    const era = years.length ? years[Math.floor(years.length / 2)] : null;

    const episodic = list.filter((t) => t.type === 'show');
    const totalWeight = list.reduce((n, t) => n + (t.episodes || 1), 0);
    // A marathon channel is one where a single show IS most of the material.
    // The first cut asked only "does any show have >30 episodes?", which made
    // EVERY channel a marathon — one 51-episode cartoon among 40 titles is not
    // a marathon, it is a big show on a normal channel. Require it to carry
    // most of the weight AND the group to be genuinely episodic.
    const biggest = episodic.slice().sort((a, b) => (b.episodes || 0) - (a.episodes || 0))[0];
    const dominant = biggest && (biggest.episodes || 0) >= 20
      && (biggest.episodes || 0) >= totalWeight * 0.5 ? biggest : null;

    // Ordering follows the material, not a preference:
    //   marathon  — one show is most of what this channel has
    //   sequential— mostly episodic, where running order means something
    //   shuffle   — a pile of movies or shorts, where it does not
    const ordering = dominant ? 'marathon'
      : episodic.length > list.length / 2 ? 'sequential'
      : 'shuffle';

    const movieCount = list.length - episodic.length;
    return {
      name: channelName(group, era),
      rationale: dominant
        ? `${dominant.title} is most of this channel at ${dominant.episodes} episodes — the rest rides along.`
        : `${list.length} ${group} titles${movieCount && episodic.length
            ? ` — ${episodic.length} shows and ${movieCount} films`
            : ''}${era ? `, mostly ${Math.floor(era / 10) * 10}s` : ''}.`,
      number: null,
      ordering,
      marathonSize: 3,
      ads: answers.ads === 'yes' || (answers.ads === 'only-retro' && !!era && era < 1980),
      dark: null,
      sources: list.slice(0, 40).map((t) => ({ key: t.key, type: t.type })),
      tags: [group, ...(era ? [`${Math.floor(era / 10) * 10}s`] : [])],
      rules: buildRules(group, list, answers),
      _loved: loved,
    };
  });

  return {
    version: 1,
    provider: 'rule-based',
    channels,
    itemTags: titles.map((t) => ({
      key: t.key,
      tags: [...(t.genres || []).map(normGenre), t.decade].filter(Boolean),
    })),
    notes: digest.missingGenres
      ? `${digest.missingGenres} titles had no genre in Plex and were grouped by decade.`
      : '',
  };
}

/**
 * Dayparts and airdate rules, only where the answers asked for them and the
 * material actually supports them.
 */
function buildRules(group, list, answers) {
  const rules = [];

  if (answers.rhythm && answers.rhythm !== 'no') {
    const morning = (answers.dayparts?.morning || []).map(neighbourhood);
    const evening = (answers.dayparts?.evening || []).map(neighbourhood);
    if (morning.includes(group)) {
      rules.push({
        kind: 'recurring', name: 'Mornings',
        daysOfWeek: [0, 6], startTime: '07:00', durationMin: 300,
      });
    }
    if (evening.includes(group)) {
      rules.push({
        kind: 'recurring', name: 'Evenings',
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6], startTime: '20:00', durationMin: 180,
      });
    }
  }

  // Original air dates only where the material can actually support it. Asking
  // for airdate scheduling on a pile of titles with no aired dates produces a
  // channel that cannot fill itself, which is worse than not offering it.
  if (answers.airdates && answers.airdates !== 'no') {
    const withYear = list.filter((t) => t.year).length;
    if (withYear / list.length >= 0.8) {
      rules.push({ kind: 'airdate', airdateMode: 'original_weekday' });
    }
  }
  return rules;
}

