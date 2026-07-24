import { db } from '../db.js';
import { config } from '../config.js';
import { buildPlaylist } from './ordering.js';
import { makeRng, hashString } from '../util/rng.js';
import { MINUTE, DAY } from '../util/time.js';

function adPool(channel) {
  const tags = String(channel.ad_tags || '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

  const all = db
    .prepare(`SELECT * FROM assets WHERE kind IN ('ad','bumper') ORDER BY id`)
    .all();

  if (tags.length === 0) return all;

  const tagged = all.filter((a) => {
    const at = String(a.tags || '')
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    return at.some((t) => tags.includes(t));
  });

  // Falling back to the whole library beats an empty break.
  return tagged.length > 0 ? tagged : all;
}

// Aim for a short commercial break between shows, like real TV. There's no slot
// boundary to fill any more, so a break is just a couple of minutes of ads.
const AD_BREAK_TARGET_MS = 150 * 1000;

/**
 * A commercial break to sit between two programs. Ads up to the per-break cap or
 * ~2.5 minutes, then an optional station-ID bumper. No filler card — without a
 * slot boundary to hit, programs run straight into each other when there are no
 * ads, exactly like channel-surfing real broadcast TV.
 */
function buildAdBreak(channel, pool, seedKey) {
  const items = [];
  if (!channel.ads_enabled || pool.length === 0) return items;

  const rng = makeRng(hashString(seedKey));
  const ads = pool.filter((a) => a.kind === 'ad');
  const usable = ads.length > 0 ? ads : pool.filter((a) => a.kind !== 'bumper');
  const used = new Set();
  let placed = 0;
  let filled = 0;
  while (placed < channel.max_ads_per_break && filled < AD_BREAK_TARGET_MS) {
    let fits = usable.filter((a) => !used.has(a.id));
    // Only start repeating once every spot has already run this break.
    if (fits.length === 0) {
      used.clear();
      fits = usable;
    }
    if (fits.length === 0) break;
    const pick = fits[Math.floor(rng() * fits.length)];
    used.add(pick.id);
    items.push({ kind: 'ad', assetId: pick.id, title: pick.title, durationMs: pick.duration_ms });
    filled += pick.duration_ms;
    placed++;
  }

  const bumpers = pool.filter((a) => a.kind === 'bumper');
  if (bumpers.length > 0) {
    const pick = bumpers[Math.floor(rng() * bumpers.length)];
    items.push({ kind: 'bumper', assetId: pick.id, title: pick.title, durationMs: pick.duration_ms });
  }

  return items;
}

// A deterministic per-channel head start (up to 20 min) so channels aren't all
// in lock-step — switch channels and you land in the middle of different shows.
function staggerOffset(channel) {
  const rng = makeRng(hashString(`stagger:${channel.id}:${channel.shuffle_seed}`));
  return Math.floor(rng() * 20 * MINUTE);
}

/**
 * Extend a channel's schedule forward to `until`.
 * Append-only: already-generated programs are never rewritten, so a guide
 * you printed this morning is still correct tonight.
 */
// ---- rules ----------------------------------------------------------------

function hmToMin(hm) {
  const [h, m] = String(hm).split(':').map(Number);
  return h * 60 + m;
}

/**
 * Migrated installs already have rules. A channel created since (or in a fresh
 * DB) gets its defaults synthesised here: a rotation rule from its ordering, and
 * a blackout rule from any dark hours. Persisted so the UI can edit them later.
 */
function ensureChannelRules(channel) {
  const n = db.prepare('SELECT COUNT(*) n FROM schedule_rules WHERE channel_id = ?').get(channel.id).n;
  if (n > 0) return;
  db.prepare(
    `INSERT INTO schedule_rules (channel_id, name, kind, priority, enabled, ordering_mode, cursor)
     VALUES (?,?,?,?,1,?,?)`
  ).run(channel.id, 'Everything else', 'rotation', 0, channel.ordering_mode, channel.cursor || 0);
  if (channel.dark_start && channel.dark_end) {
    let dur = hmToMin(channel.dark_end) - hmToMin(channel.dark_start);
    if (dur <= 0) dur += 24 * 60;
    db.prepare(
      `INSERT INTO schedule_rules (channel_id, name, kind, priority, enabled, days_of_week, start_time, duration_min)
       VALUES (?,?,?,?,1,?,?,?)`
    ).run(channel.id, 'Off air', 'blackout', 1000, '0,1,2,3,4,5,6', channel.dark_start, dur);
  }
}

/** Occurrences of a day-of-week + local start time over [from, until). */
function dayTimeOccurrences(daysCsv, startTime, durationMin, from, until) {
  const days = new Set(
    String(daysCsv || '').split(',').map((s) => parseInt(s, 10)).filter((x) => !Number.isNaN(x))
  );
  if (days.size === 0 || !startTime || !durationMin) return [];
  const [sh, sm] = String(startTime).split(':').map(Number);
  const out = [];
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - 1); // catch a block that started yesterday and runs in
  for (let i = 0; i < 500 && d.getTime() < until; i++) {
    if (days.has(d.getDay())) {
      const start = new Date(d);
      start.setHours(sh, sm, 0, 0);
      const s = start.getTime();
      const e = s + durationMin * 60000;
      if (e > from && s < until) out.push({ start: s, end: e });
    }
    d.setDate(d.getDate() + 1);
  }
  return out;
}

const WEEK = 7 * DAY;

/** A show's episodes, in original-airdate order (undated fall to the back). */
function showEpisodes(ratingKey) {
  return db.prepare(
    `SELECT rating_key, aired, duration_ms, season_no, episode_no, title, show_title
     FROM media WHERE (parent_key = ? OR rating_key = ?) AND duration_ms > 0
     ORDER BY COALESCE(aired, '9999-99-99'), COALESCE(season_no, 0), COALESCE(episode_no, 0)`
  ).all(ratingKey, ratingKey);
}

/**
 * Air a show by its original release dates. Three strategies, all reading
 * media.aired (already cached from Plex), each occurrence tied to a specific
 * episode. Falls back to sequential order where dates are missing.
 *   original_weekday — one episode a week, in order, on the show's most common
 *                      original weekday (Batman aired Saturdays → airs Saturdays).
 *   anniversary      — each episode on its original month/day (holiday specials).
 */
function expandAirdate(rule, from, until) {
  const eps = showEpisodes(rule.rating_key);
  if (eps.length === 0) return [];
  const dated = eps.filter((e) => e.aired && /^\d{4}-\d{2}-\d{2}/.test(e.aired));
  const mode = rule.airdate_mode || 'original_weekday';
  const [sh, sm] = String(rule.start_time || '19:00').split(':').map(Number);
  const out = [];

  if (mode === 'anniversary') {
    const y0 = new Date(from).getFullYear();
    const y1 = new Date(until).getFullYear();
    for (const e of dated) {
      const m = e.aired.match(/^(\d{4})-(\d{2})-(\d{2})/);
      const mm = Number(m[2]) - 1, dd = Number(m[3]);
      for (let y = y0; y <= y1; y++) {
        const start = new Date(y, mm, dd, sh, sm, 0, 0).getTime();
        const end = start + e.duration_ms;
        if (end > from && start < until) out.push({ start, end, rule, ratingKey: e.rating_key });
      }
    }
    return out;
  }

  // original_weekday
  let weekday = 6;
  if (dated.length) {
    const counts = new Array(7).fill(0);
    for (const e of dated) counts[new Date(`${e.aired}T12:00:00`).getDay()]++;
    weekday = counts.indexOf(Math.max(...counts));
  } else if (rule.days_of_week) {
    weekday = parseInt(String(rule.days_of_week).split(',')[0], 10) || 6;
  }
  const seq = dated.length ? dated.concat(eps.filter((e) => !e.aired)) : eps;

  // Episode index is a stable function of the calendar week, anchored to
  // effective_from (so the series starts from the top when the rule takes hold).
  const anchor = new Date(rule.effective_from ? `${rule.effective_from}T00:00:00` : '2020-01-06T00:00:00');
  anchor.setHours(0, 0, 0, 0);
  while (anchor.getDay() !== weekday) anchor.setDate(anchor.getDate() + 1);
  const anchorMs = anchor.getTime();

  const cur = new Date(Math.max(from - WEEK, anchorMs));
  cur.setHours(0, 0, 0, 0);
  while (cur.getDay() !== weekday) cur.setDate(cur.getDate() + 1);
  for (let i = 0; i < 800; i++) {
    const slot = new Date(cur);
    slot.setHours(sh, sm, 0, 0);
    const start = slot.getTime();
    if (start >= until) break;
    const midnight = new Date(cur); midnight.setHours(0, 0, 0, 0);
    const idx = Math.round((midnight.getTime() - anchorMs) / WEEK);
    if (idx >= 0) {
      const ep = seq[((idx % seq.length) + seq.length) % seq.length];
      const end = start + ep.duration_ms;
      if (end > from && start < until) out.push({ start, end, rule, ratingKey: ep.rating_key });
    }
    cur.setDate(cur.getDate() + 7);
  }
  return out;
}

/** Expand one rule into concrete [start, end) occurrences inside the window. */
function expandRule(rule, from, until) {
  const effFrom = rule.effective_from ? Date.parse(`${rule.effective_from}T00:00:00`) : -Infinity;
  const effTo = rule.effective_to ? Date.parse(`${rule.effective_to}T23:59:59`) : Infinity;
  const lo = Math.max(from, effFrom);
  const hi = Math.min(until, effTo);
  if (lo >= hi) return [];

  if (rule.kind === 'blackout' || rule.kind === 'recurring') {
    return dayTimeOccurrences(rule.days_of_week, rule.start_time, rule.duration_min, lo, hi)
      .map((o) => ({ ...o, rule }));
  }
  if (rule.kind === 'pinned' && rule.starts_at_utc) {
    const m = db.prepare('SELECT duration_ms FROM media WHERE rating_key = ?').get(rule.rating_key);
    const dur = m && m.duration_ms ? m.duration_ms : 0;
    if (dur <= 0) return [];
    const s = rule.starts_at_utc;
    const e = s + dur;
    if (e > lo && s < hi) return [{ start: s, end: e, rule, ratingKey: rule.rating_key }];
  }
  if (rule.kind === 'airdate') return expandAirdate(rule, lo, hi);
  return [];
}

const overlaps = (a, b) => a.start < b.end && b.start < a.end;

// ---- rotation iterator (shared across every gap in one build) --------------

function makeRotationIterator(channel) {
  // Default: walk the ordered playlist with a monotonic cursor (deterministic,
  // wraps at the end). With a repeat cooldown, switch to least-recently-aired
  // selection instead — it maximises the gap before any item airs again, seeded
  // from persisted airings so the spacing also holds across builds.
  const cooldownMs = (channel.cooldown_days || 0) * DAY;
  const base = buildPlaylist(channel, 0);
  let cursor = channel.cursor || 0;
  let cachedCycle = -1;
  let cachedList = base;
  function refresh() {
    if (!cachedList.length) return;
    const cycle = Math.floor(cursor / cachedList.length);
    if (cycle !== cachedCycle) {
      cachedCycle = cycle;
      cachedList = channel.ordering_mode === 'shuffle' ? buildPlaylist(channel, cycle) : base;
    }
  }
  const lastAired = new Map();
  if (cooldownMs > 0) {
    for (const r of db.prepare('SELECT rating_key, last_aired FROM airings WHERE channel_id = ?').all(channel.id)) {
      if (r.last_aired) lastAired.set(r.rating_key, r.last_aired);
    }
  }
  return {
    empty: base.length === 0,
    pickAt() {
      if (cooldownMs <= 0) { refresh(); return cachedList[cursor % cachedList.length]; }
      let best = null, bestLA = Infinity;
      for (const item of base) {
        const la = lastAired.has(item.rating_key) ? lastAired.get(item.rating_key) : -Infinity;
        if (la < bestLA) { bestLA = la; best = item; }
      }
      return best;
    },
    note(item, endTime) {
      cursor += 1;
      if (cooldownMs > 0 && item && item.rating_key) lastAired.set(item.rating_key, endTime);
    },
    cursor: () => cursor,
  };
}

// ---- program builders ------------------------------------------------------

function airingNo(ctx, ratingKey) {
  const existing =
    db.prepare('SELECT count FROM airings WHERE channel_id = ? AND rating_key = ?')
      .get(ctx.channel.id, ratingKey)?.count || 0;
  const bumped = ctx.airingBump.get(ratingKey) || 0;
  ctx.airingBump.set(ratingKey, bumped + 1);
  return existing + bumped + 1;
}

function pushProgram(ctx, item, start, blockStart, ruleId) {
  const airing = item.rating_key ? airingNo(ctx, item.rating_key) : 1;
  ctx.rows.push({
    channelId: ctx.channel.id,
    startUtc: start,
    endUtc: start + item.duration_ms,
    durationMs: item.duration_ms,
    kind: item.kind === 'movie' ? 'movie' : 'episode',
    ratingKey: item.rating_key,
    assetId: null,
    title: item.show_title || item.title,
    subtitle: item.show_title ? item.title : null,
    seasonNo: item.season_no ?? null,
    episodeNo: item.episode_no ?? null,
    slotStart: blockStart,
    ruleId,
    airingNo: airing,
  });
}

function pushSpan(ctx, kind, start, end, title, subtitle, ruleId, assetId = null) {
  ctx.rows.push({
    channelId: ctx.channel.id,
    startUtc: start,
    endUtc: end,
    durationMs: end - start,
    kind,
    ratingKey: null,
    assetId,
    title,
    subtitle: subtitle ?? null,
    seasonNo: null,
    episodeNo: null,
    slotStart: start,
    ruleId,
    airingNo: 1,
  });
}

/**
 * Fill [start, end) with rotation content back-to-back, plus ad breaks. Programs
 * never overrun `end` (protect policy); whatever's left over is padded with a
 * filler so there's zero dead air before the next reservation. Reused for gaps
 * and for recurring blocks — filling a reserved 3-hour Saturday and an unclaimed
 * Tuesday afternoon are the same operation with different bounds.
 */
function fillWindow(ctx, ruleId, start, end) {
  let t = start;
  let guard = 0;
  while (t < end && guard++ < 50000) {
    const item = ctx.iter.pickAt(t);
    if (!item || !item.duration_ms) { ctx.iter.note(item, t); continue; }
    if (t + item.duration_ms > end) break; // won't fit before the hard end
    const blockStart = t;
    pushProgram(ctx, item, t, blockStart, ruleId);
    t += item.duration_ms;
    ctx.iter.note(item, t);
    for (const bi of buildAdBreak(ctx.channel, ctx.pool, `${ctx.channel.id}:${blockStart}`)) {
      if (t + bi.durationMs > end) break;
      pushSpan(ctx, bi.kind, t, t + bi.durationMs, bi.title, null, ruleId, bi.assetId);
      t += bi.durationMs;
    }
  }
  if (t < end) pushSpan(ctx, 'filler', t, end, ctx.channel.name, null, ruleId);
  return end;
}

function fillRange(ctx, ruleId, start, end) {
  if (start >= end) return end;
  if (ctx.iter.empty) {
    pushSpan(ctx, 'offair', start, end, 'No content selected', 'Add shows or movies to this channel', ruleId);
    return end;
  }
  return fillWindow(ctx, ruleId, start, end);
}

function emitReservation(ctx, res, until) {
  const end = Math.min(res.end, until);
  if (res.start >= end) return;
  const rule = res.rule;
  if (rule.kind === 'blackout') {
    pushSpan(ctx, 'offair', res.start, end, 'Off air', null, rule.id);
    return;
  }
  // A reservation that names a specific episode (pinned, airdate) plays exactly it.
  const rk = res.ratingKey || (rule.kind === 'pinned' ? rule.rating_key : null);
  if (rk) {
    const m = db.prepare('SELECT * FROM media WHERE rating_key = ?').get(rk);
    if (m) {
      pushProgram(ctx, {
        rating_key: m.rating_key, kind: m.kind, title: m.title, show_title: m.show_title,
        season_no: m.season_no, episode_no: m.episode_no, duration_ms: m.duration_ms,
      }, res.start, res.start, rule.id);
      if (res.start + m.duration_ms < end) {
        pushSpan(ctx, 'filler', res.start + m.duration_ms, end, ctx.channel.name, null, rule.id);
      }
    } else {
      pushSpan(ctx, 'offair', res.start, end, rule.name || 'Scheduled', null, rule.id);
    }
    return;
  }
  // recurring: fill the reserved block with rotation content.
  fillRange(ctx, rule.id, res.start, end);
}

const insertProgramV2 = db.prepare(`
  INSERT INTO programs
    (channel_id, start_utc, end_utc, duration_ms, kind, rating_key, asset_id,
     title, subtitle, season_no, episode_no, slot_start, rule_id, airing_no)
  VALUES
    (@channelId, @startUtc, @endUtc, @durationMs, @kind, @ratingKey, @assetId,
     @title, @subtitle, @seasonNo, @episodeNo, @slotStart, @ruleId, @airingNo)
`);

/**
 * Two-pass reserve-then-fill, with no side effects. Pass 1 places reservations
 * (blackout, pinned, recurring) highest priority first, reporting — never
 * silently dropping — anything that loses its slot. Pass 2 fills every gap with
 * rotation. Returns the rows + conflicts; the caller decides whether to commit.
 */
function buildChannelPrograms(channel, from, until) {
  const rules = db
    .prepare('SELECT * FROM schedule_rules WHERE channel_id = ? AND enabled = 1 ORDER BY priority DESC, id')
    .all(channel.id);
  const rotationRule = rules.find((r) => r.kind === 'rotation') || { id: null };

  // Pass 1 — reservations.
  const reservations = [];
  const conflicts = [];
  for (const rule of rules) {
    if (rule.kind === 'rotation') continue;
    for (const occ of expandRule(rule, from, until)) {
      const clash = reservations.find((r) => overlaps(r, occ));
      if (clash) {
        conflicts.push({ rule: rule.name || rule.kind, at: occ.start, lostTo: clash.rule.name || clash.rule.kind });
      } else {
        reservations.push(occ);
      }
    }
  }
  reservations.sort((a, b) => a.start - b.start);

  // Pass 2 — fill.
  const ctx = {
    channel,
    rows: [],
    pool: adPool(channel),
    iter: makeRotationIterator(channel),
    airingBump: new Map(),
  };

  let t = from;
  let ri = 0;
  let guard = 0;
  while (t < until && guard++ < 200000) {
    const res = reservations[ri];
    if (!res || res.start >= until) {
      fillRange(ctx, rotationRule.id, t, until);
      t = until;
      break;
    }
    if (t < res.start) {
      fillRange(ctx, rotationRule.id, t, res.start);
      t = res.start;
    }
    emitReservation(ctx, res, until);
    t = Math.max(t, Math.min(res.end, until));
    ri++;
  }

  return { rows: ctx.rows, conflicts, cursor: ctx.iter.cursor(), airingBump: ctx.airingBump, through: t, rotationRuleId: rotationRule.id };
}

export function generateChannel(channelId, until = Date.now() + config.scheduleWindowDays * DAY) {
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  if (!channel) throw new Error(`No channel ${channelId}`);
  ensureChannelRules(channel);

  const now = Date.now();
  const from = channel.generated_thru && channel.generated_thru > now
    ? channel.generated_thru
    : now - staggerOffset(channel);
  if (from >= until) return { added: 0, reason: 'already built', conflicts: [] };

  const built = buildChannelPrograms(channel, from, until);

  const commit = db.transaction(() => {
    for (const r of built.rows) insertProgramV2.run(r);
    db.prepare('UPDATE channels SET cursor = ?, generated_thru = ? WHERE id = ?')
      .run(built.cursor, built.through, channel.id);
    if (built.rotationRuleId) {
      db.prepare('UPDATE schedule_rules SET cursor = ? WHERE id = ?').run(built.cursor, built.rotationRuleId);
    }
    const upAiring = db.prepare(`
      INSERT INTO airings (channel_id, rating_key, count, last_aired)
      VALUES (?,?,?,?)
      ON CONFLICT(channel_id, rating_key) DO UPDATE SET
        count = count + excluded.count,
        last_aired = MAX(COALESCE(last_aired, 0), excluded.last_aired)
    `);
    for (const [rk, n] of built.airingBump) {
      const lastEnd = built.rows.filter((x) => x.ratingKey === rk).reduce((mx, x) => Math.max(mx, x.endUtc), 0);
      upAiring.run(channel.id, rk, n, lastEnd);
    }
  });
  commit();

  return { added: built.rows.length, through: built.through, conflicts: built.conflicts };
}

/**
 * Dry-run: what a regeneration would produce over the next `days`, without
 * writing anything. Powers the preview-before-commit and conflict inspector.
 */
export function previewChannel(channelId, days = 7) {
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  if (!channel) throw new Error(`No channel ${channelId}`);
  ensureChannelRules(channel);
  const now = Date.now();
  const last = db
    .prepare('SELECT MAX(end_utc) AS e FROM programs WHERE channel_id = ? AND start_utc < ?')
    .get(channelId, now);
  const from = last && last.e && last.e > now ? last.e : now;
  const until = from + days * DAY;
  const built = buildChannelPrograms(channel, from, until);
  return { from, until, conflicts: built.conflicts, programs: built.rows };
}

/** Throw away everything not yet aired and rebuild — atomically, so the engine
 *  reading once a second never sees a half-written schedule. */
export function regenerateChannel(channelId) {
  const now = Date.now();
  return db.transaction(() => {
    db.prepare('DELETE FROM programs WHERE channel_id = ? AND start_utc >= ?').run(channelId, now);
    const last = db
      .prepare('SELECT MAX(end_utc) AS e FROM programs WHERE channel_id = ? AND start_utc < ?')
      .get(channelId, now);
    const through = last && last.e ? last.e : now;
    db.prepare('UPDATE channels SET generated_thru = ? WHERE id = ?').run(through, channelId);
    return generateChannel(channelId);
  })();
}

/** Top every channel up to the rolling window, and sweep old programs. */
export function ensureSchedule() {
  const until = Date.now() + config.scheduleWindowDays * DAY;
  const channels = db.prepare('SELECT id FROM channels WHERE enabled = 1').all();
  const results = [];
  for (const c of channels) {
    results.push({ channelId: c.id, ...generateChannel(c.id, until) });
  }
  db.prepare('DELETE FROM programs WHERE end_utc < ?').run(Date.now() - 2 * DAY);
  return results;
}
