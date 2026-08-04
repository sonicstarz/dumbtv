#!/usr/bin/env node
// test-lineup.mjs — the AI lineup builder's invariants. No network, no Plex.
//
// The builder lives in public/lineup/ and runs in the browser, so much of what
// matters here is STRUCTURAL: properties that keep it working on every platform
// and keep it from damaging a lineup someone built by hand. Every check exists
// because getting it wrong fails silently rather than loudly.
//
//   npm run test:lineup

import assert from 'node:assert/strict';
import fs from 'node:fs';

import { buildDigest, estimateTokens } from '../public/lineup/digest.js';
import { planRuleBased } from '../public/lineup/rules.js';
import { validateProposal } from '../public/lineup/validate.js';
import { applyProposal, undoLast } from '../public/lineup/apply.js';

const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

/**
 * Strip comments so a note EXPLAINING why something was removed doesn't itself
 * trip the check for it — which happened three times writing this file.
 *
 * Naive `//.*` removal is wrong twice over: it eats the rest of any line
 * containing `https://`, and it fires inside string literals. So walk the text
 * tracking quote state and only cut a `//` that is actually code.
 */
function code(t) {
  let out = '';
  let quote = null;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (quote) {
      out += c;
      if (c === '\\') { out += t[++i] ?? ''; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; continue; }
    if (c === '/' && t[i + 1] === '/') { while (i < t.length && t[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && t[i + 1] === '*') { i = t.indexOf('*/', i) + 1; continue; }
    out += c;
  }
  return out;
}

const SHARED = ['digest', 'rules', 'validate', 'claude', 'apply'];

let pass = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✘ ${name}\n      ${e.message}`); process.exitCode = 1; }
};
const acheck = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✘ ${name}\n      ${e.message}`); process.exitCode = 1; }
};

console.log('\ndumbTV · AI lineup builder\n');

// ── 1. it runs everywhere ───────────────────────────────────────────────────
//
// The builder used to be seven Node routes, which meant the Apple apps — the
// actual v1 product — could not have it without a second implementation in
// Swift. These checks are what stop that happening again.
console.log('it runs on every platform');

check('the shared modules are platform-free', () => {
  for (const m of SHARED) {
    const src = code(read(`public/lineup/${m}.js`));
    for (const banned of ["'node:", 'require(', 'better-sqlite3', "from '../../src/"]) {
      assert.ok(!src.includes(banned), `${m}.js reaches for ${banned} — it must run in a browser`);
    }
    assert.ok(!/\bdocument\./.test(src), `${m}.js touches the DOM — it must run under Node too`);
  }
});

check('every endpoint it calls exists on BOTH backends', () => {
  const node = read('src/routes/api.js');
  const swift = read('apple/dumbTVCore/Sources/dumbTVCore/ConfigAPI.swift');
  const calls = new Set();
  for (const m of SHARED) {
    for (const hit of code(read(`public/lineup/${m}.js`)).matchAll(/api\(\s*[`'"]\/api\/([a-z-]+)/g)) {
      calls.add(hit[1]);
    }
  }
  assert.ok(calls.size >= 3, `only found ${calls.size} endpoints — did the matcher break?`);
  for (const c of calls) {
    assert.ok(node.includes(`/api/${c}`), `Node serves no /api/${c}`);
    // ConfigAPI routes on path SEGMENTS, so the literal appears bare.
    assert.ok(swift.includes(`"${c}"`), `ConfigAPI has no "${c}" route — this would 404 on an Apple TV`);
  }
  console.log(`      (${[...calls].sort().join(', ')})`);
});

check('the Apple bundle actually ships the modules', () => {
  assert.ok(read('apple/project.yml').includes('public/lineup/'),
    'project.yml does not copy public/lineup — the import would 404 on tvOS');
});

check('the view is not hidden from the native apps', () => {
  const html = read('public/index.html');
  const nav = html.slice(html.indexOf('data-view="lineup"'), html.indexOf('data-view="lineup"') + 120);
  assert.ok(!nav.includes('data-native-hide'), 'the lineup view is still hidden on iOS/tvOS/macOS');
});

// ── 2. the key never reaches the television ─────────────────────────────────
console.log('\nthe key never reaches the television');

check('only claude.js ever handles the key, and only talks to Anthropic', () => {
  for (const m of SHARED.filter((x) => x !== 'claude')) {
    assert.ok(!/apiKey|sk-ant/.test(code(read(`public/lineup/${m}.js`))), `${m}.js handles the key`);
  }
  const hosts = [...code(read('public/lineup/claude.js')).matchAll(/https?:\/\/([a-z.]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(hosts)], ['api.anthropic.com']);
});

check('the key is never sent to the device', () => {
  const raw = read('public/app.js');
  // The section marker is itself a comment, so locate it BEFORE stripping.
  const lineup = code(raw.slice(raw.indexOf('---- build a lineup')));
  // Storing it via /api/settings would put it in the device config, where a
  // config export could hand it to whoever the user shares that file with.
  assert.ok(!/\/api\/settings/.test(lineup), 'the lineup UI writes to device settings');
  assert.ok(lineup.includes('localStorage'), 'the key should live in the browser');
});

check('the key is never logged', () => {
  for (const f of [...SHARED.map((m) => `public/lineup/${m}.js`), 'public/app.js']) {
    for (const l of read(f).match(/console\.(log|error|warn)\([^\n]*/g) || []) {
      assert.ok(!/apiKey|getKey\(|KEY_STORE/.test(l), `${f}: ${l}`);
    }
  }
});

// ── 3. it can only add ──────────────────────────────────────────────────────
//
// Config import once cleared the whole channels table (D-3) and took SPACE with
// it. A feature that writes channels from a language model's output has no
// business being one bug away from the same outcome.
console.log('\nit can only add');

check('apply.js issues no PATCH, and DELETEs only what it recorded', () => {
  const src = code(read('public/lineup/apply.js'));
  assert.ok(!/method:\s*'PATCH'/.test(src), 'apply.js PATCHes something');
  for (const d of [...src.matchAll(/api\(([^;]*?)method:\s*'DELETE'/g)].map((m) => m[1])) {
    assert.ok(d.includes('c.id'), `a DELETE not keyed on a recorded id: ${d.trim().slice(0, 60)}`);
  }
});

await acheck('a build only ever creates', async () => {
  const calls = [];
  const api = async (path, init = {}) => {
    calls.push(`${init.method || 'GET'} ${path}`);
    if (path === '/api/channels' && init.method === 'POST') return { id: calls.length, number: 10 + calls.length };
    return {};
  };
  const res = await applyProposal({
    provider: 'test',
    channels: [
      { name: 'A', ordering: 'shuffle', ads: false, tags: [], sources: [{ key: 'k1', type: 'show' }],
        rules: [{ kind: 'recurring', startTime: '07:00', daysOfWeek: [0], durationMin: 120 }] },
      { name: 'B', ordering: 'shuffle', ads: true, tags: [], sources: [{ key: 'k2', type: 'movie' }], rules: [] },
    ],
  }, { api });
  assert.equal(res.created.length, 2);
  assert.ok(!res.partial);
  for (const c of calls) assert.ok(c.startsWith('POST'), `a build made a non-POST request: ${c}`);
});

await acheck('a failure partway keeps what was built, and undo touches only that', async () => {
  let n = 0;
  const deleted = [];
  const api = async (path, init = {}) => {
    if (init.method === 'DELETE') { deleted.push(path); return {}; }
    if (path === '/api/channels' && init.method === 'POST') {
      if (++n === 2) throw new Error('server went away');
      return { id: n, number: 10 + n };
    }
    return {};
  };
  const res = await applyProposal({ provider: 't', channels: [1, 2, 3].map((i) => ({
    name: `C${i}`, ordering: 'shuffle', ads: false, tags: [], sources: [{ key: 'k' }], rules: [] })) }, { api });
  assert.ok(res.partial, 'should report a partial build');
  assert.equal(res.created.length, 1, 'the first channel is real television and should be kept');
  assert.equal((await undoLast({ api, created: res.created })).removed, 1);
  assert.deepEqual(deleted, ['/api/channels/1'], 'undo must touch only what it made');
});

// ── 4. the planner and the gate ─────────────────────────────────────────────
console.log('\nthe planner and the gate');

const G = ['Western', 'Comedy', 'Animation', 'Drama', 'Documentary', 'Science Fiction', 'Horror'];
const movies = Array.from({ length: 70 }, (_, i) =>
  ({ ratingKey: `m${i}`, title: `Film ${i}`, year: 1940 + (i * 7) % 60, genres: [G[i % G.length]] }));
const shows = Array.from({ length: 30 }, (_, i) =>
  ({ ratingKey: `s${i}`, title: `Show ${i}`, year: 1960 + (i * 3) % 50, genres: [G[i % G.length]], leafCount: 20 + i }));
const FIXTURE = {
  '/api/library/sections': { sections: [{ key: '1', title: 'Movies', type: 'movie' }, { key: '2', title: 'TV', type: 'show' }] },
  '/api/library/sections/1/items?type=movie': { items: movies },
  '/api/library/sections/2/items?type=show': { items: shows },
  '/api/packs': { packs: [{ id: 'space', name: 'SPACE', installed: true }] },
  '/api/channels': { channels: [{ number: 1, name: 'SPACE' }] },
};
const fixtureApi = async (p) => {
  if (!(p in FIXTURE)) throw new Error(`404 ${p}`);
  return FIXTURE[p];
};

const digest = await buildDigest({ api: fixtureApi });
const answers = {
  purpose: 'nostalgia', loves: ['western', 'animation'], never: ['horror'],
  rhythm: 'light', ads: 'only-retro', channelCountN: 5,
  dayparts: { morning: ['animation'], evening: ['drama'] }, airdates: 'no',
};

check('the digest reads shows and films, never episodes', () => {
  assert.equal(digest.counts.movies, 70);
  assert.equal(digest.counts.shows, 30);
  assert.equal(digest.counts.packs, 1);
  assert.ok(estimateTokens(digest) > 0);
});

await acheck('no media server is an ordinary state — packs alone still build', async () => {
  const api = async (p) => {
    if (p === '/api/packs') return { packs: [{ id: 'space', name: 'SPACE', installed: true }] };
    if (p === '/api/channels') return { channels: [] };
    throw new Error('no server linked');
  };
  const d = await buildDigest({ api });
  assert.equal(d.counts.packs, 1);
  assert.equal(d.counts.shows, 0);
});

await acheck('packs alone still make a LINEUP — the fresh-Apple-TV first run', async () => {
  // Found on the tvOS simulator: a device with two preloaded packs and no media
  // server planned "only 0 usable channels survived validation", because the
  // planner grouped by genre and packs carry none. That is what a new owner
  // would have met on first launch.
  const api = async (p) => {
    if (p === '/api/packs') return { packs: [
      { id: 'space', name: 'SPACE', installed: true, itemCount: 5, editorial: { era: '1969–2011', kidSafe: true } },
      { id: 'early-disney', name: 'EARLY DISNEY', installed: true, itemCount: 3, editorial: { era: '1928–1929', kidSafe: true } },
    ] };
    if (p === '/api/channels') return { channels: [] };
    throw new Error('no server linked');
  };
  const d = await buildDigest({ api });
  const v = validateProposal(planRuleBased(d, { ads: 'only-retro', channelCountN: 5 }), d,
    { maxChannels: 5, minChannels: 1, never: [] });
  assert.equal(v.fatal, null, 'a device with only packs must still get channels');
  assert.equal(v.proposal.channels.length, 2);
  assert.deepEqual(v.proposal.channels.map((c) => c.name), ['SPACE', 'EARLY DISNEY']);
  // 1928 and 1969 are both pre-1980, so retro ads belong on both.
  assert.ok(v.proposal.channels.every((c) => c.ads), 'pack era should drive the ad policy');
});

check('a pack keeps its own identity instead of dissolving into a genre', () => {
  const d = { ...digest, packs: [{ key: 'pack:space', title: 'SPACE', genres: [], year: 1969, items: 5 }] };
  const p = planRuleBased(d, { channelCountN: 12, loves: [], never: [] });
  const pack = p.channels.find((c) => c.name === 'SPACE');
  assert.ok(pack, 'the pack lost its own channel');
  assert.deepEqual(pack.sources, [{ key: 'pack:space', type: 'pack' }]);
  // Packs come last so the channel cap trims them before the person's library.
  assert.equal(p.channels.at(-1).name, 'SPACE');
});

const planned = validateProposal(planRuleBased(digest, answers), digest, { maxChannels: 5, never: answers.never });

check('the rule-based planner produces a usable lineup with no AI at all', () => {
  assert.equal(planned.fatal, null);
  assert.ok(planned.proposal.channels.length >= 2);
});

check('exclusions are ENFORCED, not merely requested', () => {
  const horror = new Set([...movies, ...shows].filter((x) => x.genres.includes('Horror')).map((x) => x.ratingKey));
  assert.ok(horror.size > 0, 'the fixture has no horror to exclude');
  const used = planned.proposal.channels.flatMap((c) => c.sources.map((s) => s.key));
  assert.deepEqual(used.filter((k) => horror.has(k)), []);
});

check('a daily rhythm produces timed rules, and none of them filter by tag', () => {
  const rules = planned.proposal.channels.flatMap((c) => c.rules);
  assert.ok(rules.length > 0, 'asked for a rhythm and got no dayparts');
  // A selectTags filter would match nothing (no media_tags on Swift, and
  // nothing writes them any more) and blank the daypart into dead air.
  assert.ok(rules.every((r) => !('selectTags' in r)));
});

check('sources carry their TRUE title from the digest, not their key', () => {
  // Without this, every channel a build creates lists its sources in the
  // config UI as raw keys — "601", "pack:space" — because neither the planner
  // nor a model supplies titles, and apply.js falls back to the key.
  const { proposal } = validateProposal({
    channels: [{ name: 'X', ordering: 'shuffle', ads: false, tags: [], sources: [{ key: 'm1' }] }],
    notes: '',
  }, digest, { maxChannels: 1, minChannels: 1, never: [] });
  assert.equal(proposal.channels[0].sources[0].title, 'Film 1');
});

check('hallucinated keys are dropped, not built', () => {
  const { proposal, repairs } = validateProposal({
    channels: [{ name: 'X', ordering: 'shuffle', ads: false, tags: [],
                 sources: [{ key: 'm1' }, { key: 'DOES-NOT-EXIST' }] }],
    notes: '',
  }, digest, { maxChannels: 5, minChannels: 1, never: [] });
  assert.equal(proposal.channels[0].sources.length, 1);
  assert.ok(repairs.length);
});

check('a one-channel LINEUP is fatal, but make-me-a-channel is not', () => {
  const one = { channels: [{ name: 'X', ordering: 'shuffle', ads: false, tags: [], sources: [{ key: 'm1' }] }], notes: '' };
  assert.ok(validateProposal(one, digest, { maxChannels: 5, never: [] }).fatal);
  assert.equal(validateProposal(one, digest, { maxChannels: 1, minChannels: 1, never: [] }).fatal, null);
});

check('names are cut at a word boundary, and the cut is reported', () => {
  const { proposal, repairs } = validateProposal({
    channels: [{ name: 'Sunday Afternoon Comfort', ordering: 'shuffle', ads: false, tags: [], sources: [{ key: 'm1' }] }],
    notes: '',
  }, digest, { maxChannels: 1, minChannels: 1, never: [] });
  assert.equal(proposal.channels[0].name, 'SUNDAY AFTERNOON');
  assert.ok(repairs.some((r) => r.includes('shortened')));
});

// ── 5. the same lineup plays the same everywhere ────────────────────────────
console.log('\nthe same lineup plays the same in every room');

check('nothing in the shared path calls Math.random', () => {
  for (const m of SHARED) {
    assert.ok(!/Math\.random/.test(code(read(`public/lineup/${m}.js`))), `${m}.js is not deterministic`);
  }
});

check('the client never invents a shuffle seed', () => {
  // Both servers derive it from name+number. A client-side seed would be a
  // third implementation, and it would silently win.
  assert.ok(!/shuffleSeed|shuffle_seed/.test(code(read('public/lineup/apply.js'))));
});

check('ConfigAPI derives the seed from identity, not randomness', () => {
  // Stripped: the comment explaining the removal names `UInt32.random` itself.
  const swift = code(read('apple/dumbTVCore/Sources/dumbTVCore/ConfigAPI.swift'));
  const fn = swift.slice(swift.indexOf('private func createChannel'), swift.indexOf('private func patchChannel'));
  assert.ok(!/UInt32\.random/.test(fn), 'a random seed makes the same lineup play differently per device');
  assert.ok(fn.includes('channelSeed('), 'ConfigAPI should use the shared derivation');
  assert.ok(swift.includes('hashString("channel:\\(name):\\(number)")'),
    'the Swift derivation must match channelSeed in src/routes/api.js');
});

// ── 6. the privacy policy is not stale ──────────────────────────────────────
//
// The policy once ended "That's all. dumbTV makes no other network calls" while
// the app was already downloading packs from archive.org. It drifted because
// nothing connected the sentence to the code. This does.
console.log('\nthe privacy policy matches the code');

const policy = read('docs/privacy-policy.md');
const site = read('site/privacy.html');

check('every host the code contacts is named in the policy', () => {
  const IGNORE = /^(localhost|127\.|10\.|192\.168\.|0\.0\.0\.0)/;
  const NOT_CONTACTED = new Set(['www.gnu.org', 'code.videolan.org', 'www.anthropic.com']);
  const hosts = new Set();
  const walk = (dir) => {
    for (const e of fs.readdirSync(new URL(`../${dir}`, import.meta.url), { withFileTypes: true })) {
      if (e.isDirectory()) { walk(`${dir}/${e.name}`); continue; }
      if (!/\.(js|mjs)$/.test(e.name)) continue;
      for (const m of read(`${dir}/${e.name}`).matchAll(/https?:\/\/([a-zA-Z0-9._-]+)/g)) {
        if (!IGNORE.test(m[1])) hosts.add(m[1]);
      }
    }
  };
  walk('src'); walk('public/lineup');
  const missing = [...hosts].filter((h) => {
    if (NOT_CONTACTED.has(h)) return false;
    return !policy.includes(h.replace(/^www\./, '').replace('images-assets.nasa.gov', 'images.nasa.gov'));
  });
  assert.deepEqual(missing, [], `not in docs/privacy-policy.md: ${missing.join(', ')}`);
});

check('the published page names them too', () => {
  for (const h of ['plex.tv', 'archive.org', 'dumbtv.app', 'api.anthropic.com']) {
    assert.ok(site.includes(h), `site/privacy.html is missing ${h}`);
  }
});

check('no placeholder survived into either policy file', () => {
  const holes = [...(policy.match(/\[[A-Z][A-Z ]{3,}[^\]]*\]/g) || []),
                 ...(site.match(/\[[A-Z][A-Z ]{3,}[^\]]*\]/g) || [])];
  // CONTACT EMAIL is the one KNOWN hole: it needs a mailbox that actually
  // receives mail, which is the owner's call. Apple requires it before
  // submission — delete this exclusion the moment it is filled.
  const outstanding = holes.filter((h) => !h.includes('CONTACT EMAIL'));
  if (holes.length !== outstanding.length) {
    console.log('      ⚠ still to fill before submission: the privacy contact email');
  }
  assert.deepEqual(outstanding, []);
});

console.log(`\n${pass} checks passed\n`);
