import { config } from '../config.js';
import { getSetting } from '../db.js';

// Optional, never load-bearing. An OpenAI-compatible chat endpoint (Ollama by
// default) that returns JSON proposals a human reviews before anything changes.
// Settings override env so it can be configured without a restart.

export function llmConfig() {
  return {
    baseUrl: getSetting('llm_url', null) || config.llm.baseUrl,
    model: getSetting('llm_model', null) || config.llm.model,
    apiKey: getSetting('llm_key', null) || config.llm.apiKey,
  };
}

export function llmConfigured() {
  return !!llmConfig().baseUrl;
}

/**
 * Ask the model for a single JSON object. Returns the parsed object, or throws
 * with a plain message. Best-effort JSON extraction so a chatty model that
 * wraps the object in prose still works.
 */
export async function completeJSON(system, user, { timeoutMs = 45000 } = {}) {
  const { baseUrl, model, apiKey } = llmConfig();
  if (!baseUrl) throw new Error('No LLM configured.');
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.6,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`LLM returned ${res.status}${body ? `: ${body.slice(0, 160)}` : ''}`);
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? '';
  return parseLooseJSON(text);
}

function parseLooseJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    // Pull the first {...} block out of a chatty reply.
    const a = text.indexOf('{');
    const b = text.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(text.slice(a, b + 1));
      } catch {}
    }
    throw new Error('The model did not return valid JSON.');
  }
}
