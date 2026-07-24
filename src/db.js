import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS channels (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  number            INTEGER UNIQUE NOT NULL,
  name              TEXT NOT NULL,
  slot_minutes      INTEGER NOT NULL DEFAULT 30,
  ordering_mode     TEXT NOT NULL DEFAULT 'sequential',
  marathon_size     INTEGER NOT NULL DEFAULT 3,
  cursor            INTEGER NOT NULL DEFAULT 0,
  shuffle_seed      INTEGER NOT NULL DEFAULT 1,
  dark_start        TEXT,
  dark_end          TEXT,
  ads_enabled       INTEGER NOT NULL DEFAULT 1,
  max_ads_per_break INTEGER NOT NULL DEFAULT 10,
  ad_tags           TEXT NOT NULL DEFAULT '',
  enabled           INTEGER NOT NULL DEFAULT 1,
  generated_thru    INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_sources (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  rating_key  TEXT NOT NULL,
  source_type TEXT NOT NULL,
  title       TEXT,
  weight      INTEGER NOT NULL DEFAULT 1,
  UNIQUE(channel_id, rating_key)
);

CREATE TABLE IF NOT EXISTS media (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  rating_key    TEXT UNIQUE NOT NULL,
  parent_key    TEXT,
  kind          TEXT NOT NULL,
  title         TEXT NOT NULL,
  show_title    TEXT,
  season_no     INTEGER,
  episode_no    INTEGER,
  aired         TEXT,
  duration_ms   INTEGER NOT NULL,
  part_key      TEXT,
  thumb         TEXT,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_parent ON media(parent_key);

CREATE TABLE IF NOT EXISTS assets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  path        TEXT UNIQUE NOT NULL,
  title       TEXT NOT NULL,
  kind        TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  tags        TEXT NOT NULL DEFAULT '',
  rating_key  TEXT,
  part_key    TEXT
);

CREATE TABLE IF NOT EXISTS programs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  start_utc   INTEGER NOT NULL,
  end_utc     INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  rating_key  TEXT,
  asset_id    INTEGER,
  title       TEXT NOT NULL,
  subtitle    TEXT,
  season_no   INTEGER,
  episode_no  INTEGER,
  slot_start  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_programs_lookup
  ON programs(channel_id, start_utc, end_utc);
CREATE INDEX IF NOT EXISTS idx_programs_slot
  ON programs(channel_id, slot_start);

CREATE TABLE IF NOT EXISTS dvr (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  rating_key  TEXT NOT NULL,
  title       TEXT NOT NULL,
  subtitle    TEXT,
  duration_ms INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL
);

-- Backend v2: content claims time via rules with a priority. Generation resolves
-- them highest-priority-first (reservations), then fills the gaps with rotation.
CREATE TABLE IF NOT EXISTS schedule_rules (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id     INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  name           TEXT,
  kind           TEXT NOT NULL,          -- blackout|pinned|recurring|airdate|rotation
  priority       INTEGER NOT NULL,
  enabled        INTEGER NOT NULL DEFAULT 1,
  -- recurring / blackout
  days_of_week   TEXT,                   -- CSV, 0=Sun .. 6=Sat
  start_time     TEXT,                   -- 'HH:MM' local
  duration_min   INTEGER,
  -- pinned
  starts_at_utc  INTEGER,
  -- content
  source_type    TEXT,                   -- show|movie|season|episode|collection|channel
  rating_key     TEXT,
  ordering_mode  TEXT,
  cursor         INTEGER NOT NULL DEFAULT 0,
  -- windowing
  effective_from TEXT,                   -- 'YYYY-MM-DD', nullable
  effective_to   TEXT,
  -- ads
  ad_policy      TEXT                    -- JSON override, nullable
);
CREATE INDEX IF NOT EXISTS idx_rules_channel ON schedule_rules(channel_id, priority DESC);

-- Premiere vs rerun, and repeat cooldown, per (channel, item).
CREATE TABLE IF NOT EXISTS airings (
  channel_id  INTEGER NOT NULL,
  rating_key  TEXT NOT NULL,
  count       INTEGER NOT NULL DEFAULT 0,
  last_aired  INTEGER,
  PRIMARY KEY (channel_id, rating_key)
);
`);

// Add columns to tables that predate them. SQLite has no ADD COLUMN IF NOT
// EXISTS, so check the table shape first. Idempotent — safe on every boot.
function addColumnIfMissing(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
addColumnIfMissing('assets', 'rating_key', 'TEXT');
addColumnIfMissing('assets', 'part_key', 'TEXT');
// Backend v2: which rule placed a program, and whether it's a premiere (1) or repeat.
addColumnIfMissing('programs', 'rule_id', 'INTEGER');
addColumnIfMissing('programs', 'airing_no', 'INTEGER DEFAULT 1');
// Repeat cooldown: don't re-air an item within this many days of its last airing.
addColumnIfMissing('channels', 'cooldown_days', 'INTEGER NOT NULL DEFAULT 0');

// One-time data migration into the rule model, so an existing install keeps its
// lineup. Each channel's sources become a rotation rule; dark hours become a
// blackout rule. Runs once per channel (guarded by "does a rotation rule exist").
function migrateChannelsToRules() {
  const channels = db.prepare('SELECT * FROM channels').all();
  const hasRotation = db.prepare(
    "SELECT 1 FROM schedule_rules WHERE channel_id = ? AND kind = 'rotation' LIMIT 1"
  );
  const insertRule = db.prepare(`
    INSERT INTO schedule_rules
      (channel_id, name, kind, priority, enabled, days_of_week, start_time,
       duration_min, ordering_mode, cursor)
    VALUES (@channelId, @name, @kind, @priority, 1, @daysOfWeek, @startTime,
            @durationMin, @orderingMode, @cursor)
  `);
  const migrate = db.transaction(() => {
    for (const c of channels) {
      if (hasRotation.get(c.id)) continue; // already migrated
      // Rotation rule (priority 0) carries the channel's default ordering + cursor.
      insertRule.run({
        channelId: c.id, name: 'Everything else', kind: 'rotation', priority: 0,
        daysOfWeek: null, startTime: null, durationMin: null,
        orderingMode: c.ordering_mode, cursor: c.cursor || 0,
      });
      // Dark hours become a daily blackout (priority 1000).
      if (c.dark_start && c.dark_end) {
        insertRule.run({
          channelId: c.id, name: 'Off air', kind: 'blackout', priority: 1000,
          daysOfWeek: '0,1,2,3,4,5,6', startTime: c.dark_start,
          durationMin: minutesBetween(c.dark_start, c.dark_end),
          orderingMode: null, cursor: 0,
        });
      }
    }
  });
  migrate();
}

function minutesBetween(start, end) {
  const [sh, sm] = String(start).split(':').map(Number);
  const [eh, em] = String(end).split(':').map(Number);
  let mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins <= 0) mins += 24 * 60; // wraps past midnight
  return mins;
}

migrateChannelsToRules();

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

export function setSetting(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, JSON.stringify(value));
}

export function deleteSetting(key) {
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}
