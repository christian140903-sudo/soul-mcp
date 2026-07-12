import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { freshSoulDir } from './helpers.mjs';

freshSoulDir('transfer-source');

const { capture } = await import('../dist/src/kernel/memory.js');
const { setIdentityFacet } = await import('../dist/src/kernel/identity.js');
const { createGoal } = await import('../dist/src/kernel/goals.js');
const { exportAll, importAll, importV1Export } = await import('../dist/src/kernel/transfer.js');
const { closeDb, getDb } = await import('../dist/src/kernel/db.js');

test('export -> import into empty soul is a faithful round-trip, and re-import is idempotent', () => {
  // populate source
  const m1 = capture({ content: 'Round trip memory one about sqlite fidelity' });
  capture({ content: 'Round trip memory two about npm publishing' });
  setIdentityFacet('preferred_language', 'TypeScript', { confidence: 0.8 });
  createGoal({ title: 'Ship the passport format', kind: 'commitment', dueAt: '2031-05-05' });
  const data = exportAll();
  assert.ok(data.checksum);
  assert.ok(data.memories.length >= 2);
  assert.ok(data.events.length >= 2);

  // switch to a brand-new soul dir
  closeDb();
  process.env.SOUL_DIR = mkdtempSync(join(tmpdir(), 'soul-test-transfer-dest-'));

  const result = importAll(data);
  assert.equal(result.checksumValid, true);
  assert.equal(result.memories.imported, data.memories.length);
  assert.equal(result.identity.imported, data.identity.length);
  assert.equal(result.goals.imported, data.goals.length);
  assert.equal(result.events.imported, data.events.length);

  // fidelity: timestamps, counters, ids survive
  const row = getDb().prepare(`SELECT * FROM memories WHERE id = ?`).get(m1.memory.id);
  assert.ok(row, 'memory id preserved');
  assert.equal(row.created_at, m1.memory.createdAt);
  assert.equal(row.access_count, m1.memory.accessCount);

  // idempotency: importing again changes nothing
  const again = importAll(data);
  assert.equal(again.memories.imported, 0);
  assert.equal(again.identity.imported, 0);
  assert.equal(again.goals.imported, 0);
  assert.equal(again.events.imported, 0);
});

test('tampered export fails the checksum but still imports with a warning flag', () => {
  closeDb();
  process.env.SOUL_DIR = mkdtempSync(join(tmpdir(), 'soul-test-transfer-tamper-'));
  capture({ content: 'memory in the tamper test soul' });
  const data = exportAll();
  data.memories[0].content = 'silently edited content';
  closeDb();
  process.env.SOUL_DIR = mkdtempSync(join(tmpdir(), 'soul-test-transfer-tamper-dest-'));
  const result = importAll(data);
  assert.equal(result.checksumValid, false);
});

test('legacy v1 exports import through the capture pipeline', () => {
  closeDb();
  process.env.SOUL_DIR = mkdtempSync(join(tmpdir(), 'soul-test-transfer-v1-'));
  const v1data = {
    version: '1.0.0',
    memories: [
      { content: 'v1 legacy memory about docker deployments', category: 'technical', tags: ['docker'], importance: 0.7 },
      { content: 'My password is topsecret123', category: 'personal', tags: [], importance: 0.9 },
    ],
    identity: [{ aspect: 'name', value: 'Christian', confidence: 0.9 }],
  };
  const result = importV1Export(v1data);
  assert.equal(result.imported, 1, 'the docker memory imports');
  assert.equal(result.skipped, 1, 'the password memory is rejected by the pipeline');
});

test.after(() => closeDb());
