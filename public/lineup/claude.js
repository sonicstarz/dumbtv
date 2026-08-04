// ─────────────────────────────────────────────────────────────────────────────
// SHARED MODULE. Loaded by the browser from public/, and imported directly by
// scripts/ under Node for tests. No fs, no db, no DOM.
// ─────────────────────────────────────────────────────────────────────────────

// claude.js — the Anthropic planner, called straight from the config UI.
//
// ── why the browser, and not a server route ─────────────────────────────────
// Because a server route only exists on the Node build. The same page is served
// by the Swift embedded server on iOS, tvOS and macOS, so a call made from the
// PAGE works on every platform dumbTV ships on, while a call made from the
// server would have needed a second implementation in Swift.
//
// Anthropic supports this deliberately: `anthropic-dangerous-direct-browser-
// access` opts a page into calling the API from client code. The header's name
// is a warning about the usual case — a public website exposing a shared key to
// strangers. That is not this case. The page is dumbTV's own config UI, served
// off the device on your LAN, and the key is the user's own, already stored on
// that device. Nobody is being exposed to anything they did not already hold.
//
// The key is passed in as an argument. This module never reads it from storage,
// never logs it, and never sends it anywhere except api.anthropic.com.

const API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5';
const TIMEOUT_MS = 120_000;

const HEADERS = (apiKey) => ({
  'x-api-key': apiKey,
  'anthropic-version': '2023-06-01',
  'anthropic-dangerous-direct-browser-access': 'true',
  'content-type': 'application/json',
});

export const SYSTEM_PROMPT = `You are programming a nostalgic broadcast TV lineup from a person's private media library.

You receive their preferences and their catalog. You emit ONLY a JSON object matching the schema: CHANNEL DEFINITIONS, never a schedule.

Principles:
- A channel is a theme with a voice, not a folder. 6 good channels beat 12 thin ones.
- Respect every "never" absolutely.
- Only use source keys that appear in the catalog. Never invent a key or a title.
- marathon suits one show with many episodes; release_order suits a show whose arc matters; shuffle suits variety and shorts; sequential is the default.
- Tag every channel with lowercase-kebab words.
- rationale: ONE sentence, addressed to the owner, saying why this channel earns a number on their dial.

If they asked for a daily rhythm, give the channels that deserve one a recurring rule — a daypart it belongs to. A lineup where nothing changes between breakfast and midnight is not a schedule, it is a playlist.`;

/** Compact the digest for the prompt — titles only, no prose. */
export function promptCatalog(digest) {
  const line = (t, kind) =>
    `${t.key}\t${kind}\t${t.title}${t.year ? ` (${t.year})` : ''}` +
    `${t.episodes ? ` [${t.episodes}ep]` : ''}` +
    `${t.genres?.length ? ` {${t.genres.slice(0, 3).join(',')}}` : ''}`;
  return [
    ...digest.shows.map((s) => line(s, 'show')),
    ...digest.movies.map((m) => line(m, 'movie')),
    ...digest.packs.map((p) => `${p.key}\tpack\t${p.title}`),
  ].join('\n');
}

/**
 * Structured outputs: every object closed with additionalProperties:false and a
 * required list, per the API's JSON-schema rules. Output is then guaranteed
 * parseable, so the retry loop a free-text provider needs cannot be reached.
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
          required: ['name', 'rationale', 'ordering', 'ads', 'sources', 'tags', 'rules'],
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
            // Dayparting. The first live run returned zero rules against a
            // rhythm the person had explicitly asked for, because the schema
            // made them optional and the prompt never mentioned them — so the
            // rule-based planner was producing better schedules than the model.
            // Required now, empty array allowed, and the prompt asks for them.
            rules: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['kind'],
                properties: {
                  kind: { type: 'string', enum: ['recurring', 'blackout'] },
                  name: { type: 'string' },
                  startTime: { type: 'string', description: 'HH:MM, 24-hour' },
                  durationMin: { type: 'integer' },
                  daysOfWeek: { type: 'array', items: { type: 'integer' } },
                },
              },
            },
          },
        },
      },
      notes: { type: 'string' },
    },
  },
};

/**
 * Is this key real? One trivial call, so a wrong key fails at PASTE time rather
 * than twenty seconds into someone's first lineup build. Returns a plain
 * {ok, error} whose message is shown verbatim, so it has to read as something a
 * person can act on rather than an HTTP status.
 */
export async function validateKey(apiKey) {
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: HEADERS(apiKey),
      body: JSON.stringify({ model: MODEL, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
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
 *
 * ONE attempt, no retry loop: a silent retry is what turns one press into three
 * charges on someone else's card.
 */
export async function planWithClaude(digest, answers, { apiKey, model = MODEL, channels } = {}) {
  if (!apiKey) throw new Error('No API key set');

  // The make-me-a-channel path: one free-text wish, one channel out. Same
  // digest, same schema, same validator — a proposal that happens to have
  // length 1, so nothing downstream needs to know it is different.
  const one = channels === 1;
  const wish = String(answers.wish ?? '').trim();

  const res = await fetch(API, {
    method: 'POST',
    headers: HEADERS(apiKey),
    body: JSON.stringify({
      model,
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      output_config: { format: PROPOSAL_FORMAT },
      messages: [{
        role: 'user',
        content:
          (one && wish ? `THE CHANNEL THEY ASKED FOR, in their words:\n"${wish}"\n\n` : '') +
          `PREFERENCES:\n${JSON.stringify({ ...answers, wish: undefined }, null, 1)}\n\n` +
          `CATALOG (key<TAB>kind<TAB>title):\n${promptCatalog(digest)}\n\n` +
          (one
            ? 'Build EXACTLY ONE channel that answers the request above. Draw on anything '
              + 'in the catalog that fits, even loosely — the point is the feeling they '
              + 'described, not a genre filter.'
            : `Build at most ${answers.channelCountN ?? 8} channels.`),
      }],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 401) throw new Error('Anthropic rejected your API key.');
    if (res.status === 429) throw new Error('Your Anthropic key is rate limited or out of credit.');
    throw new Error(`Anthropic said ${res.status}. ${body.slice(0, 160)}`);
  }
  const j = await res.json();
  if (j.stop_reason === 'refusal') throw new Error('The model declined to answer that.');

  const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const usage = j.usage || {};
  const PRICE = { in: 1.0, out: 5.0 };   // Haiku 4.5 list price, per MTok
  const cost = ((usage.input_tokens || 0) * PRICE.in + (usage.output_tokens || 0) * PRICE.out) / 1e6;

  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new Error('Anthropic returned something unreadable (unexpected under structured outputs).'); }

  return {
    ...parsed,
    provider: `claude:${model}`,
    _usage: { in: usage.input_tokens, out: usage.output_tokens, cost },
  };
}
