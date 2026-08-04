// ─────────────────────────────────────────────────────────────────────────────
// SHARED MODULE. Loaded by the browser from public/, and imported directly by
// scripts/ under Node for tests. No fs, no db, no DOM.
// ─────────────────────────────────────────────────────────────────────────────

// apply.js — turn an accepted proposal into real channels on this device.
//
// ── the rule this file exists to enforce ────────────────────────────────────
// IT CAN ONLY ADD. Every request it makes is a POST that creates something.
// There is no PATCH and no DELETE of anything it did not itself create moments
// earlier, so no bug and no creative model output can damage a lineup somebody
// built by hand.
//
// That is not hypothetical caution. Config import once cleared the whole
// channels table (D-3) and took SPACE with it — the locked channel whose 403s
// exist precisely to stop that. A feature that writes channels from a language
// model's output has no business being one bug away from the same outcome.
//
// The server-side version of this ran in a SQLite transaction, which was
// stronger: all-or-nothing. Over HTTP there is no transaction, so instead we
// record every id as it is created and can undo exactly those and nothing else.
// A half-finished build is therefore recoverable rather than mysterious.

/** Where the undo record lives, so a refresh doesn't strand half a lineup. */
const LAST_RUN = 'lineup_last_run';

/**
 * Create the channels.
 *
 * @param {object} proposal  post-validation, post-review
 * @param {object} opts
 * @param {(path:string, init?:object)=>Promise<any>} opts.api
 * @param {(done:number,total:number,label:string)=>void} [opts.onProgress]
 */
export async function applyProposal(proposal, { api, onProgress } = {}) {
  const created = [];
  const failed = [];
  const total = proposal.channels.length;

  try {
    for (const [i, c] of proposal.channels.entries()) {
      onProgress?.(i, total, c.name);

      // The server picks the number (N2: never collide) and derives the shuffle
      // seed from name+number — identically on Node and Swift, verified
      // byte-identical — so the same lineup plays the same way on every device
      // it is applied to. Nothing here invents either value.
      const ch = await api('/api/channels', {
        method: 'POST',
        body: {
          name: c.name,
          orderingMode: c.ordering,
          marathonSize: c.marathonSize ?? 3,
          adsEnabled: !!c.ads,
          darkStart: c.dark?.start ?? null,
          darkEnd: c.dark?.end ?? null,
        },
      });
      created.push({ id: ch.id, number: ch.number, name: c.name });

      // Adding sources also caches each show's episodes and regenerates the
      // schedule — that is what this endpoint has always done for the hand-built
      // path. Skipping it is how an earlier version of this feature produced a
      // channel with 33 sources and ONE programme on it: the rows existed, the
      // media did not, and nothing reported it.
      if (c.sources.length) {
        await api(`/api/channels/${ch.id}/sources`, {
          method: 'POST',
          body: {
            items: c.sources.map((s) => ({
              ratingKey: s.key,
              sourceType: s.type || 'show',
              title: s.title || s.key,
            })),
          },
        });
      }

      for (const r of c.rules || []) {
        try {
          await api(`/api/channels/${ch.id}/rules`, { method: 'POST', body: rulePayload(r) });
        } catch (err) {
          // A rejected daypart is a worse channel, not a broken one. Say so and
          // keep the channel rather than throwing the whole build away.
          failed.push({ channel: c.name, what: r.name || r.kind, error: err.message });
        }
      }
    }
  } catch (err) {
    // Partial failure. Leave what was made — it is real, working television —
    // and hand back the ids so the UI can offer a clean undo.
    remember(created, proposal);
    onProgress?.(total, total, '');
    return { created, failed, error: err.message, partial: true };
  }

  remember(created, proposal);
  onProgress?.(total, total, '');
  return { created, failed, partial: false };
}

/**
 * Which channels ended up with nothing playable on them.
 *
 * A channel that reports success and plays dead air is the worst failure this
 * feature has, because tuning to it is the only way to find out. Asked
 * afterwards so the answer reflects what the server actually scheduled rather
 * than what we hoped it would.
 */
export async function findEmpty(created, { api }) {
  const empty = [];
  let list = [];
  try { list = (await api('/api/channels')).channels || []; } catch { return empty; }
  const byId = new Map(list.map((c) => [c.id, c]));
  for (const c of created) {
    const live = byId.get(c.id);
    // `itemCount` is the cached media count per source on this endpoint — NOT
    // `count`, which is undefined and would have made every channel look empty.
    const n = (live?.sources || []).reduce((sum, s) => sum + (s.itemCount ?? 0), 0);
    if (!n) empty.push(c.name);
  }
  return empty;
}

/**
 * Undo the last build — and ONLY the last build.
 *
 * Deletes by recorded id, never by name or timestamp, so a channel somebody
 * built by hand cannot be caught in the blast radius even if it happens to
 * share a name. A locked channel refuses with a 403 of its own, which is
 * swallowed here: the point is to undo our own mess, not to fight the server.
 */
export async function undoLast({ api, created } = {}) {
  // `created` may be passed straight from applyProposal. Falling back to the
  // stored record covers a page reload, but storage is not always there —
  // private browsing, and Node under test — so it must not be the only path.
  const run = lastRun();
  const list = created ?? run.created ?? [];
  let removed = 0;
  for (const c of list) {
    try { await api(`/api/channels/${c.id}`, { method: 'DELETE' }); removed++; }
    catch { /* already gone, or locked — either way not ours to force */ }
  }
  save({ ...run, created: [] });
  return { removed };
}

export function lastRun() {
  try { return JSON.parse(localStorage.getItem(LAST_RUN) || '{}') || {}; }
  catch { return {}; }
}

function remember(created, proposal) {
  save({
    created,
    provider: proposal.provider,
    channels: proposal.channels.length,
    at: Date.now(),
  });
}

function save(v) {
  try { localStorage.setItem(LAST_RUN, JSON.stringify(v)); } catch { /* private mode */ }
}

/** Map a proposal rule onto what POST /api/channels/:id/rules expects. */
function rulePayload(r) {
  return {
    name: r.name ?? null,
    kind: r.kind,
    daysOfWeek: r.daysOfWeek?.length ? r.daysOfWeek.join(',') : null,
    startTime: r.startTime ?? null,
    durationMin: r.durationMin ?? null,
    orderingMode: r.ordering ?? null,
    airdateMode: r.airdateMode ?? null,
  };
}
