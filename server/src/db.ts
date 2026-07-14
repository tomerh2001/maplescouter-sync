import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS presets (
  id TEXT PRIMARY KEY,
  user TEXT NOT NULL,
  label TEXT NOT NULL,
  envelope_version INTEGER,
  entry TEXT NOT NULL,
  game_meta TEXT,
  device TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_presets_user ON presets(user, updated_at);

CREATE TABLE IF NOT EXISTS preset_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  preset_id TEXT NOT NULL,
  user TEXT NOT NULL,
  label TEXT NOT NULL,
  envelope_version INTEGER,
  entry TEXT NOT NULL,
  saved_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_preset_versions_preset ON preset_versions(preset_id, id);

CREATE TABLE IF NOT EXISTS backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user TEXT NOT NULL,
  payload TEXT NOT NULL,
  device TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_backups_user ON backups(user, id);
`;

export function openDb(path: string): Database.Database {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  return db;
}
