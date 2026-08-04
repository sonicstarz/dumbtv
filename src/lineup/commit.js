// commit.js — turn an accepted proposal into channels, in one transaction.
//
// ── the rule this file exists to enforce ────────────────────────────────────
// IT CAN ONLY ADD. There is no UPDATE and no DELETE of an existing channel
// anywhere below, and that is a structural property rather than a policy: the
// only statements here are INSERTs, so no bug, no malformed proposal and no
// creative model output can destroy a lineup someone built by hand.
//
// This is not hypothetical caution. Config import once cleared the whole
// `channels` table (D-3) and took SPACE with it — the locked channel whose 403s
// exist precisely to stop that. A feature that writes channels from a language
// model's output has no business being one bug away from the same outcome.
//
// Rollback is the mirror: it deletes ONLY the ids this committer created, which
// are recorded at commit time. It never guesses from names or timestamps.

import { db, setSetting, getSetting } from '../db.js';
import { hashString } from '../util/rng.js';
import { setTags } from '../media/tags.js';
import { regenerateChannel } from '../schedule/generator.js';
// Through the FACADE, never plex/client.js directly — a Jellyfin user commits
// lineups too, and a schedule cached under one backend still plays after
// switching because stream URLs dispatch on the part-key prefix.
import { cacheSource } from '../media/backend.js';

const insertChannel = db.prepare(`
  INSERT INTO channels
    (number, name, slot_minutes, ordering_mode, marathon_size, shuffle_seed,
     dark_start, dark_end, ads_enabled, max_ads_per_break, ad_tags, enabled,
     created_at)
  VALUES (?,?,30,?,?,?,?,?,?,10,'',1,?)
`);

const insertSource = db.prepare(`
  INSERT OR IGNORE INTO channel_sources (channel_id, rating_key, source_type, title)
  VALUES (?,?,?,?)
`);

const insertRule = db.prepare(`
  INSERT INTO schedule_rules
    (channel_id, name, kind, priority, enabled, days_of_week, start_time,
     duration_min, ordering_mode, airdate_mode, select_tags, select_mode)
  VALUES (@channelId,@name,@kind,@priority,1,@daysOfWeek,@startTime,
          @durationMin,@orderingMode,@airdateMode,@selectTags,@selectMode)
`);

/** Rule priorities, matching the defaults the hand-built path uses. */
const PRIORITY = { blackout: 1000, pinned: 900, recurring: 500, airdate: 400, rotation: 0 };

/**
 * The seed, derived from the channel's identity rather than the clock.
 *
 * Invariant #5 lives or dies here: the same accepted proposal committed on the
 * Apple TV and on the Pi must produce the SAME playout, or "clone my lineup"
 * and the printed-guide promise are both lies. `createChannelFromLocalFolder`
 * already does this; copying the pattern is deliberate.
 */
export const seedFor = (name, sources) =>
  hashString(`ai:${name}:${sources.map((s) => s.key).sort().join(',')}`) & 0x7fffffff;

/** The next free channel number at or above `from`, skipping everything taken. */
function allocateNumbers(count, from = 2) {
  const taken = new Set(
    db.prepare('SELECT number FROM channels').all().map((r) => r.number)
  );
  const out = [];
  let n = from;
  while (out.length < count) {
    if (!taken.has(n)) { out.push(n); taken.add(n); }
    n++;
  }
  return out;
}

/**
 * Commit a validated proposal.
 *
 * @param {object} proposal  post-validation, post-review
 * @param {object} meta      { answers, provider } — persisted so a lineup is explainable
 * @returns {{channelIds:number[], numbers:number[]}}
 */
export const commitProposal = db.transaction((proposal, meta = {}) => {
  const numbers = allocateNumbers(proposal.channels.length);
  const channelIds = [];
  const now = Date.now();

  proposal.channels.forEach((c, i) => {
    // A model MAY suggest a number; the validator already dropped collisions,
    // and we allocate for real here regardless. Channel 1 is never handed out —
    // SPACE lives there and a locked channel is not ours to move.
    const number = c.number ?? numbers[i];
    const info = insertChannel.run(
      number,
      c.name,
      c.ordering,
      c.marathonSize ?? 3,
      seedFor(c.name, c.sources),
      c.dark?.start ?? null,
      c.dark?.end ?? null,
      c.ads ? 1 : 0,
      now
    );
    const id = Number(info.lastInsertRowid);
    channelIds.push(id);

    for (const s of c.sources) {
      insertSource.run(id, s.key, s.type, titleFor(s.key));
    }

    for (const r of c.rules || []) {
      insertRule.run({
        channelId: id,
        name: r.name ?? null,
        kind: r.kind,
        priority: PRIORITY[r.kind] ?? 0,
        daysOfWeek: r.daysOfWeek ? r.daysOfWeek.join(',') : null,
        startTime: r.startTime ?? null,
        durationMin: r.durationMin ?? null,
        orderingMode: r.ordering ?? null,
        airdateMode: r.airdateMode ?? null,
        selectTags: r.selectTags ? r.selectTags.join(',') : null,
        selectMode: r.selectMode === 'all' ? 'all' : 'any',
      });
    }

    // Channel-level tags go on its sources, so a later daypart can select by
    // them. Written under 'ai' so a rescan leaves them alone and someone who
    // disagrees with the model can drop every AI tag in one statement.
    if (c.tags?.length) {
      for (const s of c.sources) setTags(s.key, c.tags, 'ai');
    }
  });

  for (const t of proposal.itemTags || []) setTags(t.key, t.tags, 'ai');

  // Explainability: what was asked, what came back, and which channels it made.
  // Without this a lineup is a mystery three weeks later, and "re-run" has
  // nothing to diff against.
  setSetting('lineup_answers', JSON.stringify(meta.answers ?? null));
  setSetting('lineup_proposal', JSON.stringify(proposal));
  setSetting('lineup_provider', String(meta.provider ?? proposal.provider ?? ''));
  setSetting('lineup_committed_at', String(now));
  setSetting('lineup_channel_ids', JSON.stringify(channelIds));

  return { channelIds, numbers: channelIds.map((id) =>
    db.prepare('SELECT number FROM channels WHERE id=?').get(id).number) };
});

/**
 * Cache each source's contents, then fill the schedule.
 *
 * ── the step that is easy to miss ───────────────────────────────────────────
 * A `channel_sources` row is a POINTER. The generator schedules from `media`,
 * which is populated by `cacheSource` reaching out to Plex for a show's
 * episodes. Skip that and you get exactly what the first run of this code
 * produced: a channel with 33 sources and ONE program on it. It looks committed,
 * the API says ok, and the channel is dead air — the worst kind of failure
 * because nothing reports it.
 *
 * Deliberately OUTSIDE the transaction, and not just because it does network
 * I/O: generating two weeks across a dozen channels is slow, and holding a
 * write lock for it would stall the television that is playing right now.
 * Invariant #4 is safe either way — these channels have no past to protect.
 *
 * @param {function} onProgress  optional (done, total, label) for the UI
 */
export async function generateCommitted(channelIds, onProgress) {
  const rows = db.prepare(
    `SELECT channel_id, rating_key, source_type, title FROM channel_sources
     WHERE channel_id IN (${channelIds.map(() => '?').join(',')})`
  ).all(...channelIds);

  const failed = [];
  let done = 0;
  for (const r of rows) {
    // Packs and local folders already have their media registered — there is
    // nothing to fetch.
    if (r.source_type !== 'pack' && r.source_type !== 'local') {
      try { await cacheSource(r.rating_key, r.source_type); }
      catch (err) { failed.push({ title: r.title, error: err.message }); }
    }
    onProgress?.(++done, rows.length, r.title);
  }

  const channels = [];
  for (const id of channelIds) {
    regenerateChannel(id);
    const c = db.prepare('SELECT number, name FROM channels WHERE id=?').get(id);
    const programs = db.prepare('SELECT COUNT(*) n FROM programs WHERE channel_id=?').get(id).n;
    channels.push({ id, ...c, programs });
  }

  // A channel that ends up with nothing on it is dead air, and the person who
  // just pressed Build deserves to be told rather than to find out by tuning to
  // it. Reported, not thrown: the other channels are fine and are worth keeping.
  const empty = channels.filter((c) => c.programs === 0).map((c) => c.name);
  return { channels, failed, empty };
}

/**
 * Undo the last commit — and ONLY the last commit.
 *
 * Deletes by recorded id, never by name or timestamp, so a channel the user
 * built by hand cannot be caught in the blast radius even if it happens to
 * share a name. Sources and rules cascade.
 */
export const rollbackLast = db.transaction(() => {
  let ids = [];
  try { ids = JSON.parse(getSetting('lineup_channel_ids', '[]')) || []; } catch { ids = []; }
  if (!ids.length) return { removed: 0 };

  const del = db.prepare('DELETE FROM channels WHERE id = ? AND locked = 0');
  let removed = 0;
  for (const id of ids) removed += del.run(id).changes;

  // AI tags are a separate act of forgiveness — someone may want the lineup
  // gone but the tagging kept (it is what makes dayparting work at all).
  setSetting('lineup_channel_ids', '[]');
  return { removed };
});

/** Drop every tag the model ever applied. Independent of rollback, by design. */
export function forgetAiTags() {
  return db.prepare("DELETE FROM media_tags WHERE source='ai'").run().changes;
}

/** What the last run did, for the review screen's diff and the "last run" panel. */
export function lastRun() {
  const parse = (k) => { try { return JSON.parse(getSetting(k, 'null')); } catch { return null; } };
  return {
    answers: parse('lineup_answers'),
    proposal: parse('lineup_proposal'),
    provider: getSetting('lineup_provider', null),
    committedAt: Number(getSetting('lineup_committed_at', 0)) || null,
    channelIds: parse('lineup_channel_ids') || [],
  };
}

function titleFor(key) {
  const row = db.prepare('SELECT title FROM media WHERE rating_key = ?').get(key);
  if (row) return row.title;
  const pack = key.startsWith('pack:')
    ? db.prepare('SELECT name FROM packs WHERE id = ?').get(key.slice(5))
    : null;
  return pack?.name ?? key;
}
