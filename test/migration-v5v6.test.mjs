import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, copyFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { freshSoulDir } from './helpers.mjs';

const soulDir = freshSoulDir('migration-v5v6');

const { capture } = await import('../dist/src/kernel/memory.js');
const { computeAssignments, resolveAssignment } = await import('../dist/src/kernel/workbench.js');
const { makePrediction } = await import('../dist/src/kernel/cognition.js');
const { getDb, closeDb, SCHEMA_VERSION } = await import('../dist/src/kernel/db.js');

// NOTE: this is a VERSION-REWIND test, not a pristine-old-DB test: the file is
// created on the current schema, then wound back (decisions table dropped,
// version=5). It proves migration idempotency + WAL-safe backups + restore;
// v7/v8 columns already exist and must be tolerated (addColumnIfMissing).
test('version-rewind v5 state (with live WAL content) migrates forward with a verified, restorable backup', () => {
  // 1. Build real content on the current schema
  const a = capture({ content: 'User prefers sqlite for local persistence', type: 'preference', sourceType: 'agent_inference' });
  const b = capture({ content: 'User prefers postgres for local persistence', type: 'preference', sourceType: 'agent_inference' });
  assert.ok(b.conflicts.length >= 1);
  const assignment = computeAssignments().find((x) => x.kind === 'dispute');
  assert.ok(assignment);
  resolveAssignment(assignment.id, { verdict: 'unclear', reasoning: 'Cannot tell from context which one holds.' });
  makePrediction({ claim: 'The migration test passes', probability: 0.9 });

  const counted = (db) => ({
    memories: db.prepare(`SELECT COUNT(*) c FROM memories`).get().c,
    events: db.prepare(`SELECT COUNT(*) c FROM events`).get().c,
    predictions: db.prepare(`SELECT COUNT(*) c FROM predictions`).get().c,
    assignments: db.prepare(`SELECT COUNT(*) c FROM workbench_assignments`).get().c,
  });
  const before = counted(getDb());
  assert.ok(before.assignments >= 1, 'fixture contains workbench assignments');
  closeDb();

  // 2. Rewind the file to a faithful v5 state: no decisions table, version 5.
  //    A SEPARATE connection stays open across the whole migration so the WAL
  //    sidecar is never checkpointed away — the pre-migration write below
  //    lives only in the WAL when the kernel takes its backup.
  const dbPath = join(soulDir, 'memories.db');
  const holder = new Database(dbPath);
  holder.exec(`DROP TABLE workbench_decisions;`);
  holder.prepare(`UPDATE meta SET value = '5' WHERE key = 'schema_version'`).run();
  holder
    .prepare(
      `INSERT INTO events (event_type, entity_type, entity_id, payload, actor, recorded_at)
       VALUES ('memory.recalled', 'system', NULL, '{"wal":"resident"}', 'test', ?)`
    )
    .run(new Date().toISOString());
  const expected = { ...counted(holder) };

  // 3. Reopen through the kernel -> v5→v6 migration must run (holder still open)
  const db = getDb();
  assert.equal(db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get().value, String(SCHEMA_VERSION));
  assert.ok(
    db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='workbench_decisions'`).get(),
    'workbench_decisions recreated by the migration'
  );
  assert.deepEqual(counted(db), expected, 'all data survived, including the WAL-resident event');

  // 4. The pre-migration backup exists, passes integrity_check, and holds the
  //    exact v5 state — including the event that lived only in the WAL
  const backupDir = join(soulDir, 'backups');
  const backups = readdirSync(backupDir).filter((f) => f.includes('pre-migration-v5-to-v' + SCHEMA_VERSION));
  assert.equal(backups.length, 1, `expected one v5 pre-migration backup, got: ${backups.join(', ')}`);
  const backupPath = join(backupDir, backups[0]);
  const bak = new Database(backupPath, { readonly: true });
  assert.equal(bak.pragma('integrity_check')[0].integrity_check, 'ok');
  assert.deepEqual(counted(bak), expected, 'backup carries the WAL-resident data');
  assert.equal(
    bak.prepare(`SELECT COUNT(*) c FROM events WHERE payload LIKE '%wal%resident%'`).get().c,
    1,
    'the WAL-only event made it into the backup'
  );
  assert.equal(
    bak.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='workbench_decisions'`).get(),
    undefined,
    'the backup is the pre-migration state'
  );
  bak.close();
  holder.close();

  // 5. RESTORE drill: the backup becomes memories.db in a fresh SOUL_DIR and
  //    must migrate to v6 again through the kernel, data intact
  closeDb();
  const restoreDir = mkdtempSync(join(tmpdir(), 'soul-test-restore-'));
  copyFileSync(backupPath, join(restoreDir, 'memories.db'));
  process.env.SOUL_DIR = restoreDir;
  const restored = getDb();
  assert.equal(restored.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get().value, String(SCHEMA_VERSION));
  assert.deepEqual(counted(restored), expected, 'restored database migrates cleanly with all rows');
});

test.after(() => closeDb());
