// Soul 4.0 Phase 2 Welle A — soul_run Durchstich, Kontextmodus ONLY.
//
// Covers (per SOUL4-PLAN Phase 2 + DECISIONS F09/F09r2):
// - idempotency: same key twice -> one run, no duplicate
// - the receipt exists SYNCHRONOUSLY at run creation, pending/self_attested
// - soul_feedback with run_id closes the receipt and back-fills the episode
//   outcome bitemporally (outcome_observed_at)
// - evidence_ref NEVER changes honesty_class (F02): the reference is carried
//   in the receipt outcome, the receipt stays self_attested — a string claim
//   is not a verification; deterministic_verified needs a validated
//   VerifierResult@1 (path not built in 4.0)
// - reaper (lazy sweep) closes an expired pending receipt as
//   expired_unconfirmed (TTL=0 in the test) and fails the orphaned run
// - migration v9 -> v10 on a copy of a real database, with backup
// - generated Receipt/Episode/TaskContract objects validate against the
//   committed JSON schemas (contract binding, via ajv)
// - end-to-end over the real MCP server (spawned binary, JSON-RPC/stdio)

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import AjvModule from 'ajv/dist/2020.js';

const Ajv2020 = AjvModule.default ?? AjvModule;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
const loadSchema = (name) =>
  JSON.parse(readFileSync(join(root, 'design', 'contracts', name), 'utf8'));
const validateReceipt = ajv.compile(loadSchema('ReceiptV1.schema.json'));
const validateEpisode = ajv.compile(loadSchema('Episode@1.schema.json'));
const validateTaskContract = ajv.compile(loadSchema('TaskContract@1.schema.json'));

function assertSchemaValid(validate, doc, label) {
  const ok = validate(doc);
  assert.ok(ok, `${label} must validate against its schema, errors: ${JSON.stringify(validate.errors)} doc: ${JSON.stringify(doc)}`);
}

// SOUL_DIR must point at a fresh dir BEFORE the kernel modules open the db.
const kernelDir = mkdtempSync(join(tmpdir(), 'soul-test-runs-'));
process.env.SOUL_DIR = kernelDir;

const { getDb, closeDb, SCHEMA_VERSION } = await import('../dist/src/kernel/db.js');
const {
  startContextRun,
  closeRunWithFeedback,
  reapExpired,
  getReceiptView,
  getEpisodeView,
  getRun,
} = await import('../dist/src/kernel/runs.js');
const { queryEvents } = await import('../dist/src/kernel/ledger.js');

// ─── Kernel-level: creation, idempotency, contract binding ────────────

test('soul_run creates run + pending receipt + PENDING episode synchronously, schema-valid', () => {
  const r = startContextRun({ task: 'Fix the failing ledger test without breaking others', risk: 'low' });
  assert.equal(r.existing, false);
  assert.equal(r.status, 'running');
  assert.ok(r.run_id && r.receipt_id && r.episode_id, 'run, receipt and episode ids all exist');

  // TaskContract binding
  assert.equal(r.task_contract.contract, 'TaskContract@1');
  assert.equal(r.task_contract.source, 'freitext_compiled');
  assertSchemaValid(validateTaskContract, r.task_contract, 'compiled TaskContract@1');

  // Receipt: synchronous, pending, self_attested, issued_by coordinator
  const receipt = getReceiptView(r.receipt_id);
  assert.equal(receipt.status, 'pending');
  assert.equal(receipt.honesty_class, 'self_attested');
  assert.equal(receipt.issued_by, 'coordinator');
  assert.equal(receipt.mode, 'context');
  assert.equal(receipt.actor, 'agent', 'run results never carry user authority (TB1)');
  assert.equal(receipt.tainted, false);
  assertSchemaValid(validateReceipt, receipt, 'pending ReceiptV1');

  // Episode: PENDING outcome, acceptance unknown, causal chain wired to the run
  const episode = getEpisodeView(r.episode_id);
  assert.equal(episode.outcome, 'PENDING');
  assert.equal(episode.acceptance, 'unknown');
  assert.equal(episode.outcome_observed_at, null, 'PENDING carries no observation time');
  assert.equal(episode.outcome_source, undefined, 'PENDING carries no outcome_source');
  assert.equal(episode.run_id, r.run_id);
  assert.equal(episode.receipt_id, r.receipt_id);
  assert.equal(episode.eligibility, false, 'unknown execution must not enter actor statistics');
  assertSchemaValid(validateEpisode, episode, 'PENDING Episode@1');

  // Ledger events for every state change
  assert.equal(queryEvents({ eventType: 'run.created', entityId: r.run_id }).length, 1);
  assert.equal(queryEvents({ eventType: 'receipt.issued', entityId: r.receipt_id }).length, 1);
  assert.equal(queryEvents({ eventType: 'episode.recorded', entityId: r.episode_id }).length, 1);
});

test('idempotency: the same key twice returns the same run, no duplicate', () => {
  const key = 'idem-test-0001';
  const first = startContextRun({ task: 'Write the release notes', idempotencyKey: key });
  const second = startContextRun({ task: 'Write the release notes', idempotencyKey: key });
  assert.equal(first.existing, false);
  assert.equal(second.existing, true);
  assert.equal(second.run_id, first.run_id);
  assert.equal(second.receipt_id, first.receipt_id);
  const count = getDb().prepare(`SELECT COUNT(*) c FROM runs WHERE idempotency_key = ?`).get(key);
  assert.equal(count.c, 1, 'exactly one run row for the key');
  const receipts = getDb().prepare(`SELECT COUNT(*) c FROM receipts WHERE run_id = ?`).get(first.run_id);
  assert.equal(receipts.c, 1, 'exactly one receipt for the run');
});

test('feedback closes receipt + back-fills episode bitemporally; no evidence stays self_attested', () => {
  const r = startContextRun({ task: 'Summarize the audit findings' });
  const res = closeRunWithFeedback({ runId: r.run_id, outcome: 'success' });
  assert.equal(res.closed, true);
  assert.equal(res.run_status, 'succeeded');
  assert.equal(res.receipt_status, 'succeeded');
  assert.equal(res.honesty_class, 'self_attested', 'no evidence_ref -> NO upgrade');

  const receipt = getReceiptView(r.receipt_id);
  assert.equal(receipt.status, 'succeeded');
  assert.equal(receipt.honesty_class, 'self_attested');
  assert.ok(receipt.closed_at, 'closed_at is set');
  assertSchemaValid(validateReceipt, receipt, 'closed ReceiptV1');

  const episode = getEpisodeView(r.episode_id);
  assert.equal(episode.outcome, 'success');
  assert.equal(episode.outcome_source, 'self_attested');
  assert.ok(episode.outcome_observed_at, 'bitemporal back-fill: observation time recorded');
  assert.ok(episode.outcome_observed_at >= episode.recorded_at, 'observed after recorded');
  assertSchemaValid(validateEpisode, episode, 'closed Episode@1');

  assert.equal(queryEvents({ eventType: 'receipt.closed', entityId: r.receipt_id }).length, 1);

  // closing twice is refused honestly, not silently re-applied
  const again = closeRunWithFeedback({ runId: r.run_id, outcome: 'failure' });
  assert.equal(again.closed, false);
  assert.equal(again.already_closed, true);
  assert.equal(getEpisodeView(r.episode_id).outcome, 'success', 'second feedback does not overwrite');
});

test('evidence_ref ändert die honesty_class NICHT — bleibt self_attested, Referenz wird geführt (F02)', () => {
  const r = startContextRun({ task: 'Repair the flaky migration test' });
  const res = closeRunWithFeedback({
    runId: r.run_id,
    outcome: 'success',
    evidenceRef: 'npm test -> exit 0, 170 pass',
  });
  // A string claim is not a verification: deterministic_verified would need a
  // validated VerifierResult@1 from a separate verifier — that path does not
  // exist in 4.0, so nothing may mint the stronger class.
  assert.equal(res.honesty_class, 'self_attested', 'evidence_ref must NOT upgrade');
  const receipt = getReceiptView(r.receipt_id);
  assert.equal(receipt.honesty_class, 'self_attested');
  assertSchemaValid(validateReceipt, receipt, 'closed self_attested ReceiptV1');

  // The reference itself is preserved for later audit (receipt outcome JSON + ledger).
  const raw = getDb().prepare(`SELECT outcome FROM receipts WHERE receipt_id = ?`).get(r.receipt_id);
  assert.equal(JSON.parse(raw.outcome).evidence_ref, 'npm test -> exit 0, 170 pass');
  const closedEvents = queryEvents({ eventType: 'receipt.closed', entityId: r.receipt_id });
  assert.equal(closedEvents.length, 1);
  assert.equal(closedEvents[0].payload.evidence_ref, 'npm test -> exit 0, 170 pass');
  assert.equal(closedEvents[0].payload.honesty_class, 'self_attested');
});

test('mixed feedback books the run fail-closed, the episode keeps the honest mixed', () => {
  const r = startContextRun({ task: 'Half-done refactor probe' });
  const res = closeRunWithFeedback({ runId: r.run_id, outcome: 'mixed' });
  assert.equal(res.run_status, 'failed', 'mixed -> run failed (fail-closed at run level)');
  assert.equal(res.receipt_status, 'failed');
  assert.equal(getEpisodeView(r.episode_id).outcome, 'mixed', 'episode keeps mixed');
  assertSchemaValid(validateEpisode, getEpisodeView(r.episode_id), 'mixed Episode@1');
});

test('reaper closes an expired pending receipt as expired_unconfirmed (TTL=0) and fails the run', () => {
  const r = startContextRun({ task: 'A run nobody ever confirms' });
  process.env.SOUL_RECEIPT_TTL_DAYS = '0';
  try {
    const swept = reapExpired();
    assert.ok(swept.receipts_expired >= 1, 'at least the fresh pending receipt expired');
  } finally {
    delete process.env.SOUL_RECEIPT_TTL_DAYS;
  }

  const receipt = getReceiptView(r.receipt_id);
  assert.equal(receipt.status, 'expired_unconfirmed');
  assert.equal(receipt.issued_by, 'reaper', 'only the reaper closes as expired_unconfirmed');
  assert.equal(receipt.honesty_class, 'self_attested', 'silence never upgrades');
  assertSchemaValid(validateReceipt, receipt, 'expired ReceiptV1');

  const episode = getEpisodeView(r.episode_id);
  assert.equal(episode.outcome, 'expired_unconfirmed');
  assert.equal(episode.outcome_source, 'expired_unconfirmed', 'missingness, not a verdict');
  assert.ok(episode.outcome_observed_at);
  assertSchemaValid(validateEpisode, episode, 'expired Episode@1');

  assert.equal(getRun(r.run_id).status, 'failed');
  const evs = queryEvents({ eventType: 'run.status_changed', entityId: r.run_id });
  assert.ok(evs.some((e) => e.payload.via === 'reaper'), 'run failure via reaper is on the ledger');
});

// ─── v12 defense-in-depth: attempt uniqueness at the storage layer ───

test('v12: a second episode or receipt for the same (run_id, attempt) is refused by SQLite', () => {
  const db = getDb();
  const r = startContextRun({ task: 'v12 attempt uniqueness probe' });
  const now = new Date().toISOString();

  // Episode: startContextRun already booked attempt_id "<run>.a1" — a second
  // episode with the same (run_id, attempt_id) must hit idx_episodes_run_attempt.
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO episodes (episode_id, occurred_at, recorded_at, task_slice, acceptance, executed, run_id, attempt_id, receipt_id, cost)
           VALUES (?, ?, ?, ?, 'unknown', ?, ?, ?, ?, ?)`
        )
        .run(
          'ep_dup_v12',
          now,
          now,
          JSON.stringify({ kind: 'other', risk: 'low' }),
          JSON.stringify({ actor: 'unknown', recipe_id: null, model_echo: null, context_echo: null }),
          r.run_id,
          `${r.run_id}.a1`,
          r.receipt_id,
          JSON.stringify({ tokens_est: 0, latency_ms: 0, attempts: 1 })
        ),
    /UNIQUE constraint failed: episodes\.run_id, episodes\.attempt_id/,
    'duplicate (run_id, attempt_id) episode must be refused'
  );

  // Receipt: the attempt number lives in the outcome JSON — a second receipt
  // with json_extract(outcome,'$.attempt') = 1 for the same run must hit
  // idx_receipts_run_attempt (UNIQUE expression index).
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO receipts (receipt_id, run_id, status, honesty_class, issued_by, created_at, closed_at, outcome)
           VALUES ('rcpt_dup_v12', ?, 'pending', 'self_attested', 'coordinator', ?, NULL, ?)`
        )
        .run(r.run_id, now, JSON.stringify({ status: 'pending', attempt: 1, mode: 'context', actor: 'agent', tainted: false })),
    /UNIQUE constraint failed: index 'idx_receipts_run_attempt'/,
    'duplicate (run_id, attempt) receipt must be refused'
  );

  // The run itself stays fully usable after the refused writes.
  const closed = closeRunWithFeedback({ runId: r.run_id, outcome: 'success' });
  assert.equal(closed.closed, true);
});

// ─── Migration v9 -> current on a copy of a real database ────────────

test('migration v9 -> current: real db copy gains runs/receipts/episodes, keeps data, writes backup', async () => {
  // The kernel db above IS a real database (memories, events, runs...).
  // Copy it, strip it back to v9 (drop the three v10 tables, set
  // schema_version=9) and let getDb() migrate the copy through the whole
  // additive chain (v10 runs tables, v11 skills registry — Phase 3).
  closeDb();
  const srcPath = join(kernelDir, 'memories.db');
  const migDir = mkdtempSync(join(tmpdir(), 'soul-test-runs-mig-'));
  const dbPath = join(migDir, 'memories.db');
  copyFileSync(srcPath, dbPath);

  {
    const raw = new Database(dbPath);
    const eventsBefore = raw.prepare(`SELECT COUNT(*) c FROM events`).get().c;
    assert.ok(eventsBefore > 0, 'the copied db carries real data');
    raw.exec(`DROP TABLE IF EXISTS episodes; DROP TABLE IF EXISTS receipts; DROP TABLE IF EXISTS runs;`);
    raw.prepare(`UPDATE meta SET value = '9' WHERE key = 'schema_version'`).run();
    raw.close();
  }

  process.env.SOUL_DIR = migDir;
  const db = getDb(); // triggers the v9 -> current migration with backup

  const version = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get();
  assert.equal(Number(version.value), SCHEMA_VERSION);
  // 12 = v10 runs tables + v11 skills registry (Phase 3) + v12 attempt
  // uniqueness indexes. This pin exists so an ACCIDENTAL schema bump fails
  // loudly — bump it only with a migration.
  assert.equal(SCHEMA_VERSION, 12);

  for (const table of ['runs', 'receipts', 'episodes', 'skills', 'trusted_keys', 'pack_versions']) {
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table);
    assert.ok(row, `table ${table} exists after migration`);
  }
  for (const idx of ['idx_episodes_run_attempt', 'idx_receipts_run_attempt']) {
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`).get(idx);
    assert.ok(row, `v12 index ${idx} exists after migration`);
  }

  const eventsAfter = db.prepare(`SELECT COUNT(*) c FROM events`).get().c;
  assert.ok(eventsAfter > 0, 'existing ledger data survives the migration');

  const backups = readdirSync(join(migDir, 'backups'));
  assert.ok(backups.some((b) => b.includes(`pre-migration-v9-to-v${SCHEMA_VERSION}`)), `backup written: ${backups}`);

  // the migrated db is fully usable for runs
  const r = startContextRun({ task: 'post-migration smoke run' });
  assert.equal(getReceiptView(r.receipt_id).status, 'pending');

  closeDb();
});

// ─── End-to-end over the MCP server (spawned binary) ─────────────────

function rpcClient(extraEnv = {}) {
  const soulDir = mkdtempSync(join(tmpdir(), 'soul-test-runs-e2e-'));
  const child = spawn(process.execPath, [join(root, 'dist/src/index.js')], {
    env: { ...process.env, SOUL_DIR: soulDir, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  const pending = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  let nextId = 1;
  const request = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`timeout waiting for ${method}`));
        }
      }, 10000);
    });
  const notify = (method, params = {}) => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  };
  return { child, request, notify, soulDir };
}

async function handshake(c) {
  await c.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'soul-test', version: '0.0.0' },
  });
  c.notify('notifications/initialized');
}

const callJson = async (c, name, args = {}) => {
  const res = await c.request('tools/call', { name, arguments: args });
  return JSON.parse(res.result.content[0].text);
};

test('e2e: soul_run capsule -> idempotent resubmit -> soul_feedback closes receipt + episode', async () => {
  const c = rpcClient();
  try {
    await handshake(c);

    const tools = await c.request('tools/list');
    assert.ok(tools.result.tools.some((t) => t.name === 'soul_run'), 'soul_run is registered');

    const capsule = await callJson(c, 'soul_run', {
      task: 'Draft the SOL gate brief for wave A',
      idempotency_key: 'e2e-key-1',
      risk: 'low',
    });
    assert.equal(capsule.mode, 'context');
    assert.equal(capsule.existing, false);
    assert.ok(capsule.run_id && capsule.receipt_id, 'capsule carries run_id + receipt_id');
    assert.equal(capsule.task_contract.contract, 'TaskContract@1');
    assert.equal(capsule.task_contract.source, 'freitext_compiled');
    assertSchemaValid(validateTaskContract, capsule.task_contract, 'e2e TaskContract@1');
    assert.ok(capsule.hinweis.includes('soul_feedback'), 'the capsule says how to close the run');

    // idempotent resubmit over the wire
    const again = await callJson(c, 'soul_run', { task: 'Draft the SOL gate brief for wave A', idempotency_key: 'e2e-key-1' });
    assert.equal(again.existing, true);
    assert.equal(again.run_id, capsule.run_id);

    // run_id without outcome is refused
    const bad = await c.request('tools/call', { name: 'soul_feedback', arguments: { run_id: capsule.run_id } });
    assert.equal(bad.result.isError, true, 'run_id without outcome is an error');

    // close with an evidence reference: recorded, but NO honesty upgrade (F02)
    const fb = await callJson(c, 'soul_feedback', {
      run_id: capsule.run_id,
      outcome: 'success',
      evidence_ref: 'node --test exit 0',
    });
    assert.equal(fb.run.closed, true);
    assert.equal(fb.run.receipt_status, 'succeeded');
    assert.equal(fb.run.honesty_class, 'self_attested', 'evidence_ref string never upgrades (F02)');

    // assert persisted state directly in the server's own db
    const db = new Database(join(c.soulDir, 'memories.db'), { readonly: true });
    const receipt = db.prepare(`SELECT * FROM receipts WHERE receipt_id = ?`).get(capsule.receipt_id);
    assert.equal(receipt.status, 'closed');
    assert.equal(receipt.honesty_class, 'self_attested');
    assert.equal(JSON.parse(receipt.outcome).evidence_ref, 'node --test exit 0', 'the reference is carried for audit');
    const episode = db.prepare(`SELECT outcome, outcome_source, outcome_observed_at FROM episodes WHERE run_id = ?`).get(capsule.run_id);
    assert.equal(episode.outcome, 'success');
    assert.equal(episode.outcome_source, 'self_attested');
    assert.ok(episode.outcome_observed_at);
    db.close();
  } finally {
    c.child.kill();
  }
});

test('e2e: capsule-only soul_feedback (no run_id) keeps its existing contract', async () => {
  const c = rpcClient();
  try {
    await handshake(c);
    await callJson(c, 'soul_remember', { content: 'The retrieval layer blends BM25 with recency decay' });
    const ctx = await callJson(c, 'soul_context', { task: 'retrieval layer', token_budget: 4000 });
    const fb = await callJson(c, 'soul_feedback', { context_id: ctx.context_id, used_ids: [] });
    assert.equal(typeof fb.used, 'number', 'classic capsule feedback shape unchanged');
    assert.equal(fb.run, undefined, 'no run key without run_id');
    assert.ok(fb.message.startsWith('Feedback recorded'), 'classic message unchanged');
  } finally {
    c.child.kill();
  }
});
