import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';

// Build a realistic v1 database BEFORE loading the v2 kernel
const dir = mkdtempSync(join(tmpdir(), 'soul-test-migration-'));
process.env.SOUL_DIR = dir;
const dbPath = join(dir, 'memories.db');

{
  const v1 = new Database(dbPath);
  v1.exec(`
    CREATE TABLE memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      tags TEXT NOT NULL DEFAULT '[]',
      importance REAL NOT NULL DEFAULT 0.5,
      access_count INTEGER NOT NULL DEFAULT 0,
      useful_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_accessed_at TEXT,
      source TEXT NOT NULL DEFAULT 'manual'
    );
    CREATE VIRTUAL TABLE memories_fts USING fts5(
      content, category, tags, content='memories', content_rowid='id', tokenize='porter unicode61'
    );
    CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content, category, tags) VALUES (new.id, new.content, new.category, new.tags);
    END;
    CREATE TABLE identity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      aspect TEXT NOT NULL UNIQUE,
      value TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.3,
      evidence INTEGER NOT NULL DEFAULT 1,
      first_seen TEXT NOT NULL DEFAULT (datetime('now')),
      last_updated TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const ins = v1.prepare(`INSERT INTO memories (content, category, tags, importance, access_count, useful_count, created_at, updated_at, source) VALUES (?,?,?,?,?,?,?,?,?)`);
  ins.run('User prefers TypeScript over JavaScript', 'preference', '["typescript"]', 0.8, 5, 2, '2026-02-10T10:00:00.000Z', '2026-02-10T10:00:00.000Z', 'manual');
  ins.run('Working on the nextool website project', 'project', '["nextool"]', 0.7, 3, 1, '2026-03-01T09:00:00.000Z', '2026-03-01T09:00:00.000Z', 'manual');
  ins.run('Session 5 reflection: learned about FTS5 ranking', 'learning', '["sqlite"]', 0.6, 0, 0, '2026-03-05T20:00:00.000Z', '2026-03-05T20:00:00.000Z', 'reflection');
  v1.prepare(`INSERT INTO identity (aspect, value, confidence, evidence) VALUES (?,?,?,?)`).run('name', 'Christian', 0.9, 12);
  v1.prepare(`INSERT INTO meta (key, value) VALUES ('soul_version', '1.0.0'), ('total_sessions', '42')`).run();
  v1.close();
}

const { getDb, closeDb } = await import('../dist/src/kernel/db.js');
const { getMemoryById, listMemories } = await import('../dist/src/kernel/memory.js');
const { getAllIdentity } = await import('../dist/src/kernel/identity.js');
const { getSessionCount } = await import('../dist/src/kernel/stats.js');
const { recall } = await import('../dist/src/kernel/retrieval.js');
const { queryEvents } = await import('../dist/src/kernel/ledger.js');

test('opening a v1 database migrates it to the current schema with a backup', () => {
  getDb(); // triggers migration
  const backups = readdirSync(join(dir, 'backups'));
  assert.ok(backups.some((b) => b.includes('pre-migration-v1-to-v')), `backup exists: ${backups}`);
});

test('v1 data survives: content, timestamps, counters, identity, session count', () => {
  const m = getMemoryById('mem_v1_1');
  assert.equal(m.content, 'User prefers TypeScript over JavaScript');
  assert.equal(m.createdAt, '2026-02-10T10:00:00.000Z');
  assert.equal(m.accessCount, 5);
  assert.equal(m.usefulCount, 2);
  assert.equal(m.type, 'preference');
  assert.equal(m.status, 'active');
  assert.equal(m.sourceType, 'user_statement');

  const reflection = getMemoryById('mem_v1_3');
  assert.equal(reflection.sourceType, 'agent_inference');

  const identity = getAllIdentity();
  assert.equal(identity.length, 1);
  assert.equal(identity[0].value, 'Christian');
  assert.equal(identity[0].evidence, 12);

  assert.equal(getSessionCount(), 42);
});

test('migrated memories are searchable through recall', async () => {
  const results = await recall('typescript preference', { silent: true });
  assert.ok(results.some((r) => r.id === 'mem_v1_1'));
});

test('migration events exist for provenance', () => {
  const events = queryEvents({ eventType: 'memory.migrated' });
  assert.equal(events.length, 3);
});

test('v1 archive table remains for safety', () => {
  const row = getDb().prepare(`SELECT COUNT(*) c FROM memories_v1_archive`).get();
  assert.equal(row.c, 3);
});

test('all migrated memories are listable', () => {
  const all = listMemories({ limit: 100 });
  assert.ok(all.length >= 3);
});

test.after(() => closeDb());
