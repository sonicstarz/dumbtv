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
