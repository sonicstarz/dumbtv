// hybrid.js — rules choose the material, the model does the writing.
//
// ── why this exists (A0's actual finding) ───────────────────────────────────
// Asked to build a lineup from a 520-title catalog, llama3.2:3b returned five
// channels with genuinely sensible THEMES — "animated-comedy", "western-drama",
// matching the stated tastes — and completely EMPTY source lists. Not wrong
// keys: none at all. It understood the job and could not do the mechanical part.
//
// That is a specific, repeatable failure and it points somewhere useful: a small
// model is good at judgement over a short list and bad at grounding in a long
// one. So stop asking it to do the part it is bad at. The rule-based planner
// already groups the library deterministically; the model is handed those groups
// — a handful of lines, not 20k tokens — and asked only for the things it is
// actually better at than a lookup table:
//
//     · a channel NAME with some character
//     · a RATIONALE addressed to the owner
//     · which daypart, if any, this channel belongs in
//
// Source selection never leaves deterministic code, so a hallucinated key cannot
// exist by construction rather than by validation. This is also the shape that
// suits Apple's on-device model (~3B, guided generation), which is the primary
// provider on Apple hardware — the same reasoning, arrived at from a different
// direction.

import { planRuleBased } from './rule-based.js';

const TIMEOUT_MS = 90_000;

const SYSTEM = `You name television channels.

You are given channels that have ALREADY been assembled from someone's media library, plus what they told us about their taste. You do not choose the content — that is done. You write the presentation.

For each channel return:
  name      — 20 characters or fewer, uppercase, sounds like a station ident, NOT a genre label. "SATURDAY MORNING" beats "ANIMATION CHANNEL".
  rationale — ONE sentence, addressed to the owner, saying why this earns a number on their dial.
  daypart   — one of: morning, afternoon, evening, latenight, any.

Return the SAME NUMBER of channels, in the SAME ORDER. Never invent a channel.`;

const SCHEMA = {
  type: 'object',
  required: ['channels'],
  properties: {
    channels: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'rationale', 'daypart'],
        properties: {
          name: { type: 'string' },
          rationale: { type: 'string' },
          daypart: { type: 'string', enum: ['morning', 'afternoon', 'evening', 'latenight', 'any'] },
        },
      },
    },
  },
};

const DAYPART_RULE = {
  morning:   { startTime: '07:00', durationMin: 300, daysOfWeek: [0, 1, 2, 3, 4, 5, 6] },
  afternoon: { startTime: '12:00', durationMin: 300, daysOfWeek: [0, 1, 2, 3, 4, 5, 6] },
  evening:   { startTime: '19:00', durationMin: 240, daysOfWeek: [0, 1, 2, 3, 4, 5, 6] },
  latenight: { startTime: '23:00', durationMin: 240, daysOfWeek: [0, 1, 2, 3, 4, 5, 6] },
};

/**
 * Plan with rules, then let a model dress it. Falls back to the rule-based
 * proposal untouched if the model is unreachable or answers badly — the lineup
 * is already valid before the model is ever asked, which is the point.
 */
export async function planHybrid(digest, answers, { model = 'llama3.2:3b', base = process.env.DUMBTV_OLLAMA || 'http://127.0.0.1:11434' } = {}) {
  const draft = planRuleBased(digest, answers);

  // A few lines per channel: what it is, how big, and a taste of what is on it.
  // Short enough that a small model can hold all of it.
  const samples = draft.channels.map((c) =>
    c.sources.slice(0, 6).map((s) => titleOf(digest, s.key)).filter(Boolean));

  const brief = draft.channels.map((c, i) =>
    `${i + 1}. theme=${c.tags[0]} era=${c.tags[1] || 'mixed'} ` +
    `titles=${c.sources.length} ordering=${c.ordering}\n   e.g. ${samples[i].join(', ')}`
  ).join('\n');

  let dressed = null;
  try {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model, stream: false, format: SCHEMA,
        options: { num_ctx: 8192, temperature: 0.8 },
        keep_alive: '5m',
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content:
            `THEIR TASTE:\n${JSON.stringify(answers)}\n\nCHANNELS TO NAME:\n${brief}` },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) dressed = JSON.parse((await res.json())?.message?.content ?? 'null');
  } catch { /* the draft stands on its own */ }

  const named = dressed?.channels;
  if (!Array.isArray(named) || named.length !== draft.channels.length) {
    return { ...draft, provider: `hybrid:${model} (model declined; rules only)` };
  }

  return {
    ...draft,
    provider: `hybrid:${model}`,
    channels: draft.channels.map((c, i) => {
      const d = named[i] || {};
      const name = channelNameFrom(d.name, samples[i], c.name);
      const rules = [...c.rules];
      const dp = DAYPART_RULE[d.daypart];
      // Only add a daypart when the model asked for a real one AND the channel
      // does not already carry a recurring rule from the answers — the person's
      // own stated rhythm outranks the model's opinion about it.
      if (dp && !rules.some((r) => r.kind === 'recurring')) {
        rules.push({ kind: 'recurring', name: d.daypart, ...dp, selectTags: [c.tags[0]], selectMode: 'any' });
      }
      return {
        ...c,
        name,
        rationale: String(d.rationale || c.rationale).trim().slice(0, 240),
        rules,
      };
    }),
  };
}

function titleOf(digest, key) {
  const hit = digest.shows.find((s) => s.key === key) || digest.movies.find((m) => m.key === key);
  return hit?.title;
}

/**
 * Take the model's channel name, unless it just handed back one of the example
 * titles.
 *
 * IT DOES THIS CONSTANTLY. Shown "e.g. 8 Out of 10 Cats Does Countdown, …" the
 * 3B model named the channel "8 OUT OF 10 CATS DOE" — the sample truncated at
 * twenty characters, mid-word. Also "THE YOUNG RIDERS", "GRAND DESIGNS", "ALL
 * CREATURES GREAT". Naming a channel after one show on it is wrong even when it
 * is not truncated: the channel is the group, not its first member.
 *
 * The examples cannot simply be withheld — they are what makes the RATIONALES
 * good ("ride into the weekend with classic westerns" needs to know it is
 * westerns). So keep showing them and reject this specific failure instead.
 */
function channelNameFrom(raw, samples, fallback) {
  const name = String(raw || '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (!name) return fallback;

  const echoesATitle = samples.some((t) => {
    const up = t.toUpperCase();
    // Either direction: the model may echo a title whole, or a truncation of it.
    return up.startsWith(name.slice(0, 12)) || name.startsWith(up.slice(0, 12));
  });
  if (echoesATitle) return fallback;

  if (name.length <= 20) return name;
  // Too long: cut at a word boundary rather than mid-word, and only keep the
  // result if enough survives to still read as a name.
  const cut = name.slice(0, 20);
  const atSpace = cut.slice(0, cut.lastIndexOf(' '));
  return atSpace.length >= 6 ? atSpace : fallback;
}
