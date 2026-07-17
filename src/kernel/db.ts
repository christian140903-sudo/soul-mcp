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

export const SCHEMA_VERSION = 12;
export const SOUL_VERSION = '4.0.0';

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
  // Multiple MCP processes (Claude + Codex + starter pulse) share this file:
  // wait for locks instead of failing fast.
  db.pragma('busy_timeout = 5000');

  const version = detectSchemaVersion(db);
  if (version < SCHEMA_VERSION) {
    if (existedBefore && version > 0) {
      // VACUUM INTO instead of a file copy: a plain copy of memories.db would
      // miss committed data still sitting in the WAL sidecar. This snapshot
      // is consistent by construction, and verified before we migrate.
      backupVacuum(db, `pre-migration-v${version}-to-v${SCHEMA_VERSION}`);
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

/**
 * WAL-safe snapshot of an open database handle via VACUUM INTO, verified
 * with integrity_check before it counts as a backup. Takes the handle
 * explicitly so it is usable during getDb() itself (pre-migration).
 */
export function backupVacuum(db: Database.Database, label: string): string {
  const stamp = nowIso().replace(/[:.]/g, '-');
  const dest = join(getBackupDir(), `memories-${label}-${stamp}.db`);
  db.prepare(`VACUUM INTO ?`).run(dest);
  const check = new Database(dest, { readonly: true });
  try {
    const result = check.pragma('integrity_check') as Array<{ integrity_check: string }>;
    if (result[0]?.integrity_check !== 'ok') {
      throw new Error(`Backup failed integrity_check: ${JSON.stringify(result)}`);
    }
  } finally {
    check.close();
  }
  return dest;
}

/** Live backup of the open database via VACUUM INTO (consistent snapshot). */
export function backupLive(label = 'manual'): string {
  return backupVacuum(getDb(), label);
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
    if (from < 3) {
      createV3Additions(db);
    }
    if (from < 4) {
      createV4Additions(db);
    }
    if (from < 5) {
      createV5Additions(db);
    }
    if (from < 6) {
      createV6Additions(db);
    }
    if (from < 7) {
      createV7Additions(db);
    }
    if (from < 8) {
      createV8Additions(db);
    }
    if (from < 9) {
      createV9Additions(db);
    }
    if (from < 10) {
      createV10Additions(db);
    }
    if (from < 11) {
      createV11Additions(db);
    }
    if (from < 12) {
      createV12Additions(db);
    }
    const upsertMeta = db.prepare(
      `INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    );
    upsertMeta.run('schema_version', String(SCHEMA_VERSION), nowIso());
    upsertMeta.run('soul_version', SOUL_VERSION, nowIso());
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
  setMeta.run('soul_version', SOUL_VERSION, nowIso());
  setMeta.run('created_at', nowIso(), nowIso());
  setMeta.run('total_sessions', '0', nowIso());
}

/**
 * v3: optional semantic layer. Vectors live in their own table so the
 * memories table (and every v2 code path) is untouched; ON DELETE CASCADE
 * keeps vectors from outliving a hard-deleted memory.
 */
function createV3Additions(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_vectors (
      id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      dim INTEGER NOT NULL,
      vector BLOB NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_vectors_model ON memory_vectors(model);
  `);
}

/**
 * v4: the workbench — think-assignments Soul issues to the model in front
 * of it (Denkpartner protocol). Assignments are persisted so a resolution
 * can be validated against exactly what was asked.
 */
function createV4Additions(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workbench_assignments (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      memory_ids TEXT NOT NULL DEFAULT '[]',
      instruction TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      issued_at TEXT NOT NULL,
      resolved_at TEXT,
      resolution TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_workbench_status ON workbench_assignments(status);
  `);
}

/**
 * v5: the prediction ledger — testable claims with probabilities, resolved
 * over time. From this Soul computes the model's real calibration (hit rate
 * per confidence bucket, Brier score) and feeds it back: self-knowledge no
 * base model has about itself.
 */
function createV5Additions(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS predictions (
      id TEXT PRIMARY KEY,
      claim TEXT NOT NULL,
      probability REAL NOT NULL,
      due_at TEXT,
      namespace TEXT NOT NULL DEFAULT 'default',
      model_hint TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      outcome TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_predictions_open ON predictions(resolved_at) WHERE resolved_at IS NULL;
  `);
}

/**
 * v6: workbench decisions — the detectors' long-term memory of past verdicts.
 * Without it, a resolved assignment (keep_separate, unclear, doubt, …) is
 * re-issued on the next detector run because only the assignment closes, not
 * the judgment. Terminal decisions block re-issue forever; non-terminal ones
 * carry a next_review_at cooldown. subject_key is the sorted memory-id pair
 * (or the single memory-/prediction-id); subject_revision records what the
 * subject looked like when judged (content hashes), for later invalidation.
 */
function createV6Additions(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workbench_decisions (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      subject_key TEXT NOT NULL,
      subject_revision TEXT,
      outcome TEXT NOT NULL,
      terminal INTEGER NOT NULL DEFAULT 0,
      next_review_at TEXT,
      assignment_id TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT 'agent',
      reasoning TEXT,
      created_at TEXT NOT NULL,
      invalidated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_wb_decisions_subject ON workbench_decisions(kind, subject_key);
  `);
}

/**
 * v7 (3.1.0), all additive:
 * - fact freshness: volatility + verification fields on memories, so
 *   "confirmed" stops meaning "confirmed forever" (stale_fact workbench type)
 * - retrieval_impressions: which memories which capsule delivered, at what
 *   rank, and what feedback came back — the measurement base for retrieval
 *   work (measure BEFORE swapping models/rankers)
 * - client_sessions: which client/model wrote what; runtime model names
 *   belong here, never inside durable memories
 * - prediction context fields: decision linkage, domain, session, resolution
 *   provenance — calibration per model family × domain becomes computable
 * - session_reflections: session summaries leave the memories table so they
 *   stop flooding integrity metrics
 */
function addColumnIfMissing(db: Database.Database, table: string, column: string, ddl: string): void {
  const cols = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

function createV7Additions(db: Database.Database): void {
  addColumnIfMissing(db, 'memories', 'volatility', `volatility TEXT NOT NULL DEFAULT 'stable'`);
  addColumnIfMissing(db, 'memories', 'last_verified_at', 'last_verified_at TEXT');
  addColumnIfMissing(db, 'memories', 'review_due_at', 'review_due_at TEXT');
  addColumnIfMissing(db, 'memories', 'verification_ref', 'verification_ref TEXT');
  addColumnIfMissing(db, 'predictions', 'decision_id', 'decision_id TEXT');
  addColumnIfMissing(db, 'predictions', 'domain', 'domain TEXT');
  addColumnIfMissing(db, 'predictions', 'client_session_id', 'client_session_id TEXT');
  addColumnIfMissing(db, 'predictions', 'resolution_actor', 'resolution_actor TEXT');
  addColumnIfMissing(db, 'predictions', 'evidence_ref', 'evidence_ref TEXT');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memories_review_due ON memories(review_due_at) WHERE review_due_at IS NOT NULL;

    CREATE TABLE IF NOT EXISTS retrieval_impressions (
      id TEXT PRIMARY KEY,
      context_id TEXT NOT NULL,
      query_hash TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      rank INTEGER NOT NULL,
      signal TEXT NOT NULL DEFAULT 'included',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_impressions_context ON retrieval_impressions(context_id);
    CREATE INDEX IF NOT EXISTS idx_impressions_memory ON retrieval_impressions(memory_id);

    CREATE TABLE IF NOT EXISTS client_sessions (
      id TEXT PRIMARY KEY,
      client_name TEXT,
      provider TEXT,
      model_id TEXT,
      model_profile TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT
    );

    CREATE TABLE IF NOT EXISTS session_reflections (
      id TEXT PRIMARY KEY,
      session_number INTEGER NOT NULL,
      summary TEXT NOT NULL,
      learnings_count INTEGER NOT NULL DEFAULT 0,
      client_session_id TEXT,
      created_at TEXT NOT NULL
    );
  `);
}

/** v8: created_at index for the impressions retention sweep (90-day window). */
function createV8Additions(db: Database.Database): void {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_impressions_created ON retrieval_impressions(created_at);`);
}

/**
 * v9 (3.1.1): a soft delete must keep content out of the FTS index, not just
 * out of the status-filtered recall projection. Before v9 the memories_au
 * trigger re-indexed the row on EVERY update, so a soft-deleted memory stayed
 * fully searchable in memories_fts and any later UPDATE re-inserted it. The
 * trigger is redefined to only (re)index rows whose new status is not
 * 'deleted'; a status->'deleted' transition removes the FTS row. Existing
 * soft-deleted rows are purged from the index once here.
 */
function createV9Additions(db: Database.Database): void {
  db.exec(`
    DROP TRIGGER IF EXISTS memories_au;
    CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
      -- Only remove the OLD row from the index if it was actually indexed
      -- (status != 'deleted'). A double 'delete' against an external-content
      -- fts5 index corrupts it, so an UPDATE on an already-deleted row must be
      -- a no-op for FTS.
      INSERT INTO memories_fts(memories_fts, rowid, content, category, tags)
      SELECT 'delete', old.rowid, old.content, old.category, old.tags
      WHERE old.status != 'deleted';
      -- (Re)index the NEW row only while it is live.
      INSERT INTO memories_fts(rowid, content, category, tags)
      SELECT new.rowid, new.content, new.category, new.tags
      WHERE new.status != 'deleted';
    END;

    -- Purge content of already soft-deleted rows from the index (one-time backfill).
    INSERT INTO memories_fts(memories_fts, rowid, content, category, tags)
    SELECT 'delete', rowid, content, category, tags FROM memories WHERE status = 'deleted';
  `);
}

/**
 * v10 (Soul 4.0 Phase 2 Welle A), all additive: the Durable Run State
 * Machine's storage — runs, receipts, episodes (DECISIONS F09/F09r2,
 * SOUL4-PLAN Phase 2, Episode@1 C0a→C0b).
 *
 * - runs: one row per soul_run; idempotency_key UNIQUE makes double-submit
 *   return the same run; fencing_token + lease_until + attempt_count carry
 *   the at-least-once/fencing semantics (worker mode arrives later, the
 *   columns are the same contract).
 * - receipts: narrow queryable columns (status pending|closed); the
 *   contract-level ReceiptV1 fields (attempt, fencing_token, mode, actor,
 *   tainted, contract status, evidence) live in the outcome JSON column and
 *   are reassembled by kernel/runs.getReceiptView.
 * - episodes: full Episode@1 causal-chain fields, outcome defaults PENDING,
 *   bitemporal (occurred_at/recorded_at + outcome_observed_at back-fill).
 */
function createV10Additions(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'queued',
      task_contract TEXT NOT NULL,
      budget TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      fencing_token TEXT NOT NULL,
      lease_until TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);

    CREATE TABLE IF NOT EXISTS receipts (
      receipt_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(run_id),
      status TEXT NOT NULL DEFAULT 'pending',
      honesty_class TEXT NOT NULL DEFAULT 'self_attested',
      issued_by TEXT NOT NULL DEFAULT 'coordinator',
      created_at TEXT NOT NULL,
      closed_at TEXT,
      outcome TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_receipts_run ON receipts(run_id);
    CREATE INDEX IF NOT EXISTS idx_receipts_pending ON receipts(status, created_at);

    CREATE TABLE IF NOT EXISTS episodes (
      episode_id TEXT PRIMARY KEY,
      occurred_at TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      task_slice TEXT NOT NULL,
      domain_raw TEXT,
      recommendation_id TEXT,
      policy_version TEXT,
      offered TEXT,
      acceptance TEXT NOT NULL DEFAULT 'unknown',
      executed TEXT NOT NULL,
      run_id TEXT,
      attempt_id TEXT,
      receipt_id TEXT,
      verifier_result_id TEXT,
      prediction TEXT,
      cost TEXT NOT NULL,
      outcome TEXT NOT NULL DEFAULT 'PENDING',
      outcome_source TEXT,
      outcome_observed_at TEXT,
      eligibility INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_episodes_run ON episodes(run_id);
    CREATE INDEX IF NOT EXISTS idx_episodes_receipt ON episodes(receipt_id);
    CREATE INDEX IF NOT EXISTS idx_episodes_pending ON episodes(outcome) WHERE outcome = 'PENDING';
  `);
}

/**
 * v11 (Soul 4.0 Phase 3), all additive, under the same backup contract as
 * every migration (VACUUM INTO snapshot before migrate): the declarative
 * Skill-Registry (SOUL4-PLAN Phase 3, THREAT-MODEL TB5, DECISIONS F04/F07/F10).
 *
 * - skills: one row per (name, version); the full SkillManifest@1 JSON lives
 *   in `manifest`, the narrow columns exist for deterministic selection
 *   (lifecycle gate, compatibility match) without parsing every manifest.
 *   Skill events go through the EXISTING ledger (skill.registered,
 *   skill.lifecycle_changed, skill.revoked, pack.imported, pack.refused) —
 *   no separate skill_events table, the ledger is the audit trail.
 * - trusted_keys: TOFU key-pinning per SIGNED-PACK-TRUST §1/§5. Pinning is a
 *   separate explicit user action (CLI), never implicit on import.
 * - pack_versions: downgrade protection per SIGNED-PACK-TRUST §3 — the
 *   highest imported pack_version per (publisher key_id, pack_name); equal or
 *   lower incoming versions are refused fail-closed.
 */
function createV11Additions(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS skills (
      skill_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      manifest TEXT NOT NULL,
      lifecycle_state TEXT NOT NULL DEFAULT 'shadow',
      compatibility TEXT NOT NULL DEFAULT '{}',
      source TEXT NOT NULL DEFAULT 'local',
      publisher_key_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(name, version)
    );
    CREATE INDEX IF NOT EXISTS idx_skills_lifecycle ON skills(lifecycle_state);
    CREATE INDEX IF NOT EXISTS idx_skills_name ON skills(name);

    CREATE TABLE IF NOT EXISTS trusted_keys (
      key_id TEXT PRIMARY KEY,
      pubkey TEXT NOT NULL,
      pinned_at TEXT NOT NULL,
      label TEXT
    );

    CREATE TABLE IF NOT EXISTS pack_versions (
      key_id TEXT NOT NULL,
      pack_name TEXT NOT NULL,
      highest_version TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (key_id, pack_name)
    );
  `);
}

/**
 * v12 (Soul 4.0, Sol-Gate Nacharbeit), all additive, under the same backup
 * contract as every migration (VACUUM INTO snapshot before migrate): the
 * defense-in-depth uniqueness indexes documented in the retryRun CAS comment
 * (kernel/runs.ts, F03 Retry-Race). The CAS transaction already prevents two
 * attempts with the same number; these indexes make the invariant hold at
 * the storage layer even against a buggy future writer or a second process.
 *
 * - episodes(run_id, attempt_id): one episode per attempt. Both columns are
 *   nullable in the v10 DDL (episodes can exist without a run), so the index
 *   is partial — NULLs stay unconstrained.
 * - receipts: the attempt number lives ONLY inside the outcome JSON
 *   (v10 design: narrow columns + contract fields in outcome), so this is a
 *   UNIQUE expression index on json_extract(outcome, '$.attempt'). No new
 *   column, no data migration — closeRunWithFeedback spreads the old detail
 *   into the closed outcome, so the attempt field survives closing. Partial:
 *   receipts whose outcome carries no attempt (or is NULL) stay
 *   unconstrained.
 */
function createV12Additions(db: Database.Database): void {
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_episodes_run_attempt
      ON episodes(run_id, attempt_id)
      WHERE run_id IS NOT NULL AND attempt_id IS NOT NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_receipts_run_attempt
      ON receipts(run_id, json_extract(outcome, '$.attempt'))
      WHERE json_extract(outcome, '$.attempt') IS NOT NULL;
  `);
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
