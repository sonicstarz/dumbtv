// config-format.js — the portable lineup format, version 3.
//
// One file that both engines emit and accept, so a lineup can move between a Pi,
// a Windows box and an Apple TV. v2 was raw SQLite rows, which bound the format
// to the Node schema and left the importer composing SQL column names out of
// whatever keys the uploaded file happened to carry.
//
// v3 fixes three things:
//   · Engine-neutral names (the API spelling, not column names), so Swift and
//     Node emit identical bytes.
//   · Sources, excludes and rules NEST INSIDE their channel, so there is no
//     cross-table id remapping to get wrong — the old importer's idMap existed
//     only because the tables were flat.
//   · A fixed field whitelist, so an uploaded file can never name a column.
//
// Two things deliberately never travel:
//   · SECRETS — Plex/Jellyfin credentials, the PIN hash, the session secret.
//     A cloned lineup relinks its own server.
//   · SCHEDULES — `programs` rows are per-device by construction. Import
//     regenerates from the local clock; determinism is a property of a device,
//     not of a file. What DOES travel is `shuffleSeed`, without which the same
//     lineup would play in a different order on the new box (invariant #5).

export const CONFIG_VERSION = 3;

/** Channel fields that round-trip. Anything not here is device-local. */
export const CHANNEL_FIELDS = [
  'number', 'name', 'slotMinutes', 'orderingMode', 'marathonSize', 'shuffleSeed',
  'darkStart', 'darkEnd', 'adsEnabled', 'maxAdsPerBreak', 'adTags',
  'timingMode', 'adsBetween', 'cooldownDays', 'overrunPolicy', 'enabled',
  // L-V1: a channel's look is part of the lineup — a clone that arrives
  // looking different is not the same lineup.
  'vibe',
];

export const SOURCE_FIELDS = ['ratingKey', 'sourceType', 'title'];

export const RULE_FIELDS = [
  'name', 'kind', 'priority', 'enabled', 'daysOfWeek', 'startTime', 'durationMin',
  'startsAtUtc', 'sourceType', 'ratingKey', 'orderingMode', 'effectiveFrom',
  'effectiveTo', 'adPolicy', 'airdateMode', 'cadenceCompress', 'effectiveAnnual',
];

/**
 * Settings that describe the LINEUP rather than the box. Credentials, first-run
 * flags and runtime state are all absent on purpose — see the header.
 */
export const SETTING_FIELDS = [
  'kidsMode', 'kidsSafeChannels', 'mediaBackend', 'loudnessTarget', 'timezone',
];

/** camelCase API name → snake_case column, for the tables v3 writes. */
export const CHANNEL_COLUMNS = {
  number: 'number', name: 'name', slotMinutes: 'slot_minutes',
  orderingMode: 'ordering_mode', marathonSize: 'marathon_size',
  shuffleSeed: 'shuffle_seed', darkStart: 'dark_start', darkEnd: 'dark_end',
  adsEnabled: 'ads_enabled', maxAdsPerBreak: 'max_ads_per_break', adTags: 'ad_tags',
  timingMode: 'timing_mode', adsBetween: 'ads_between', cooldownDays: 'cooldown_days',
  overrunPolicy: 'overrun_policy', enabled: 'enabled', vibe: 'vibe',
};

export const RULE_COLUMNS = {
  name: 'name', kind: 'kind', priority: 'priority', enabled: 'enabled',
  daysOfWeek: 'days_of_week', startTime: 'start_time', durationMin: 'duration_min',
  startsAtUtc: 'starts_at_utc', sourceType: 'source_type', ratingKey: 'rating_key',
  orderingMode: 'ordering_mode', effectiveFrom: 'effective_from',
  effectiveTo: 'effective_to', adPolicy: 'ad_policy', airdateMode: 'airdate_mode',
  cadenceCompress: 'cadence_compress', effectiveAnnual: 'effective_annual',
};

const BOOL_CHANNEL_FIELDS = new Set(['adsEnabled', 'enabled']);

/** Take only known fields, coercing booleans — an uploaded file cannot smuggle a column. */
export function pickChannel(obj) {
  const out = {};
  for (const f of CHANNEL_FIELDS) {
    if (obj[f] === undefined) continue;
    if (f === 'vibe') {
      // Travels as a document, stored as text. null stays null (inherit).
      out[f] = obj[f] ? JSON.stringify(obj[f]) : null;
    } else {
      out[f] = BOOL_CHANNEL_FIELDS.has(f) ? (obj[f] ? 1 : 0) : obj[f];
    }
  }
  return out;
}

export function pickRule(obj) {
  const out = {};
  for (const f of RULE_FIELDS) {
    if (obj[f] === undefined) continue;
    out[f] = f === 'enabled' ? (obj[f] ? 1 : 0) : obj[f];
  }
  return out;
}

export function pickSource(obj) {
  const out = {};
  for (const f of SOURCE_FIELDS) if (obj[f] !== undefined) out[f] = obj[f];
  return out;
}

/**
 * Read a v2 file (flat tables, raw column names) into the v3 shape, so an older
 * backup still restores. Accepted for one release; only v3 is emitted.
 */
export function upgradeV2(cfg) {
  const byChannel = (rows, key) => {
    const m = new Map();
    for (const r of rows || []) {
      if (!m.has(r[key])) m.set(r[key], []);
      m.get(r[key]).push(r);
    }
    return m;
  };
  const srcs = byChannel(cfg.sources, 'channel_id');
  const rules = byChannel(cfg.rules, 'channel_id');
  const excl = byChannel(cfg.excludes, 'channel_id');

  return {
    version: CONFIG_VERSION,
    exportedAt: cfg.exportedAt ?? null,
    origin: { platform: 'unknown', appVersion: null, upgradedFrom: 2 },
    channels: (cfg.channels || []).map((c) => ({
      key: `ch-${c.id}`,
      number: c.number, name: c.name, slotMinutes: c.slot_minutes,
      orderingMode: c.ordering_mode, marathonSize: c.marathon_size,
      shuffleSeed: c.shuffle_seed, darkStart: c.dark_start, darkEnd: c.dark_end,
      adsEnabled: !!c.ads_enabled, maxAdsPerBreak: c.max_ads_per_break,
      adTags: c.ad_tags, timingMode: c.timing_mode, adsBetween: c.ads_between,
      cooldownDays: c.cooldown_days, overrunPolicy: c.overrun_policy,
      enabled: !!c.enabled,
      sources: (srcs.get(c.id) || []).map((s) => ({
        ratingKey: s.rating_key, sourceType: s.source_type, title: s.title,
      })),
      excludes: (excl.get(c.id) || []).map((e) => e.rating_key),
      rules: (rules.get(c.id) || []).map((r) => ({
        name: r.name, kind: r.kind, priority: r.priority, enabled: !!r.enabled,
        daysOfWeek: r.days_of_week, startTime: r.start_time, durationMin: r.duration_min,
        startsAtUtc: r.starts_at_utc, sourceType: r.source_type, ratingKey: r.rating_key,
        orderingMode: r.ordering_mode, effectiveFrom: r.effective_from,
        effectiveTo: r.effective_to, adPolicy: r.ad_policy, airdateMode: r.airdate_mode,
        cadenceCompress: r.cadence_compress,
      })),
    })),
    settings: {},
  };
}
