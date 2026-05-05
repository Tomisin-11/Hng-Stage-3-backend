// src/config/database.js
//
// Uses Node 22's built-in `node:sqlite` module — no native compilation needed.
// DatabaseSync is synchronous, just like better-sqlite3, so all the same
// patterns work: .prepare().run(), .prepare().get(), .prepare().all()
//
// NOTE: node:sqlite is experimental in Node 22 but stable enough for this use.
//
// STAGE 4B ADDITIONS:
//   - PRAGMA optimizations for read-heavy workload
//   - Compound + single-column indexes on frequently queried profile columns
//   - Statement cache: compiled SQL is stored and reused across requests

import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'url';
import path from 'path';
import { v7 as uuidv7 } from 'uuid';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.resolve(__dirname, '../../insighta.db');

const db = new DatabaseSync(DB_PATH);

// ---------------------------------------------------------------------------
// PRAGMA OPTIMIZATIONS
//
// journal_mode = WAL
//   Allows concurrent readers during writes — critical for ingestion + queries.
//
// synchronous = NORMAL
//   Safe in WAL mode: syncs at checkpoints, not every write. Faster than FULL.
//
// cache_size = -65536  (64MB page cache)
//   Frequently accessed pages stay in memory. Reduces disk reads significantly
//   for a read-heavy workload on 1M+ rows.
//
// temp_store = MEMORY
//   Sorting and aggregation temp tables live in RAM, not a temp file.
//
// mmap_size = 268435456  (256MB memory-mapped I/O)
//   OS-level caching of the database file pages beyond the cache_size budget.
// ---------------------------------------------------------------------------
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA synchronous = NORMAL');
db.exec('PRAGMA cache_size = -65536');
db.exec('PRAGMA temp_store = MEMORY');
db.exec('PRAGMA mmap_size = 268435456');

// ---------------------------------------------------------------------------
// SCHEMA
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id              TEXT PRIMARY KEY,
    github_id       TEXT UNIQUE NOT NULL,
    username        TEXT NOT NULL,
    email           TEXT,
    avatar_url      TEXT,
    role            TEXT NOT NULL DEFAULT 'analyst' CHECK(role IN ('admin','analyst')),
    is_active       INTEGER NOT NULL DEFAULT 1,
    last_login_at   TEXT,
    created_at      TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS profiles (
    id                   TEXT PRIMARY KEY,
    name                 TEXT NOT NULL,
    gender               TEXT,
    gender_probability   REAL,
    age                  INTEGER,
    age_group            TEXT,
    country_id           TEXT,
    country_name         TEXT,
    country_probability  REAL,
    created_at           TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS refresh_tokens (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT UNIQUE NOT NULL,
    expires_at  TEXT NOT NULL,
    revoked     INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS request_logs (
    id               TEXT PRIMARY KEY,
    user_id          TEXT,
    method           TEXT NOT NULL,
    endpoint         TEXT NOT NULL,
    status_code      INTEGER,
    response_time_ms INTEGER,
    ip               TEXT,
    user_agent       TEXT,
    created_at       TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS oauth_states (
    state         TEXT PRIMARY KEY,
    code_verifier TEXT NOT NULL,
    source        TEXT NOT NULL DEFAULT 'web',
    expires_at    TEXT NOT NULL,
    created_at    TEXT DEFAULT (datetime('now'))
  );
`);

// ---------------------------------------------------------------------------
// INDEXES
//
// Without indexes, filtered queries do full table scans — O(n) at 1M+ rows.
// With indexes, SQLite resolves them in O(log n).
//
// Compound index (country_id, gender, age):
//   Covers the most frequent combined filter. SQLite can use a prefix of a
//   compound index, so country-only and country+gender queries are also covered.
//
// Single-column indexes on gender, age, age_group:
//   Cover queries that don't include country_id.
//
// Expression index on LOWER(name):
//   Enables LIKE queries for text search without a full scan.
//
// We do NOT index every column — indexes slow down writes proportionally to
// count. These five cover the described query patterns without over-indexing.
// ---------------------------------------------------------------------------
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_profiles_country_gender_age
    ON profiles (country_id, gender, age);

  CREATE INDEX IF NOT EXISTS idx_profiles_gender
    ON profiles (gender);

  CREATE INDEX IF NOT EXISTS idx_profiles_age
    ON profiles (age);

  CREATE INDEX IF NOT EXISTS idx_profiles_age_group
    ON profiles (age_group);

  CREATE INDEX IF NOT EXISTS idx_profiles_name_lower
    ON profiles (name COLLATE NOCASE);
`);

// ---------------------------------------------------------------------------
// STATEMENT CACHE
//
// The original shim called db.prepare(sql) on every request — this compiles
// the SQL into bytecode each time. With a hot path like GET /api/profiles
// receiving hundreds of calls per minute, this is significant wasted work.
//
// We cache compiled StatementSync objects in a Map keyed by SQL string.
// First call: compile + store. Subsequent calls: Map lookup (O(1)).
// ---------------------------------------------------------------------------
const stmtCache = new Map();

function prepare(sql) {
  let stmt = stmtCache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    stmtCache.set(sql, stmt);
  }

  return {
    run(...params)  { return stmt.run(...params); },
    get(...params)  { return stmt.get(...params) ?? null; },
    all(...params)  { return stmt.all(...params); },
  };
}

const dbShim = {
  prepare,
  exec: (sql) => db.exec(sql),
};

// ---------------------------------------------------------------------------
// SEED DEMO DATA (first run only)
// ---------------------------------------------------------------------------
const count = dbShim.prepare('SELECT COUNT(*) as c FROM profiles').get();
if (!count || count.c === 0) {
  const insert = dbShim.prepare(`
    INSERT INTO profiles (id, name, gender, gender_probability, age, age_group,
                          country_id, country_name, country_probability)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const seeds = [
    ['Alice Chen',      'female', 0.97, 28, 'adult',       'US', 'United States', 0.89],
    ['Brian Okafor',    'male',   0.95, 34, 'adult',       'NG', 'Nigeria',       0.92],
    ['Carla Mendes',    'female', 0.98, 26, 'adult',       'BR', 'Brazil',        0.91],
    ['David Kim',       'male',   0.93, 31, 'adult',       'KR', 'South Korea',   0.88],
    ['Emma Johnson',    'female', 0.99, 22, 'young-adult', 'GB', 'United Kingdom',0.87],
    ['Fatima Al-Hassan','female', 0.96, 29, 'adult',       'NG', 'Nigeria',       0.94],
    ['George Adeyemi',  'male',   0.91, 45, 'middle-aged', 'NG', 'Nigeria',       0.93],
    ['Hannah Schmidt',  'female', 0.98, 19, 'young-adult', 'DE', 'Germany',       0.90],
    ['Ikenna Eze',      'male',   0.94, 21, 'young-adult', 'NG', 'Nigeria',       0.96],
    ['Julia Weber',     'female', 0.97, 33, 'adult',       'DE', 'Germany',       0.91],
  ];

  for (const s of seeds) {
    insert.run(uuidv7(), ...s);
  }
  console.log('✅ Seeded 10 demo profiles');
}

export { uuidv7 };
export default dbShim;
