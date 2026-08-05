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
const COUNT_BANDS = { 'a-few': 5, 'a-dial-full': 10, 'cable-box': 16, 'headend': 40 };

/**
 * Reach a requested channel count by SPLITTING, in order of how good the split
 * is. Without this the planner could never exceed the number of genre
 * neighbourhoods it knows about — about nine — so asking for forty quietly
 * produced eight, which is not a smaller version of what you asked for, it is a
 * different answer.
 *
 * The order matters. A channel that is one show is a real channel — it is how
 * a marathon network works, and it is the split a person would make first. Only
 * when the shows are used up does it fall back to cutting a genre by era, and
 * then to separating films from series. When nothing can be split honestly it
 * STOPS: forty channels out of a library that supports twelve would mean twelve
 * good ones and twenty-eight of three titles each.
 */
function splitToTarget(groups, target, opts = {}) {
  const minPerChannel = opts.minPerChannel ?? 4;
  // Cap how much of the lineup can be one-show channels. Without this the
  // splitter takes the biggest show every round — asking for 16 produced four
  // genre channels and TWELVE single shows, which is a shelf, not a dial.
  // A third is enough to give the big shows their own homes and still leave a
  // lineup that varies.
  const showBudget = opts.showChannels === false ? 0 : Math.max(1, Math.floor(target / 3));
  let showsMade = 0;
  let guard = 0;

  while (groups.size < target && guard++ < 200) {
    // Biggest first — splitting the largest group costs the least.
    const candidates = [...groups.entries()]
      .filter(([, list]) => list.length >= minPerChannel * 2)
      .sort((a, b) => b[1].length - a[1].length);
    if (!candidates.length) break;

    let didSplit = false;
    for (const [key, list] of candidates) {
      // 1 — a big show becomes its own channel.
      if (opts.showChannels !== false && showsMade < showBudget) {
        const big = list
          .filter((t) => t.type === 'show' && (t.episodes || 0) >= 12)
          .sort((a, b) => (b.episodes || 0) - (a.episodes || 0))[0];
        if (big && list.length > minPerChannel) {
          groups.set(`show:${big.key}`, [big]);
          groups.set(key, list.filter((t) => t.key !== big.key));
          showsMade++;
          didSplit = true;
          break;
        }
      }
      // 2 — cut the genre in half by era, at its own median.
      const years = list.map((t) => t.year).filter(Boolean).sort((a, b) => a - b);
      if (years.length >= minPerChannel * 2) {
        const mid = years[Math.floor(years.length / 2)];
        const older = list.filter((t) => (t.year ?? mid) < mid);
        const newer = list.filter((t) => (t.year ?? mid) >= mid);
        if (older.length >= minPerChannel && newer.length >= minPerChannel) {
          groups.delete(key);
          groups.set(`${key}|early`, older);
          groups.set(`${key}|late`, newer);
          didSplit = true;
          break;
        }
      }
      // 3 — films on one channel, series on another.
      const films = list.filter((t) => t.type === 'movie');
      const series = list.filter((t) => t.type === 'show');
      if (films.length >= minPerChannel && series.length >= minPerChannel) {
        groups.delete(key);
        groups.set(`${key}|films`, films);
        groups.set(`${key}|series`, series);
        didSplit = true;
        break;
      }
    }
    if (!didSplit) break;   // nothing left that can be split honestly
  }
  return groups;
}

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

/**
 * Name a channel from the group key that produced it.
 *
 * The splitter invents keys — `show:s39`, `western|early`, `comedy|films` — and
 * naming them mechanically gave "SHOW:S39 CHANNEL", which is a database row
 * with the lights on. Each split shape gets read back into something a person
 * would call it:
 *
 *   show:<key>       →  the show's own title. A channel that IS one show is
 *                       named after the show — that is what a marathon network
 *                       does, and the only honest name for it.
 *   <genre>|early    →  CLASSIC <genre name>          (the older half)
 *   <genre>|late     →  <genre name>                  (the newer half keeps it)
 *   <genre>|films    →  <genre name> PICTURES
 *   <genre>|series   →  <genre name>
 */
function channelName(group, era, list = []) {
  if (group.startsWith('show:')) {
    const t = list[0]?.title;
    if (t) return t.toUpperCase();
  }
  const [base, variant] = group.split('|');
  const stem = NAMES[base] ? NAMES[base](era) : base.toUpperCase();
  // Drop a leading article before prefixing: "CLASSIC THE PLAYHOUSE" is not
  // English, and at 21 characters it also got cut to "CLASSIC THE PLAYHOUS".
  const bare = stem.replace(/^THE /, '');
  switch (variant) {
    case 'early':  return `CLASSIC ${bare}`;
    case 'films':  return `${bare} PICTURES`;
    case 'late':
    case 'series': return stem;
    default:       return NAMES[base] ? stem : `${stem} CHANNEL`;
  }
  // No .slice() here on purpose — the validator's fitName cuts at a WORD
  // boundary and reports the cut as a repair, which is strictly better than a
  // silent mid-word chop.
}

/**
 * Plan a lineup.
 *
 * @param {object} digest  from digest.js
 * @param {object} answers questionnaire document
 * @returns {object} a LineupProposal (docs/ai-lineup-builder.md §5)
 */
export function planRuleBased(digest, answers = {}) {
  // The EXPLICIT number wins. This used to read only the band, so the web UI's
  // channelCountN was collected, sent, and ignored — asking for 12 got you the
  // 'a-dial-full' 10, and asking for 40 got you 16.
  const maxChannels = answers.channelCountN ?? COUNT_BANDS[answers.channelCount] ?? 8;
  const never = new Set((answers.never || []).map(normGenre));
  const loves = new Set((answers.loves || []).map(normGenre));

  const titles = [
    ...digest.shows.map((s) => ({ ...s, type: 'show' })),
    ...digest.movies.map((m) => ({ ...m, type: 'movie' })),
  ].filter((t) => !(t.genres || []).some((g) => never.has(normGenre(g))))
    // ERA. A hard filter, not a nudge — someone who says "the TV I grew up
    // with" and gets a channel of 2019 prestige drama has been ignored. Titles
    // with no year survive either way; a missing year is not evidence.
    .filter((t) => {
      if (!t.year) return true;
      if (answers.era === 'vintage') return t.year < 1980;
      if (answers.era === 'modern') return t.year >= 1980;
      return true;
    });

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

  // Split until there are enough groups to satisfy the request. Packs already
  // become their own channels below, so leave room for them rather than
  // splitting the library to the full number and then trimming packs off.
  const packSlots = answers.packChannels === false ? 0 : (digest.packs || []).length;
  splitToTarget(groups, Math.max(1, maxChannels - packSlots), {
    showChannels: answers.showChannels !== false,
    // "Deep" means fewer, fuller channels; "narrow" tolerates thinner ones to
    // hit a bigger number. The floor is what stops 40 channels of three titles.
    minPerChannel: answers.depth === 'narrow' ? 3 : answers.depth === 'deep' ? 8 : 4,
  });

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
    // MARATHON TOLERANCE. Some people want a channel that is one show all day;
    // some find it claustrophobic. 'never' refuses outright, 'love' takes a
    // third of the weight rather than half.
    const marathonShare = answers.marathons === 'love' ? 0.34
                        : answers.marathons === 'never' ? 2      // unreachable
                        : 0.5;
    const dominant = biggest && (biggest.episodes || 0) >= 20
      && (biggest.episodes || 0) >= totalWeight * marathonShare ? biggest : null;

    // Ordering follows the material, not a preference:
    //   marathon  — one show is most of what this channel has
    //   sequential— mostly episodic, where running order means something
    //   shuffle   — a pile of movies or shorts, where it does not
    const ordering = dominant ? 'marathon'
      : episodic.length > list.length / 2 ? 'sequential'
      : 'shuffle';

    const movieCount = list.length - episodic.length;
    return {
      name: channelName(group, era, list),
      rationale: group.startsWith('show:')
        ? `${list[0]?.title ?? 'One show'}, all day — ${list[0]?.episodes ?? 0} episodes on a loop.`
        : dominant
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

  // ── installed packs are channels in their own right ────────────────────────
  //
  // A pack is CURATED — a named, ordered set with its own editorial voice.
  // Folding it into a genre bucket alongside four hundred cartoons throws that
  // away, so each one gets its own number instead.
  //
  // This is also what makes a fresh install work at all. On an Apple TV with no
  // media server, packs are the ONLY sources, and the genre grouping above sees
  // nothing: planning against two preloaded packs returned "only 0 usable
  // channels survived validation", which is what a new owner would have met on
  // first run. Verified on the tvOS simulator.
  const packChannels = (answers.packChannels === false ? [] : (digest.packs || []))
    .filter((p) => !(answers.kids && p.kidSafe === false))
    .map((p) => ({
      name: String(p.title || 'PACK').toUpperCase(),
      rationale: `${p.items ? `${p.items} titles, ` : ''}kept together the way the pack curates them.`,
      number: null,
      ordering: 'sequential',   // curated order is the point
      marathonSize: 3,
      ads: answers.ads === 'yes' || (answers.ads === 'only-retro' && !!p.year && p.year < 1980),
      dark: null,
      sources: [{ key: p.key, type: 'pack' }],
      tags: ['pack'],
      rules: [],
      _loved: false,
    }));

  // Packs go LAST so that when there are more channels than asked for, the
  // validator's cap trims packs before it trims the person's own library.
  const all = [...channels, ...packChannels].slice(0, maxChannels);

  return {
    version: 1,
    provider: 'rule-based',
    channels: all,
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

