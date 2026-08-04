// claude.js — the Anthropic API planner (the proposed primary provider).
//
// The A0 finding was that a 3B local model understands the job but cannot
// ground a choice in a 520-line catalog. This provider asks whether a small
// FRONTIER model (Haiku) can — because if it can, the whole provider
// hodge-podge (hybrid, Ollama-primary, phone-handoff for apple-fm) collapses
// into one code path that works on every platform with a network connection,
// including tvOS directly.
//
// Raw fetch, no SDK, deliberately: ollama.js set the precedent and the repo
// rule is "npm install && npm start works on a stranger's machine" — a spike
// must not grow the dependency tree. The eventual product path is a device (or
// the dumbtv.app relay) making exactly this HTTP call.
//
// THE KEY IS NEVER STORED. It arrives via environment or argument, is sent to
// api.anthropic.com and nowhere else, and does not touch the database, the
// settings, or any log. The product design (BYO key / relay) decides storage
// later — a spike has no business deciding it by accident.

import { SYSTEM_PROMPT, promptCatalog } from './ollama.js';

const API = 'https://api.anthropic.com/v1/messages';
const TIMEOUT_MS = 120_000;

/**
 * The proposal schema, in structured-outputs form: every object closed with
 * additionalProperties:false and required lists, per the API's JSON-schema
 * rules. Output is then guaranteed parseable — the failure class the Ollama
 * provider needed a retry for cannot occur here.
 */
const PROPOSAL_FORMAT = {
  type: 'json_schema',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['channels', 'notes'],
    properties: {
      channels: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'rationale', 'ordering', 'ads', 'sources', 'tags'],
          properties: {
            name: { type: 'string' },
            rationale: { type: 'string' },
            ordering: { type: 'string', enum: ['sequential', 'release_order', 'shuffle', 'marathon'] },
            ads: { type: 'boolean' },
            sources: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['key'],
                properties: { key: { type: 'string' } },
              },
            },
            tags: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      notes: { type: 'string' },
    },
  },
};

/**
 * Is this key real? One trivial call, so a wrong key fails at PASTE time rather
 * than twenty seconds into someone's first lineup build.
 *
 * Returns a plain {ok, error} — the caller shows the error verbatim, so it has
 * to read as something a person can act on rather than an HTTP status.
 */
export async function validateKey(apiKey) {
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) return { ok: true };
    if (res.status === 401) return { ok: false, error: 'Anthropic rejected that key. Check you copied all of it.' };
    if (res.status === 429) return { ok: false, error: 'That key is rate limited or out of credit right now.' };
    const body = await res.text().catch(() => '');
    return { ok: false, error: `Anthropic said ${res.status}. ${body.slice(0, 120)}` };
  } catch (e) {
    return { ok: false, error: `Couldn't reach Anthropic: ${e.message}` };
  }
}

/**
 * Ask Claude for a lineup. Returns the RAW parsed object plus usage/cost —
 * validation is the caller's job, deliberately, so every provider goes through
 * the same gate and none is graded on trust.
 */
export async function planWithClaude(digest, answers, {
  model = 'claude-haiku-4-5',
  apiKey = process.env.ANTHROPIC_API_KEY,
  channels,
} = {}) {
  if (!apiKey) throw new Error('no ANTHROPIC_API_KEY');

  // The make-me-a-channel path (§17): one free-text wish, one channel out. Same
  // digest, same schema, same validator — it is a LineupProposal that happens to
  // have length 1, so nothing downstream needs to know it is different.
  const one = channels === 1;
  const wish = String(answers.wish ?? '').trim();

  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      output_config: { format: PROPOSAL_FORMAT },
      messages: [{
        role: 'user',
        content:
          (one && wish
            ? `THE CHANNEL THEY ASKED FOR, in their words:\n"${wish}"\n\n`
            : '') +
          `PREFERENCES:\n${JSON.stringify({ ...answers, wish: undefined }, null, 1)}\n\n` +
          `CATALOG (key<TAB>kind<TAB>title):\n${promptCatalog(digest)}\n\n` +
          (one
            ? 'Build EXACTLY ONE channel that answers the request above. Draw on '
              + 'anything in the catalog that fits, even loosely — the point is the '
              + 'feeling they described, not a genre filter.'
            : `Build at most ${answers.channelCountN ?? 8} channels.`),
      }],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`anthropic HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const j = await res.json();
  if (j.stop_reason === 'refusal') throw new Error('model refused the request');

  const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const usage = j.usage || {};
  // Haiku 4.5 list price. Only used for the spike's cost line — the product
  // never needs to know.
  const PRICE = { in: 1.0, out: 5.0 };
  const cost = ((usage.input_tokens || 0) * PRICE.in + (usage.output_tokens || 0) * PRICE.out) / 1e6;

  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new Error('anthropic returned unparseable JSON (unexpected under structured outputs)'); }

  return {
    ...parsed,
    provider: `claude:${model}`,
    _usage: { in: usage.input_tokens, out: usage.output_tokens, cost },
  };
}
