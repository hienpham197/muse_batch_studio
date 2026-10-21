import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

export type Db = DatabaseSync;
export type Row = Record<string, unknown>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  masked_id TEXT NOT NULL,
  identifier_hash TEXT NOT NULL UNIQUE,
  credentials_enc TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  slots INTEGER NOT NULL DEFAULT 1,
  auth_kind TEXT NOT NULL DEFAULT 'password',
  session_status TEXT NOT NULL DEFAULT 'unknown',
  session_reason TEXT,
  last_health_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS images (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('staged', 'ref', 'studio')),
  tag TEXT,
  original_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  ext TEXT NOT NULL,
  size INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS images_tag_unique ON images(tag) WHERE kind = 'ref';

CREATE TABLE IF NOT EXISTS jobs (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL DEFAULT 'batch',
  studio_card_id TEXT,
  prompt TEXT NOT NULL,
  search_text TEXT NOT NULL,
  ref_tags TEXT NOT NULL DEFAULT '[]',
  refs TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  duration INTEGER NOT NULL,
  ratio TEXT NOT NULL,
  account_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  timed_out INTEGER NOT NULL DEFAULT 0,
  run_id TEXT,
  order_key INTEGER NOT NULL,
  not_before INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  last_progress_at INTEGER,
  video_file TEXT,
  thumb_file TEXT,
  quality TEXT,
  error TEXT,
  regen_of TEXT
);
CREATE INDEX IF NOT EXISTS jobs_status_order ON jobs(status, order_key);
CREATE INDEX IF NOT EXISTS jobs_source ON jobs(source, hidden);

CREATE TABLE IF NOT EXISTS studio_cards (
  id TEXT PRIMARY KEY,
  x REAL NOT NULL,
  y REAL NOT NULL,
  prompt TEXT NOT NULL DEFAULT '',
  input_image_id TEXT NOT NULL,
  input_tag TEXT,
  job_id TEXT,
  created_at INTEGER NOT NULL
);
`;

/** Nâng cấp DB tạo từ phiên bản cũ. */
function migrate(db: Db): void {
  const cols = (db.prepare('PRAGMA table_info(accounts)').all() as Row[]).map((r) => r.name);
  if (!cols.includes('auth_kind')) db.exec("ALTER TABLE accounts ADD COLUMN auth_kind TEXT NOT NULL DEFAULT 'password'");
  const jobCols = (db.prepare('PRAGMA table_info(jobs)').all() as Row[]).map((r) => r.name);
  if (!jobCols.includes('regen_of')) db.exec('ALTER TABLE jobs ADD COLUMN regen_of TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS jobs_regen ON jobs(regen_of)');
}

export function openDb(dataDir: string): Db {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'muse.sqlite'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

export function openMemoryDb(): Db {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

export function all(db: Db, sql: string, ...params: SQLInputValue[]): Row[] {
  return db.prepare(sql).all(...params) as Row[];
}

export function get(db: Db, sql: string, ...params: SQLInputValue[]): Row | undefined {
  return db.prepare(sql).get(...params) as Row | undefined;
}

export function run(db: Db, sql: string, ...params: SQLInputValue[]): void {
  db.prepare(sql).run(...params);
}

export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** Build `UPDATE ... SET a = ?, b = ?` từ khóa do code (không phải input người dùng) quyết định. */
export function update(db: Db, table: string, id: string, idColumn: string, patch: Record<string, SQLInputValue>): void {
  const keys = Object.keys(patch);
  if (keys.length === 0) return;
  const set = keys.map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE ${table} SET ${set} WHERE ${idColumn} = ?`).run(...keys.map((k) => patch[k]!), id);
}
