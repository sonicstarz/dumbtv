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
 * @param {object} opts      { maxChannels, never }
 * @returns {{proposal:object|null, repairs:string[], fatal:string|null}}
 */
export function validateProposal(proposal, digest, opts = {}) {
  const repairs = [];
  const maxChannels = opts.maxChannels ?? 12;
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
      if (known.has(key)) sources.push({ key, type: known.get(key).type });
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
    let name = String(raw.name || '').trim().toUpperCase().slice(0, 20);
    if (!name) { name = `CHANNEL ${out.length + 1}`; repairs.push('a channel had no name'); }
    if (seenNames.has(name)) {
      const base = name.slice(0, 17);
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
  if (out.length < 2) {
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

  const tags = (r.selectTags || []).map((t) => String(t).toLowerCase()).filter(tagOk);
  if (tags.length) {
    out.selectTags = tags;
    out.selectMode = r.selectMode === 'all' ? 'all' : 'any';
  }
  if (r.name) out.name = String(r.name).slice(0, 40);
  if (r.ordering && ORDERINGS.has(r.ordering)) out.ordering = r.ordering;
  return out;
}
