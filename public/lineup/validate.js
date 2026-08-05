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

// validate.js — make a proposal safe before anyone sees it.
//
// This is load-bearing, not defensive. A small local model WILL invent rating
// keys, exceed the channel cap, name two channels the same thing and emit an
// ordering mode that does not exist. None of that is a reason not to use one —
// it is a reason to treat its output as a form to be checked rather than an
// instruction to be followed.
//
// Two lanes, and the difference matters:
//   REPAIR — fix it, and RECORD that we fixed it. Every repair is shown in the
//            review screen. Silently correcting an AI's output is how people
//            end up trusting it more than they should.
//   REJECT — drop the channel, or the whole proposal, with a reason.
//
// Full table: docs/ai-lineup-builder.md §6.

const ORDERINGS = new Set(['sequential', 'release_order', 'shuffle', 'marathon']);
const RULE_KINDS = new Set(['blackout', 'pinned', 'recurring', 'airdate', 'rotation']);
const AIRDATE_MODES = new Set(['original_weekday', 'anniversary', 'original_cadence']);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const tagOk = (t) =>
  typeof t === 'string' && /^[a-z0-9][a-z0-9-]{0,23}$/.test(t);

/**
 * @param {object} proposal  raw, straight from a provider
 * @param {object} digest    the ground truth for what exists
 * @param {object} opts      { maxChannels, minChannels, never }
 * @returns {{proposal:object|null, repairs:string[], fatal:string|null}}
 */
export function validateProposal(proposal, digest, opts = {}) {
  const repairs = [];
  const maxChannels = opts.maxChannels ?? 12;
  // Two, for a LINEUP. The make-me-a-channel path (§17) asks for exactly one and
  // passes 1, and commit passes 1 because by then a person has already looked at
  // it and said yes — "too thin" is a judgement about a draft, not about
  // something already approved.
  const minChannels = opts.minChannels ?? 2;
  const never = new Set((opts.never || []).map((g) => String(g).toLowerCase()));

  if (!proposal || typeof proposal !== 'object' || !Array.isArray(proposal.channels)) {
    return { proposal: null, repairs, fatal: 'not a proposal object' };
  }

  // Everything that exists, by key. A model may only choose from this.
  const known = new Map();
  for (const s of digest.shows) known.set(s.key, { ...s, type: 'show' });
  for (const m of digest.movies) known.set(m.key, { ...m, type: 'movie' });
  for (const p of digest.packs) known.set(p.key, { ...p, type: 'pack' });

  const takenNumbers = new Set(digest.existingChannels.map((c) => c.number));
  const seenNames = new Set();
  const out = [];

  for (const raw of proposal.channels) {
    if (!raw || typeof raw !== 'object') { repairs.push('dropped a channel that was not an object'); continue; }

    // V2 — sources must exist. This is the check that catches invention.
    const sources = [];
    for (const s of raw.sources || []) {
      const key = String(s?.key ?? s ?? '');
      // Title comes from the DIGEST, not the proposal — ground truth the
      // model cannot misspell, and without it every source a build creates
      // would be listed in the config UI by its raw key ("601", "pack:space").
      if (known.has(key)) {
        const k = known.get(key);
        sources.push({ key, type: k.type, title: k.title });
      }
      else repairs.push(`"${raw.name || '?'}": dropped unknown source ${JSON.stringify(key).slice(0, 40)}`);
    }

    // V10 — exclusions enforced AFTER the model, not merely requested of it.
    // "Never show me horror" is a promise the person made to themselves; it
    // cannot depend on a 3B model having paid attention.
    const kept = sources.filter((s) => {
      const g = (known.get(s.key).genres || []).map((x) => String(x).toLowerCase());
      const banned = g.some((x) => never.has(x));
      if (banned) repairs.push(`"${raw.name || '?'}": removed ${known.get(s.key).title} (excluded genre)`);
      return !banned;
    });

    // V3 — a channel with nothing on it is not a channel.
    if (!kept.length) { repairs.push(`dropped "${raw.name || '?'}" — no valid sources left`); continue; }

    // V5 — name: present, trimmed, unique, and short enough for the guide gutter.
    let name = fitName(String(raw.name || '').trim().toUpperCase().replace(/\s+/g, ' '), repairs);
    if (!name) { name = `CHANNEL ${out.length + 1}`; repairs.push('a channel had no name'); }
    if (seenNames.has(name)) {
      // Cut at a word boundary here too. A hard slice(0,17) produced
      // "CLASSIC PRIME TIM 2" and "CLASSIC LAUGH TRA 2" — the same mid-word
      // chop fitName exists to avoid, reintroduced two lines later.
      const base = trimToWord(name, 17);
      let n = 2;
      while (seenNames.has(`${base} ${n}`)) n++;
      repairs.push(`renamed duplicate "${name}" → "${base} ${n}"`);
      name = `${base} ${n}`;
    }
    seenNames.add(name);

    // V4 — ordering.
    let ordering = String(raw.ordering || '').trim();
    if (!ORDERINGS.has(ordering)) {
      if (ordering) repairs.push(`"${name}": unknown ordering "${ordering}" → sequential`);
      ordering = 'sequential';
    }

    // V7 — the model may SUGGEST a number; collisions are dropped and the
    // committer allocates for real. Never let it land on a locked channel.
    let number = Number.isInteger(raw.number) ? raw.number : null;
    if (number !== null && takenNumbers.has(number)) {
      repairs.push(`"${name}": suggested channel ${number}, already taken — will reallocate`);
      number = null;
    }
    if (number !== null) takenNumbers.add(number);

    out.push({
      name,
      rationale: String(raw.rationale || '').trim().slice(0, 240),
      number,
      ordering,
      marathonSize: clampInt(raw.marathonSize, 1, 12, 3),
      ads: !!raw.ads,
      dark: validDark(raw.dark, name, repairs),
      sources: kept,
      tags: (raw.tags || []).map((t) => String(t).toLowerCase()).filter(tagOk).slice(0, 8),
      rules: (raw.rules || []).map((r) => validRule(r, name, repairs)).filter(Boolean),
    });
  }

  // V6 — the channel cap is a constraint the person set, not a suggestion.
  if (out.length > maxChannels) {
    repairs.push(`kept the top ${maxChannels} of ${out.length} channels (you asked for ${maxChannels})`);
    out.length = maxChannels;
  }

  // V12 — a proposal that thin is a failure, not a result. The caller falls back
  // to rule-based rather than showing someone two channels and calling it a
  // lineup.
  if (out.length < minChannels) {
    return { proposal: null, repairs, fatal: `only ${out.length} usable channel(s) survived validation` };
  }

  const itemTags = (proposal.itemTags || [])
    .filter((t) => t && known.has(String(t.key)))
    .map((t) => ({
      key: String(t.key),
      tags: (t.tags || []).map((x) => String(x).toLowerCase()).filter(tagOk).slice(0, 8),
    }))
    .filter((t) => t.tags.length);

  return {
    proposal: {
      version: 1,
      provider: String(proposal.provider || 'unknown'),
      channels: out,
      itemTags,
      notes: String(proposal.notes || '').slice(0, 500),
    },
    repairs,
    fatal: null,
  };
}

function clampInt(v, lo, hi, dflt) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
}

/**
 * Twenty characters is what the guide gutter can hold. Cutting there blindly
 * produces "SUNDAY AFTERNOON COM" — a real result from a real run, and the same
 * mid-word truncation hybrid.js documents a small model doing to itself.
 *
 * Cut at a word boundary instead, and SAY SO. A silently mangled channel name
 * looks like the model's fault forever; a listed repair is something the review
 * screen can show and the person can fix in the box provided.
 */
/**
 * Words that must not be the last thing on a channel name.
 *
 * Cutting at a word boundary is necessary and not sufficient: real show titles
 * gave "THE ADVENTURES OF" and "MARVEL'S THE", which are grammatically
 * suspended — they read as though the sign painter ran out of board. Dropping a
 * trailing article or preposition costs nothing and fixes it.
 */
const DANGLING = new Set(['THE', 'A', 'AN', 'OF', 'AND', 'OR', 'TO', 'IN', 'ON', 'FOR', 'WITH']);

function trimToWord(name, limit) {
  if (name.length <= limit) return name;
  const cut = name.slice(0, limit + 1);
  let out = cut.slice(0, cut.lastIndexOf(' ')).trim();
  // Peel dangling words off the end, but never down to nothing.
  const words = out.split(' ');
  while (words.length > 1 && DANGLING.has(words[words.length - 1])) words.pop();
  out = words.join(' ');
  // If the word-boundary cut left too little to read as a name (one very long
  // word), a hard cut is the lesser evil.
  return out.length >= 6 ? out : name.slice(0, limit);
}

function fitName(name, repairs) {
  if (name.length <= 20) return name;
  const out = trimToWord(name, 20);
  repairs.push(`shortened "${name}" → "${out}" to fit the guide`);
  return out;
}

function validDark(d, name, repairs) {
  if (!d) return null;
  if (HHMM.test(d.start || '') && HHMM.test(d.end || '')) return { start: d.start, end: d.end };
  repairs.push(`"${name}": dropped dark hours that were not HH:MM`);
  return null;
}

/** V9 — a rule that is wrong in any field is dropped whole, never half-applied. */
function validRule(r, name, repairs) {
  if (!r || !RULE_KINDS.has(r.kind)) {
    repairs.push(`"${name}": dropped a rule with kind ${JSON.stringify(r?.kind)}`);
    return null;
  }
  const out = { kind: r.kind };

  if (r.kind === 'recurring' || r.kind === 'blackout') {
    if (!HHMM.test(r.startTime || '')) {
      repairs.push(`"${name}": dropped a ${r.kind} rule — startTime "${r.startTime}" is not HH:MM`);
      return null;
    }
    const days = (Array.isArray(r.daysOfWeek) ? r.daysOfWeek : [])
      .map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
    if (!days.length) {
      repairs.push(`"${name}": dropped a ${r.kind} rule — no valid daysOfWeek`);
      return null;
    }
    out.startTime = r.startTime;
    out.daysOfWeek = [...new Set(days)].sort();
    out.durationMin = clampInt(r.durationMin, 15, 1440, 120);
  }

  if (r.kind === 'airdate') {
    out.airdateMode = AIRDATE_MODES.has(r.airdateMode) ? r.airdateMode : 'original_weekday';
    if (!AIRDATE_MODES.has(r.airdateMode) && r.airdateMode) {
      repairs.push(`"${name}": unknown airdateMode "${r.airdateMode}" → original_weekday`);
    }
  }

  // selectTags is deliberately NOT carried through — see the note at the top
  // of rules.js. A filter that matches nothing is worse than no filter at all.

  if (r.name) out.name = String(r.name).slice(0, 40);
  if (r.ordering && ORDERINGS.has(r.ordering)) out.ordering = r.ordering;
  return out;
}
