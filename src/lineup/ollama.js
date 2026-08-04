// ollama.js — the Pi / Node-self-host planner.
//
// Owner decision 2026-08-03: Apple's on-device model is the primary provider on
// Apple hardware (the phone plans during the link flow and pushes the result to
// the TV — FoundationModels is absent from tvOS). Ollama is what a Pi or a
// Node self-host uses instead, since neither has Apple silicon, and the LAN box
// running Ollama is very often the Plex machine itself.
//
// No cloud provider exists in this file or anywhere else: the privacy call was
// local-only, so nothing here can send a library catalog off the network.

const DEFAULT_BASE = process.env.DUMBTV_OLLAMA || 'http://127.0.0.1:11434';
const TIMEOUT_MS = 180_000;

/** The output contract, as a JSON schema Ollama will constrain generation to. */
export const PROPOSAL_SCHEMA = {
  type: 'object',
  required: ['channels'],
  properties: {
    channels: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'rationale', 'ordering', 'sources'],
        properties: {
          name: { type: 'string' },
          rationale: { type: 'string' },
          ordering: { type: 'string', enum: ['sequential', 'release_order', 'shuffle', 'marathon'] },
          ads: { type: 'boolean' },
          sources: {
            type: 'array',
            items: {
              type: 'object',
              required: ['key'],
              properties: { key: { type: 'string' }, type: { type: 'string' } },
            },
          },
          tags: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    notes: { type: 'string' },
  },
};

export const SYSTEM_PROMPT = `You are programming a nostalgic broadcast TV lineup from a person's private media library.

You receive their preferences and their catalog. You emit ONLY a JSON object matching the schema: CHANNEL DEFINITIONS, never a schedule.

Principles:
- A channel is a theme with a voice, not a folder. 6 good channels beat 12 thin ones.
- Respect every "never" absolutely.
- Only use source keys that appear in the catalog. Never invent a key or a title.
- marathon suits one show with many episodes; release_order suits a show whose arc matters; shuffle suits variety and shorts; sequential is the default.
- Tag every channel with lowercase-kebab words.
- rationale: ONE sentence, addressed to the owner, saying why this channel earns a number on their dial.`;

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
 * Ask a local model for a lineup. Returns the RAW parsed object — validation is
 * the caller's job, deliberately, so every provider goes through the same gate.
 */
export async function planWithOllama(digest, answers, { model = 'llama3.2:3b', base = DEFAULT_BASE } = {}) {
  const body = {
    model,
    stream: false,
    format: PROPOSAL_SCHEMA,
    options: { num_ctx: 32768, temperature: 0.7 },
    keep_alive: '5m',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content:
          `PREFERENCES:\n${JSON.stringify(answers, null, 1)}\n\n` +
          `CATALOG (key<TAB>kind<TAB>title):\n${promptCatalog(digest)}\n\n` +
          `Build at most ${answers.channelCountN ?? 8} channels.`,
      },
    ],
  };

  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`ollama HTTP ${res.status}`);
  const j = await res.json();
  const text = j?.message?.content ?? '';
  try {
    return { ...JSON.parse(text), provider: `ollama:${model}` };
  } catch {
    throw new Error('ollama returned unparseable JSON');
  }
}

/** Which models this box actually has — the UI needs it, the spike prints it. */
export async function listModels(base = DEFAULT_BASE) {
  try {
    const r = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return [];
    return ((await r.json()).models || []).map((m) => m.name);
  } catch { return []; }
}
