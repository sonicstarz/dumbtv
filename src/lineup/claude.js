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
 * Ask Claude for a lineup. Returns the RAW parsed object plus usage/cost —
 * validation is the caller's job, deliberately, so every provider goes through
 * the same gate and none is graded on trust.
 */
export async function planWithClaude(digest, answers, {
  model = 'claude-haiku-4-5',
  apiKey = process.env.ANTHROPIC_API_KEY,
} = {}) {
  if (!apiKey) throw new Error('no ANTHROPIC_API_KEY');

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
          `PREFERENCES:\n${JSON.stringify(answers, null, 1)}\n\n` +
          `CATALOG (key<TAB>kind<TAB>title):\n${promptCatalog(digest)}\n\n` +
          `Build at most ${answers.channelCountN ?? 8} channels.`,
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
