/**
 * Database lifecycle: open, schema, versioned migrations, backups.
 *
 * Rules enforced here:
 * - Every schema change is a numbered migration; the current schema version
 *   lives in meta.schema_version.
 * - A backup is written automatically before any migration runs.
 * - All migrations run inside a transaction: a failure never leaves a
 *   half-migrated database.
 */

import Database from 'better-sqlite3';
import { join } from 'path';
import { mkdirSync, existsSync, copyFileSync } from 'fs';
import { homedir } from 'os';
import { nowIso, contentHash } from '../util/core.js';

export const SCHEMA_VERSION = 2;

export function getSoulDir(): string {
  const dir = process.env.SOUL_DIR || join(homedir(), '.soul');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function getDbPath(): string {
  return join(getSoulDir(), 'memories.db');
}

export function getBackupDir(): string {
  const dir = join(getSoulDir(), 'backups');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  const dbPath = getDbPath();
  const existedBefore = existsSync(dbPath);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const version = detectSchemaVersion(db);
  if (version < SCHEMA_VERSION) {
    if (existedBefore && version > 0) {
      backupFile(dbPath, `pre-migration-v${version}-to-v${SCHEMA_VERSION}`);
    }
    migrate(db, version);
  }

  _db = db;
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

/** Copy the db file into backups/ with a timestamped name. Returns the backup path. */
export function backupFile(dbPath: string, label: string): string {
  const stamp = nowIso().replace(/[:.]/g, '-');
  const dest = join(getBackupDir(), `memories-${label}-${stamp}.db`);
  copyFileSync(dbPath, dest);
  return dest;
}

/** Live backup of the open database via VACUUM INTO (consistent snapshot). */
export function backupLive(label = 'manual'): string {
  const db = getDb();
  const stamp = nowIso().replace(/[:.]/g, '-');
  const dest = join(getBackupDir(), `memories-${label}-${stamp}.db`);
  db.prepare(`VACUUM INTO ?`).run(dest);
  return dest;
}

/**
 * 0 = empty/new database, 1 = soul-mcp v1 layout, 2 = current.
 */
function detectSchemaVersion(db: Database.Database): number {
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view')`)
    .all() as Array<{ name: string }>;
  const names = new Set(tables.map((t) => t.name));
  if (names.has('meta')) {
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
      | { value: string }
      | undefined;
    if (row) return parseInt(row.value, 10);
  }
  if (names.has('memories')) {
    // v1 had a memories table but no schema_version key
    return 1;
  }
  return 0;
}

function migrate(db: Database.Database, from: number): void {
  const tx = db.transaction(() => {
    if (from === 0) {
      createV2Schema(db);
    } else if (from === 1) {
      migrateV1toV2(db);
    }
    const upsertMeta = db.prepare(
      `INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    );
    upsertMeta.run('schema_version', String(SCHEMA_VERSION), nowIso());
    upsertMeta.run('soul_version', '2.0.0', nowIso());
  });
  tx();
}

function createV2Schema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Append-only event ledger. State is derived; history is truth.
    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      payload TEXT NOT NULL DEFAULT '{}',
      actor TEXT NOT NULL DEFAULT 'system',
      recorded_at TEXT NOT NULL,
      valid_from TEXT,
      valid_until TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_entity ON events(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
    CREATE INDEX IF NOT EXISTS idx_events_recorded ON events(recorded_at);

    -- Materialized current state of memories (fast reads; rebuilt from intent via events)
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'semantic',
      category TEXT NOT NULL DEFAULT 'general',
      tags TEXT NOT NULL DEFAULT '[]',
      importance REAL NOT NULL DEFAULT 0.5,
      confidence REAL NOT NULL DEFAULT 0.5,
      sensitivity TEXT NOT NULL DEFAULT 'personal',
      status TEXT NOT NULL DEFAULT 'active',
      namespace TEXT NOT NULL DEFAULT 'default',
      source_type TEXT NOT NULL DEFAULT 'user_statement',
      source_ref TEXT,
      valid_from TEXT,
      valid_until TEXT,
      supersedes TEXT,
      superseded_by TEXT,
      contradicts TEXT NOT NULL DEFAULT '[]',
      access_count INTEGER NOT NULL DEFAULT 0,
      useful_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_accessed_at TEXT,
      version INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
    CREATE INDEX IF NOT EXISTS idx_memories_ns ON memories(namespace);
    CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
    CREATE INDEX IF NOT EXISTS idx_memories_hash ON memories(content_hash);
    CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content, category, tags,
      content='memories',
      content_rowid='rowid',
      tokenize='porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content, category, tags)
      VALUES (new.rowid, new.content, new.category, new.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, category, tags)
      VALUES ('delete', old.rowid, old.content, old.category, old.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, category, tags)
      VALUES ('delete', old.rowid, old.content, old.category, old.tags);
      INSERT INTO memories_fts(rowid, content, category, tags)
      VALUES (new.rowid, new.content, new.category, new.tags);
    END;

    CREATE TABLE IF NOT EXISTS identity (
      aspect TEXT NOT NULL,
      namespace TEXT NOT NULL DEFAULT 'default',
      value TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.3,
      evidence INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'observed',
      source_type TEXT NOT NULL DEFAULT 'agent_inference',
      first_seen TEXT NOT NULL,
      last_updated TEXT NOT NULL,
      PRIMARY KEY (aspect, namespace)
    );

    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'goal',
      status TEXT NOT NULL DEFAULT 'active',
      priority INTEGER NOT NULL DEFAULT 3,
      progress REAL NOT NULL DEFAULT 0,
      due_at TEXT,
      parent_id TEXT,
      namespace TEXT NOT NULL DEFAULT 'default',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status);
  `);

  const setMeta = db.prepare(
    `INSERT OR IGNORE INTO meta (key, value, updated_at) VALUES (?, ?, ?)`
  );
  setMeta.run('soul_version', '2.0.0', nowIso());
  setMeta.run('created_at', nowIso(), nowIso());
  setMeta.run('total_sessions', '0', nowIso());
}

/**
 * v1 -> v2 in place. The v1 table is renamed (kept as memories_v1_archive),
 * the v2 schema is created, and every v1 row is copied with:
 * - preserved timestamps and access/useful counts,
 * - type mapped from the v1 category,
 * - confidence 0.6 (migrated data is trusted but unconfirmed),
 * - one memory.migrated event per row for provenance.
 */
function migrateV1toV2(db: Database.Database): void {
  db.exec(`
    DROP TRIGGER IF EXISTS memories_ai;
    DROP TRIGGER IF EXISTS memories_ad;
    DROP TRIGGER IF EXISTS memories_au;
    DROP TABLE IF EXISTS memories_fts;
    ALTER TABLE memories RENAME TO memories_v1_archive;
  `);
  const hasIdentity = (db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='identity'`
  ).get() as { name: string } | undefined) !== undefined;
  if (hasIdentity) db.exec(`ALTER TABLE identity RENAME TO identity_v1_archive;`);

  createV2Schema(db);

  const v1rows = db.prepare(`SELECT * FROM memories_v1_archive`).all() as any[];
  const insert = db.prepare(`
    INSERT INTO memories (
      id, content, content_hash, type, category, tags, importance, confidence,
      sensitivity, status, namespace, source_type, source_ref,
      access_count, useful_count, created_at, updated_at, last_accessed_at, version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);
  const insertEvent = db.prepare(`
    INSERT INTO events (event_type, entity_type, entity_id, payload, actor, recorded_at)
    VALUES ('memory.migrated', 'memory', ?, ?, 'system', ?)
  `);

  const categoryToType: Record<string, string> = {
    preference: 'preference',
    decision: 'episodic',
    learning: 'semantic',
    problem: 'episodic',
    solution: 'procedural',
    project: 'semantic',
    personal: 'identity',
    technical: 'semantic',
    plan: 'goal',
    general: 'semantic',
  };

  for (const row of v1rows) {
    const id = `mem_v1_${row.id}`;
    const now = nowIso();
    insert.run(
      id,
      row.content,
      contentHash(row.content),
      categoryToType[row.category] || 'semantic',
      row.category,
      row.tags || '[]',
      row.importance ?? 0.5,
      0.6,
      'personal',
      'active',
      'default',
      row.source === 'reflection' ? 'agent_inference' : 'user_statement',
      `v1:${row.source || 'manual'}`,
      row.access_count ?? 0,
      row.useful_count ?? 0,
      row.created_at || now,
      row.updated_at || now,
      row.last_accessed_at || null
    );
    insertEvent.run(id, JSON.stringify({ from: 'v1', v1_id: row.id }), nowIso());
  }

  if (hasIdentity) {
    const v1identity = db.prepare(`SELECT * FROM identity_v1_archive`).all() as any[];
    const insertIdentity = db.prepare(`
      INSERT OR REPLACE INTO identity
        (aspect, namespace, value, confidence, evidence, status, source_type, first_seen, last_updated)
      VALUES (?, 'default', ?, ?, ?, 'observed', 'agent_inference', ?, ?)
    `);
    for (const f of v1identity) {
      insertIdentity.run(
        f.aspect, f.value, f.confidence ?? 0.3, f.evidence ?? 1,
        f.first_seen || nowIso(), f.last_updated || nowIso()
      );
    }
  }

  // carry over session counter if present
  const v1meta = db.prepare(`SELECT value FROM meta WHERE key = 'total_sessions'`).get() as
    | { value: string }
    | undefined;
  if (!v1meta) {
    db.prepare(
      `INSERT OR IGNORE INTO meta (key, value, updated_at) VALUES ('total_sessions', '0', ?)`
    ).run(nowIso());
  }
}
