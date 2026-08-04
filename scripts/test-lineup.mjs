#!/usr/bin/env node
// test-lineup.mjs — the AI lineup builder's invariants, no network, no Plex.
//
// Three things are checked here, and each one exists because getting it wrong
// is silent rather than loud:
//
//   1. THE KEY NEVER LEAVES. Someone's Anthropic key is in the settings table.
//      Two GET endpoints and the config export all build their output from
//      allowlists today — which is the right shape, and exactly the shape that
//      rots the moment someone "simplifies" one into a spread. A test is the
//      only thing that notices.
//   2. COMMIT ONLY ADDS. The D-3 lesson: config import once cleared `channels`
//      and took SPACE with it. Committing a proposal must never remove or alter
//      a channel someone built by hand.
//   3. THE SEED IS STABLE. Invariant #5 — the same proposal committed twice, or
//      on two different machines, must schedule identically or the printed
//      guide is a lie.
//
//   node scripts/test-lineup.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dumbtv-lineup-'));
process.env.DUMBTV_DB = path.join(tmp, 'test.db');
process.env.DUMBTV_DATA = tmp;

const { db, setSetting } = await import('../src/db.js');
const { seedFor, commitProposal, rollbackLast } = await import('../src/lineup/commit.js');
const { validateProposal } = await import('../src/lineup/validate.js');

let pass = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✘ ${name}\n      ${e.message}`); process.exitCode = 1; }
};

console.log('\ndumbTV · AI lineup builder tests\n');

// ── 1. the key never leaves ────────────────────────────────────────────────
// Shaped like a key but deliberately NOT matching the real `sk-ant-api03-`
// prefix, so secret scanners don't flag this file forever.
const SECRET = 'sk-ant-NOTAREALKEY-must-never-appear-in-a-response';
setSetting('ai_api_key', SECRET);

console.log('the key never leaves');

// Read the route file and assert the shape rather than booting fastify: what
// matters is that these builders are allowlists, and that is a source property.
const apiSrc = fs.readFileSync(new URL('../src/routes/api.js', import.meta.url), 'utf8');

check('GET /api/settings does not read ai_api_key', () => {
  const body = apiSrc.slice(apiSrc.indexOf("fastify.get('/api/settings'"));
  assert.ok(!body.slice(0, body.indexOf('}));')).includes('ai_api_key'));
});

check('the config export does not read ai_api_key', () => {
  const i = apiSrc.indexOf('settings: {');
  assert.ok(i > 0, 'export settings block not found — did it stop being an allowlist?');
  assert.ok(!apiSrc.slice(i, i + 600).includes('ai_api_key'));
});

check('no endpoint spreads the whole settings table', () => {
  // `...allSettings()` or similar would defeat every allowlist at once.
  assert.ok(!/\.\.\.\s*(all)?[Ss]ettings\(\)/.test(apiSrc));
});

check('the key is never logged', () => {
  for (const f of ['src/lineup/claude.js', 'src/lineup/commit.js', 'src/routes/api.js']) {
    const s = fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    const logs = s.match(/console\.(log|error|warn)\([^\n]*/g) || [];
    for (const l of logs) assert.ok(!/apiKey|ai_api_key/.test(l), `${f}: ${l}`);
  }
});

check('/api/lineup/status returns a hint, not the key', () => {
  const i = apiSrc.indexOf('const keyStatus');
  const body = apiSrc.slice(i, i + 300);
  assert.ok(body.includes('slice(-4)'), 'hint should be the last 4 only');
  assert.ok(!/return\s*\{[^}]*key:\s*k\b/.test(body), 'must not return the key itself');
});

// ── 2. commit only adds ────────────────────────────────────────────────────
console.log('\ncommit only adds');

const handBuilt = db.prepare(`
  INSERT INTO channels (number, name, slot_minutes, ordering_mode, shuffle_seed, enabled, locked, created_at)
  VALUES (1,'SPACE',30,'sequential',42,1,1,0)
`).run().lastInsertRowid;

const proposal = {
  channels: [
    { name: 'SATURDAY MORNING', ordering: 'shuffle', ads: true, tags: ['animation'],
      sources: [{ key: 'k1', type: 'show' }, { key: 'k2', type: 'show' }], rules: [] },
    { name: 'LATE MOVIE', ordering: 'shuffle', ads: false, tags: ['film'],
      sources: [{ key: 'k3', type: 'movie' }], rules: [] },
  ],
  notes: '', provider: 'test',
};

const before = db.prepare('SELECT * FROM channels').all();
const { channelIds, numbers } = commitProposal(proposal, { provider: 'test' });

check('the hand-built channel is untouched', () => {
  const after = db.prepare('SELECT * FROM channels WHERE id=?').get(handBuilt);
  assert.deepEqual(after, before.find((c) => c.id === handBuilt));
});

check('commit.js contains no UPDATE or DELETE of channels', () => {
  const src = fs.readFileSync(new URL('../src/lineup/commit.js', import.meta.url), 'utf8');
  // Strip comments — the file explains at length what it does NOT do.
  const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const deletes = code.match(/DELETE FROM channels[^']*/gi) || [];
  // The single permitted DELETE is rollback's, and it must carry the guard.
  for (const d of deletes) assert.ok(/WHERE id = \? AND locked = 0/.test(d), d);
  assert.ok(!/UPDATE channels/i.test(code), 'commit.js must never UPDATE a channel');
});

check('channel 1 is never allocated', () => {
  assert.ok(!numbers.includes(1), `allocated ${numbers}`);
});

check('sources landed', () => {
  const n = db.prepare('SELECT COUNT(*) c FROM channel_sources WHERE channel_id=?').get(channelIds[0]).c;
  assert.equal(n, 2);
});

check('generateCommitted caches sources before generating', () => {
  // The gap that produced a channel with 33 sources and ONE program on it: a
  // `channel_sources` row is only a pointer, and the generator schedules from
  // `media`. Committing without caching yields a channel that reports success
  // and plays dead air — which nothing else in this suite would catch.
  const src = fs.readFileSync(new URL('../src/lineup/commit.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('export async function generateCommitted'));
  assert.ok(body.includes('cacheSource('), 'generateCommitted must cache');
  assert.ok(body.indexOf('cacheSource(') < body.indexOf('regenerateChannel('),
    'caching must happen BEFORE the schedule is generated');
  assert.ok(/from '\.\.\/media\/backend\.js'/.test(src),
    'cacheSource must come from the backend facade, or Jellyfin users get nothing');
  assert.ok(body.includes('empty'), 'an empty channel must be reported, not silently shipped');
});

// ── 3. the seed is stable ──────────────────────────────────────────────────
console.log('\nthe seed is deterministic');

check('same name + same sources → same seed', () => {
  const a = seedFor('SATURDAY MORNING', [{ key: 'k1' }, { key: 'k2' }]);
  const b = seedFor('SATURDAY MORNING', [{ key: 'k2' }, { key: 'k1' }]); // order-independent
  assert.equal(a, b);
});

check('different sources → different seed', () => {
  assert.notEqual(
    seedFor('SATURDAY MORNING', [{ key: 'k1' }]),
    seedFor('SATURDAY MORNING', [{ key: 'k9' }])
  );
});

check('the committed seed matches seedFor', () => {
  const row = db.prepare('SELECT shuffle_seed FROM channels WHERE id=?').get(channelIds[0]);
  assert.equal(row.shuffle_seed, seedFor('SATURDAY MORNING', proposal.channels[0].sources));
});

// ── 4. rollback is surgical ────────────────────────────────────────────────
console.log('\nrollback is surgical');

const { removed } = rollbackLast();

check('it removed exactly what it made', () => assert.equal(removed, 2));

check('the locked hand-built channel survived', () => {
  assert.ok(db.prepare('SELECT 1 FROM channels WHERE id=?').get(handBuilt));
});

check('a second rollback is a no-op, not a disaster', () => {
  assert.equal(rollbackLast().removed, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM channels').get().c, 1);
});

// ── 5. the validator is the gate ───────────────────────────────────────────
console.log('\nthe validator is the gate');

const digest = {
  shows: [{ key: 'k1', title: 'A', episodes: 10 }, { key: 'k2', title: 'B', episodes: 5 }],
  movies: [{ key: 'k3', title: 'C' }],
  packs: [], existingChannels: [{ number: 1, name: 'SPACE' }],
  counts: { shows: 2, movies: 1, packs: 0 },
};

check('hallucinated keys are dropped, not committed', () => {
  const { proposal: p, repairs } = validateProposal({
    channels: [{ name: 'X', ordering: 'shuffle', ads: false, tags: [],
                 sources: [{ key: 'k1' }, { key: 'DOES-NOT-EXIST' }] }],
    notes: '',
  }, digest, { maxChannels: 5, minChannels: 1, never: [] });
  assert.equal(p.channels[0].sources.length, 1);
  assert.ok(repairs.length);
});

check('a one-channel LINEUP is fatal (but make-me-a-channel is not)', () => {
  const one = { channels: [{ name: 'X', ordering: 'shuffle', ads: false, tags: [], sources: [{ key: 'k1' }] }], notes: '' };
  assert.ok(validateProposal(one, digest, { maxChannels: 5, never: [] }).fatal);
  assert.equal(validateProposal(one, digest, { maxChannels: 1, minChannels: 1, never: [] }).fatal, null);
});

check('an empty proposal is fatal, not an empty lineup', () => {
  const { fatal } = validateProposal({ channels: [], notes: '' }, digest, { maxChannels: 5, never: [] });
  assert.ok(fatal);
});

// ── 6. the privacy policy is not stale ─────────────────────────────────────
//
// The policy said "That's all. dumbTV makes no other network calls" while the
// app was already downloading packs from archive.org. It drifted because
// nothing connected the sentence to the code. This does.
console.log('\nthe privacy policy matches the code');

const policy = fs.readFileSync(new URL('../docs/privacy-policy.md', import.meta.url), 'utf8');
const site = fs.readFileSync(new URL('../site/privacy.html', import.meta.url), 'utf8');

// Every host the source actually talks to. Localhost and the user's own server
// are not third parties, so they are not policy matters.
const IGNORE = /^(localhost|127\.|10\.|192\.168\.|0\.0\.0\.0)/;
const srcHosts = new Set();
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) { walk(f); continue; }
    if (!/\.(js|mjs|swift)$/.test(e.name)) continue;
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/https?:\/\/([a-zA-Z0-9._-]+)/g)) {
      if (!IGNORE.test(m[1])) srcHosts.add(m[1]);
    }
  }
};
walk(new URL('../src', import.meta.url).pathname);

// Hosts that are referenced but never contacted — documentation links, XMLTV
// generator attribution, licence URLs. Named individually so adding one is a
// deliberate act rather than a widened pattern.
const NOT_CONTACTED = new Set(['www.gnu.org', 'code.videolan.org', 'www.anthropic.com']);

check('every host the code contacts is named in the policy', () => {
  const missing = [...srcHosts].filter((h) => {
    if (NOT_CONTACTED.has(h)) return false;
    const bare = h.replace(/^www\./, '');
    // images-assets.nasa.gov is documented under its user-facing name.
    const alias = bare.replace('images-assets.nasa.gov', 'images.nasa.gov');
    return !policy.includes(bare) && !policy.includes(alias);
  });
  assert.deepEqual(missing, [], `not in docs/privacy-policy.md: ${missing.join(', ')}`);
});

check('the published page names them too', () => {
  for (const h of ['plex.tv', 'archive.org', 'dumbtv.app', 'api.anthropic.com']) {
    assert.ok(site.includes(h), `site/privacy.html is missing ${h}`);
  }
});

check('the policy makes the same key promises the UI does', () => {
  const ui = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const claim of ['never synced', 'never written to a log', 'config exports']) {
    assert.ok(ui.includes(claim), `the UI stopped claiming "${claim}"`);
    assert.ok(policy.includes(claim), `the policy stopped claiming "${claim}"`);
  }
});

check('no placeholder survived into either policy file', () => {
  // Both files, not just the markdown — the published page is the one people
  // actually read, and it carried its own copy of the same unset date.
  const holes = [
    ...(policy.match(/\[[A-Z][A-Z ]{3,}[^\]]*\]/g) || []),
    ...(site.match(/\[[A-Z][A-Z ]{3,}[^\]]*\]/g) || []),
  ];
  // CONTACT EMAIL is the one KNOWN hole: it needs a mailbox that actually
  // receives mail, which is the owner's call, not something to invent here.
  // Apple requires a working privacy contact, so this must be filled before
  // submission — delete this exclusion the moment it is.
  const outstanding = holes.filter((h) => !h.includes('CONTACT EMAIL'));
  if (holes.length !== outstanding.length) {
    console.log('      ⚠ still to fill before submission: the privacy contact email');
  }
  assert.deepEqual(outstanding, [], 'unfilled placeholders');
});

console.log(`\n${pass} checks passed\n`);
fs.rmSync(tmp, { recursive: true, force: true });
