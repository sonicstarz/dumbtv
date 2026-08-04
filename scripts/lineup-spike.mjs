#!/usr/bin/env node
// lineup-spike.mjs — A0. Is a model's lineup CLEARLY better than plain rules?
//
// No UI, no product code paths, nothing written to the database. It builds the
// digest from the real library, runs every available provider over the SAME
// digest and the SAME answers, validates each result identically, and prints the
// lineups side by side for a human to judge.
//
// The exit criterion is deliberately harsh (docs/ai-lineup-builder.md §13): if
// no model is CLEARLY better than the rule-based baseline, ship the baseline
// alone and stop. This script exists to make that judgement cheap and honest,
// not to justify the feature.
//
//   node scripts/lineup-spike.mjs                 # all providers, default answers
//   node scripts/lineup-spike.mjs --answers B     # a different taste profile
//   node scripts/lineup-spike.mjs --only rule     # skip the models
//   node scripts/lineup-spike.mjs --json out.json # machine-readable too

import fs from 'node:fs';
import { buildDigest, estimateTokens } from '../src/lineup/digest.js';
import { planRuleBased } from '../src/lineup/rule-based.js';
import { validateProposal } from '../src/lineup/validate.js';
import { planWithOllama, listModels } from '../src/lineup/ollama.js';
import { planHybrid } from '../src/lineup/hybrid.js';

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};

// Three taste profiles, so nobody judges a planner on one lucky prompt.
const ANSWER_SETS = {
  A: {
    label: 'Nostalgia, light rhythm, few channels',
    purpose: 'nostalgia', loves: ['animation', 'western', 'comedy'], never: ['horror'],
    kids: false, rhythm: 'light', dayparts: { morning: ['animation'], evening: ['drama'] },
    airdates: 'where-it-fits', ads: 'only-retro', channelCount: 'a-few', channelCountN: 5,
  },
  B: {
    label: 'Background TV, no rhythm, a dial full',
    purpose: 'background', loves: [], never: [],
    kids: false, rhythm: 'no', airdates: 'no', ads: 'no',
    channelCount: 'a-dial-full', channelCountN: 10,
  },
  C: {
    label: 'Kids, strict exclusions, few channels',
    purpose: 'kids', loves: ['animation', 'family'], never: ['horror', 'thriller', 'war'],
    kids: true, rhythm: 'yes-strong', dayparts: { morning: ['animation'], evening: ['family'] },
    airdates: 'no', ads: 'no', channelCount: 'a-few', channelCountN: 5,
  },
};

function show(title, v, digest, answers) {
  const { proposal, repairs, fatal } = validateProposal(v.raw, digest, {
    maxChannels: answers.channelCountN, never: answers.never,
  });
  console.log(`\n${'─'.repeat(74)}\n▌ ${title}   ${v.ms}ms`);
  if (fatal) { console.log(`  ✘ FAILED VALIDATION: ${fatal}`); return { title, fatal, repairs }; }
  for (const c of proposal.channels) {
    const rules = c.rules.length ? `  ⟨${c.rules.map((r) => r.kind).join(', ')}⟩` : '';
    console.log(`\n  ${c.name}   ${c.ordering}${c.ads ? ' · ads' : ''}${rules}`);
    console.log(`    ${c.rationale || '(no rationale)'}`);
    console.log(`    ${c.sources.length} sources · tags: ${c.tags.join(', ') || '—'}`);
  }
  if (repairs.length) {
    console.log(`\n  REPAIRS (${repairs.length}) — what the validator had to fix:`);
    for (const r of repairs.slice(0, 8)) console.log(`    · ${r}`);
    if (repairs.length > 8) console.log(`    · …and ${repairs.length - 8} more`);
  }
  if (proposal.notes) console.log(`\n  notes: ${proposal.notes}`);
  return { title, channels: proposal.channels, repairs, proposal };
}

const main = async () => {
  const setKey = arg('--answers', 'A');
  const answers = ANSWER_SETS[setKey];
  if (!answers) { console.error(`unknown answer set ${setKey}`); process.exit(1); }
  const only = arg('--only', '');

  console.log(`dumbTV · AI lineup spike (A0)\nanswers: ${setKey} — ${answers.label}`);
  process.stdout.write('building digest… ');
  const digest = await buildDigest({ enrich: true });
  console.log(
    `${digest.counts.shows} shows, ${digest.counts.movies} movies, ${digest.counts.packs} packs · ` +
    `~${(estimateTokens(digest) / 1000).toFixed(1)}k tokens` +
    (digest.tooLargeForOnePass ? ' · TOO LARGE FOR ONE PASS' : '') +
    (digest.missingGenres ? ` · ${digest.missingGenres} titles have no genre` : '')
  );

  const results = [];

  // The baseline, always. Everything else is judged against it.
  {
    const t = Date.now();
    const raw = planRuleBased(digest, answers);
    results.push(show('RULE-BASED (the baseline to beat)', { raw, ms: Date.now() - t }, digest, answers));
  }

  if (!only.startsWith('rule')) {
    const models = await listModels();
    if (!models.length) {
      console.log('\n(no Ollama models found — start ollama, or `ollama pull` one)');
    }
    for (const m of models) {
      const t = Date.now();
      try {
        const raw = await planWithOllama(digest, answers, { model: m });
        results.push(show(`OLLAMA · ${m}`, { raw, ms: Date.now() - t }, digest, answers));
      } catch (e) {
        console.log(`\n${'─'.repeat(74)}\n▌ OLLAMA · ${m}\n  ✘ ${e.message}`);
        results.push({ title: `ollama:${m}`, fatal: e.message });
      }
      // The hybrid: rules pick the material, the model writes the presentation.
      const t2 = Date.now();
      try {
        const raw = await planHybrid(digest, answers, { model: m });
        results.push(show(`HYBRID · rules + ${m}`, { raw, ms: Date.now() - t2 }, digest, answers));
      } catch (e) {
        console.log(`\n▌ HYBRID · ${m}\n  ✘ ${e.message}`);
        results.push({ title: `hybrid:${m}`, fatal: e.message });
      }
    }
  }

  console.log(`\n${'═'.repeat(74)}\nTHE QUESTION: is any of the above CLEARLY better than the baseline?`);
  console.log('If not, ship the rule-based builder alone and park the rest (§13 A0).\n');
  for (const r of results) {
    console.log(`  ${r.fatal ? '✘' : '✓'} ${r.title}: ` +
      (r.fatal ? r.fatal : `${r.channels.length} channels, ${r.repairs.length} repairs`));
  }

  const out = arg('--json', '');
  if (out) { fs.writeFileSync(out, JSON.stringify({ digest, results }, null, 2)); console.log(`\nwrote ${out}`); }
};

main().catch((e) => { console.error(e); process.exit(1); });
