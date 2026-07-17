// Soul 4.0 Phase 2 Welle B — run lifecycle: cancel / resume / retry (F10).
//
// Covers (per SOUL4-PLAN Phase 2 "Retry/Cancel implementiert und getestet"
// + DECISIONS F09/F09r2/F10):
// - cancel: queued/running -> cancelled; the pending receipt closes with
//   contract status 'cancelled' (schema-valid); the EPISODE closes
//   TERMINALLY as cancelled_unobserved with outcome_source 'cancelled' and
//   eligibility=false (F04) — missingness, not a verdict; no outcome was
//   ever observed, outcome_observed_at records the cancel moment.
// - retry race (F03): the state transition is a compare-and-swap inside a
//   BEGIN IMMEDIATE transaction — a second retry against the same observed
//   state is refused without side effects.
// - resume: idempotent capsule re-delivery for a running run with a valid
//   lease — no new run/receipt/episode; expired lease -> honest error
//   pointing at retry.
// - retry: NEW attempt on the SAME run (attempt_count+1, new fencing token,
//   new pending receipt, new episode with its own attempt_id); only from
//   failed/cancelled; budget.max_attempts enforced (exhaustion -> refused
//   with ledger event, no state change).
// - impossible transitions are honest errors WITHOUT side effects.
// - all new Receipt/Episode objects validate against the committed schemas.
// - golden guard: soul_run without action behaves exactly like Welle A
//   (asserted here over the wire; the 9 Welle-A tests in runs.test.mjs are
//   the second half of that guarantee).

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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
const kernelDir = mkdtempSync(join(tmpdir(), 'soul-test-lifecycle-'));
process.env.SOUL_DIR = kernelDir;

const { getDb } = await import('../dist/src/kernel/db.js');
const {
  startContextRun,
  closeRunWithFeedback,
  cancelRun,
  resumeRun,
  retryRun,
  reapExpired,
  getReceiptView,
  getEpisodeView,
  getRun,
} = await import('../dist/src/kernel/runs.js');
const { queryEvents } = await import('../dist/src/kernel/ledger.js');

// ─── cancel ───────────────────────────────────────────────────────────

test('cancel: running -> cancelled, receipt closes as cancelled, episode closes TERMINALLY as cancelled_unobserved (F04 — missingness, not a verdict)', () => {
  const r = startContextRun({ task: 'A run that will be cancelled' });
  const res = cancelRun(r.run_id);
  assert.equal(res.cancelled, true);
  assert.equal(res.run_status, 'cancelled');
  assert.equal(res.receipt_id, r.receipt_id);
  assert.equal(res.receipt_status, 'cancelled');
  assert.equal(getRun(r.run_id).status, 'cancelled');

  // Receipt: contract status cancelled, honesty stays self_attested (an
  // explicit cancel is not evidence), issued_by stays coordinator (not the
  // reaper — this was an explicit call, not a timeout).
  const receipt = getReceiptView(r.receipt_id);
  assert.equal(receipt.status, 'cancelled');
  assert.equal(receipt.honesty_class, 'self_attested');
  assert.equal(receipt.issued_by, 'coordinator');
  assert.ok(receipt.closed_at, 'closed_at is set');
  assertSchemaValid(validateReceipt, receipt, 'cancelled ReceiptV1');

  // Episode: closes terminally as cancelled_unobserved (F04) — a missingness
  // state, no verdict: 'failure' would lie (cancel is not a judgment),
  // 'expired_unconfirmed' would lie about the source (schema pins it to the
  // reaper timeout). Before F04 the episode stayed PENDING forever — an
  // eternally open row indistinguishable from a live run.
  const episode = getEpisodeView(r.episode_id);
  assert.equal(episode.outcome, 'cancelled_unobserved');
  assert.equal(episode.outcome_source, 'cancelled', 'source is the explicit cancel, never a verdict');
  assert.ok(episode.outcome_observed_at, 'bitemporal: the cancel moment is recorded (when missingness became terminal)');
  assert.equal(episode.eligibility, false, 'a never-observed outcome must not enter statistics');
  assertSchemaValid(validateEpisode, episode, 'cancelled-run Episode@1 (cancelled_unobserved)');

  // Ledger: transition + receipt close + the documented episode decision
  const trans = queryEvents({ eventType: 'run.status_changed', entityId: r.run_id });
  assert.ok(trans.some((e) => e.payload.via === 'cancel' && e.payload.to === 'cancelled'));
  const closed = queryEvents({ eventType: 'receipt.closed', entityId: r.receipt_id });
  assert.equal(closed.length, 1);
  assert.equal(closed[0].payload.status, 'cancelled');
  const epEvents = queryEvents({ eventType: 'episode.outcome_recorded', entityId: r.episode_id });
  assert.equal(epEvents.length, 1);
  assert.equal(epEvents[0].payload.outcome, 'cancelled_unobserved');
  assert.ok(String(epEvents[0].payload.note).includes('missingness'), 'the ledger records that this is missingness, not a verdict');
});

test('cancel on a succeeded run is refused without side effects', () => {
  const r = startContextRun({ task: 'A run that succeeds before anyone cancels it' });
  closeRunWithFeedback({ runId: r.run_id, outcome: 'success' });
  const before = queryEvents({ entityId: r.run_id, limit: 100 }).length;

  const res = cancelRun(r.run_id);
  assert.equal(res.cancelled, false);
  assert.ok(res.error.includes('succeeded'), 'the error names the actual state');
  assert.equal(getRun(r.run_id).status, 'succeeded', 'no state change');
  assert.equal(getReceiptView(r.receipt_id).status, 'succeeded', 'receipt untouched');
  assert.equal(queryEvents({ entityId: r.run_id, limit: 100 }).length, before, 'no ledger event for a refused transition');
});

test('double cancel is refused; feedback after cancel is refused as already_closed', () => {
  const r = startContextRun({ task: 'Cancel me twice' });
  assert.equal(cancelRun(r.run_id).cancelled, true);

  const again = cancelRun(r.run_id);
  assert.equal(again.cancelled, false);
  assert.ok(again.error.includes('cancelled'));

  const fb = closeRunWithFeedback({ runId: r.run_id, outcome: 'success' });
  assert.equal(fb.closed, false);
  assert.equal(fb.already_closed, true);
  assert.equal(getEpisodeView(r.episode_id).outcome, 'cancelled_unobserved', 'late feedback cannot rewrite a cancelled attempt');
});

test('cancel on an unknown run id is an honest error', () => {
  const res = cancelRun('run-does-not-exist');
  assert.equal(res.cancelled, false);
  assert.ok(res.error.includes('not found'));
});

// ─── resume ───────────────────────────────────────────────────────────

test('resume: running run with valid lease re-delivers the same capsule idempotently', () => {
  const r = startContextRun({ task: 'A resumable run' });
  const db = getDb();
  const rowsBefore = {
    receipts: db.prepare(`SELECT COUNT(*) c FROM receipts WHERE run_id = ?`).get(r.run_id).c,
    episodes: db.prepare(`SELECT COUNT(*) c FROM episodes WHERE run_id = ?`).get(r.run_id).c,
  };

  const res1 = resumeRun(r.run_id);
  const res2 = resumeRun(r.run_id);
  for (const res of [res1, res2]) {
    assert.equal(res.resumed, true);
    assert.equal(res.run_id, r.run_id);
    assert.equal(res.status, 'running');
    assert.equal(res.receipt_id, r.receipt_id, 'same receipt — no new one');
    assert.equal(res.episode_id, r.episode_id, 'same episode — no new one');
    assert.equal(res.attempt, 1);
    assert.equal(res.task_contract.contract, 'TaskContract@1');
    assertSchemaValid(validateTaskContract, res.task_contract, 'resumed TaskContract@1');
  }

  assert.equal(db.prepare(`SELECT COUNT(*) c FROM receipts WHERE run_id = ?`).get(r.run_id).c, rowsBefore.receipts, 'no new receipt');
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM episodes WHERE run_id = ?`).get(r.run_id).c, rowsBefore.episodes, 'no new episode');
  assert.equal(getReceiptView(r.receipt_id).status, 'pending', 'receipt untouched by resume');

  // resume is not a transition — it leaves an audit event, never a status change
  assert.equal(queryEvents({ eventType: 'run.resumed', entityId: r.run_id }).length, 2);
  assert.equal(queryEvents({ eventType: 'run.status_changed', entityId: r.run_id }).length, 0);
});

test('resume on an expired lease is an honest error pointing at retry', () => {
  const r = startContextRun({ task: 'A run whose lease expires' });
  getDb().prepare(`UPDATE runs SET lease_until = ? WHERE run_id = ?`).run('2000-01-01T00:00:00.000Z', r.run_id);

  const res = resumeRun(r.run_id);
  assert.equal(res.resumed, false);
  assert.ok(res.error.includes('expired lease'));
  assert.ok(res.error.includes('retry'), 'the error points at retry');
  assert.equal(getRun(r.run_id).status, 'running', 'resume itself never transitions the run');
});

test('resume on a cancelled run is refused with a retry hint', () => {
  const r = startContextRun({ task: 'Cancelled, then resumed' });
  cancelRun(r.run_id);
  const res = resumeRun(r.run_id);
  assert.equal(res.resumed, false);
  assert.ok(res.error.includes(`'cancelled'`));
  assert.ok(res.error.includes('retry'));
});

// ─── retry ────────────────────────────────────────────────────────────

test('retry on a failed run creates a NEW attempt: attempt 2, new fencing token, new pending receipt, new episode', () => {
  const r = startContextRun({ task: 'Fails once, retried once', budget: { max_attempts: 2 } });
  const originalFence = getRun(r.run_id).fencing_token;
  closeRunWithFeedback({ runId: r.run_id, outcome: 'failure' });
  assert.equal(getRun(r.run_id).status, 'failed');

  const res = retryRun(r.run_id);
  assert.equal(res.retried, true);
  assert.equal(res.run_id, r.run_id, 'SAME run');
  assert.equal(res.status, 'running');
  assert.equal(res.attempt, 2);
  assert.notEqual(res.receipt_id, r.receipt_id, 'new receipt');
  assert.notEqual(res.episode_id, r.episode_id, 'new episode');
  assertSchemaValid(validateTaskContract, res.task_contract, 'retried TaskContract@1');

  const run = getRun(r.run_id);
  assert.equal(run.status, 'running');
  assert.equal(run.attempt_count, 2);
  assert.notEqual(run.fencing_token, originalFence, 'new fencing token — the old one can never commit again');

  const receipt = getReceiptView(res.receipt_id);
  assert.equal(receipt.status, 'pending');
  assert.equal(receipt.honesty_class, 'self_attested');
  assert.equal(receipt.attempt, 2);
  assert.equal(receipt.fencing_token, run.fencing_token);
  assert.equal(receipt.mode, 'context');
  assertSchemaValid(validateReceipt, receipt, 'attempt-2 pending ReceiptV1');

  const episode = getEpisodeView(res.episode_id);
  assert.equal(episode.outcome, 'PENDING');
  assert.equal(episode.attempt_id, `${r.run_id}.a2`, 'the episode carries its own attempt reference');
  assert.equal(episode.receipt_id, res.receipt_id);
  assert.equal(episode.eligibility, false);
  assertSchemaValid(validateEpisode, episode, 'attempt-2 PENDING Episode@1');

  const db = getDb();
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM runs WHERE run_id = ?`).get(r.run_id).c, 1, 'still ONE run row');
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM receipts WHERE run_id = ?`).get(r.run_id).c, 2, 'two receipts (one per attempt)');
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM episodes WHERE run_id = ?`).get(r.run_id).c, 2, 'two episodes (one per attempt)');

  const trans = queryEvents({ eventType: 'run.status_changed', entityId: r.run_id });
  assert.ok(trans.some((e) => e.payload.via === 'retry' && e.payload.attempt === 2));
  assert.equal(queryEvents({ eventType: 'receipt.issued', entityId: res.receipt_id }).length, 1);

  // feedback now closes the CURRENT attempt, never the old one
  const fb = closeRunWithFeedback({ runId: r.run_id, outcome: 'success', evidenceRef: 'node --test exit 0' });
  assert.equal(fb.closed, true);
  assert.equal(fb.receipt_id, res.receipt_id, 'feedback addresses the attempt-2 receipt');
  assert.equal(getReceiptView(r.receipt_id).status, 'failed', 'attempt-1 receipt untouched');
  assert.equal(getEpisodeView(r.episode_id).outcome, 'failure', 'attempt-1 episode keeps its honest failure');
  assert.equal(getEpisodeView(res.episode_id).outcome, 'success');
  assertSchemaValid(validateEpisode, getEpisodeView(res.episode_id), 'attempt-2 closed Episode@1');
});

test('retry on a cancelled run: the cancelled attempt episode keeps its terminal cancelled_unobserved, the new attempt closes normally', () => {
  const r = startContextRun({ task: 'Cancelled, then retried', budget: { max_attempts: 2 } });
  cancelRun(r.run_id);

  const res = retryRun(r.run_id);
  assert.equal(res.retried, true);
  assert.equal(res.attempt, 2);

  const fb = closeRunWithFeedback({ runId: r.run_id, outcome: 'success' });
  assert.equal(fb.closed, true);
  assert.equal(getEpisodeView(res.episode_id).outcome, 'success');
  assert.equal(getEpisodeView(r.episode_id).outcome, 'cancelled_unobserved', 'the cancelled attempt episode is never re-opened or back-filled');
  assert.equal(getEpisodeView(r.episode_id).outcome_source, 'cancelled');
  assertSchemaValid(validateEpisode, getEpisodeView(r.episode_id), 'cancelled attempt Episode@1 stays valid');
});

test('retry beyond budget.max_attempts is refused with a ledger event and no state change', () => {
  // default budget: max_attempts = 1
  const r = startContextRun({ task: 'Only one attempt allowed' });
  closeRunWithFeedback({ runId: r.run_id, outcome: 'failure' });

  const res = retryRun(r.run_id);
  assert.equal(res.retried, false);
  assert.equal(res.refused, true);
  assert.ok(res.error.includes('max_attempts'));

  assert.equal(getRun(r.run_id).status, 'failed', 'run unchanged');
  assert.equal(getRun(r.run_id).attempt_count, 1, 'no new attempt');
  const db = getDb();
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM receipts WHERE run_id = ?`).get(r.run_id).c, 1, 'no new receipt');
  const refusals = queryEvents({ eventType: 'run.retry_refused', entityId: r.run_id });
  assert.equal(refusals.length, 1);
  assert.equal(refusals[0].payload.reason, 'max_attempts_exhausted');
});

test('retry on a running run is refused without side effects; retry on unknown run errors', () => {
  const r = startContextRun({ task: 'Still running, do not retry me' });
  const res = retryRun(r.run_id);
  assert.equal(res.retried, false);
  assert.ok(res.error.includes(`'running'`));
  assert.equal(getRun(r.run_id).attempt_count, 1);
  assert.equal(getDb().prepare(`SELECT COUNT(*) c FROM receipts WHERE run_id = ?`).get(r.run_id).c, 1);

  const missing = retryRun('run-does-not-exist');
  assert.equal(missing.retried, false);
  assert.ok(missing.error.includes('not found'));
});

test('retry on an expired run (reaper-failed) is allowed — expired runs are booked failed', () => {
  const r = startContextRun({ task: 'Expires, then retried', budget: { max_attempts: 2 } });
  const db = getDb();
  // Age the receipt + lease past the TTL, then let the reaper sweep.
  db.prepare(`UPDATE receipts SET created_at = ? WHERE receipt_id = ?`).run('2000-01-01T00:00:00.000Z', r.receipt_id);
  db.prepare(`UPDATE runs SET lease_until = ? WHERE run_id = ?`).run('2000-01-01T00:00:00.000Z', r.run_id);
  reapExpired();
  assert.equal(getRun(r.run_id).status, 'failed');
  assert.equal(getReceiptView(r.receipt_id).status, 'expired_unconfirmed');

  const res = retryRun(r.run_id);
  assert.equal(res.retried, true);
  assert.equal(res.attempt, 2);
  assert.equal(getEpisodeView(r.episode_id).outcome, 'expired_unconfirmed', 'the expired attempt keeps its missingness record');
  assert.equal(getEpisodeView(res.episode_id).outcome, 'PENDING');
});

// ─── retry race (F03) ─────────────────────────────────────────────────

test('retry race (F03): the compare-and-swap admits exactly ONE new attempt — the loser is refused without side effects', () => {
  const r = startContextRun({ task: 'Two racers, one attempt', budget: { max_attempts: 5 } });
  closeRunWithFeedback({ runId: r.run_id, outcome: 'failure' });
  assert.equal(getRun(r.run_id).status, 'failed');
  const db = getDb();
  const eventsBefore = queryEvents({ entityId: r.run_id, limit: 200 }).length;

  // Two retry calls against the SAME observed state (failed, attempt 1).
  // The first wins and transitions the run; the second is refused — in-process
  // via the state pre-check, cross-process via the CAS WHERE(status,
  // attempt_count, fencing_token) inside BEGIN IMMEDIATE. Either way the
  // invariant holds: exactly one new attempt, zero side effects for the loser.
  const first = retryRun(r.run_id);
  const second = retryRun(r.run_id);
  assert.equal(first.retried, true);
  assert.equal(first.attempt, 2);
  assert.equal(second.retried, false, 'the second retry must lose');
  assert.equal(getRun(r.run_id).attempt_count, 2, 'exactly ONE new attempt');
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM receipts WHERE run_id = ?`).get(r.run_id).c, 2, 'no third receipt');
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM episodes WHERE run_id = ?`).get(r.run_id).c, 2, 'no third episode');

  // Second race round with ledger accounting: the loser must leave NO trace.
  // (The CAS-mismatch branch itself — pre-check passed on a stale read, CAS
  // matches 0 rows — is only reachable with true cross-process interleaving;
  // in a synchronous single process the pre-check always sees fresh state.
  // BEGIN IMMEDIATE + WHERE(status, attempt_count, fencing_token) closes that
  // window; the invariant asserted here is identical for both refusal paths.)
  closeRunWithFeedback({ runId: r.run_id, outcome: 'failure' });
  assert.equal(getRun(r.run_id).status, 'failed');
  const receiptsBefore = db.prepare(`SELECT COUNT(*) c FROM receipts WHERE run_id = ?`).get(r.run_id).c;
  const eventsMid = queryEvents({ entityId: r.run_id, limit: 200 }).length;
  const winner = retryRun(r.run_id);
  const loser = retryRun(r.run_id);
  assert.equal(winner.retried, true);
  assert.equal(winner.attempt, 3);
  assert.equal(loser.retried, false);
  assert.ok(loser.error.includes('No state was changed'), 'the refusal is honest about zero side effects');
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM receipts WHERE run_id = ?`).get(r.run_id).c, receiptsBefore + 1, 'the loser created no receipt');
  const eventsAfter = queryEvents({ entityId: r.run_id, limit: 200 }).length;
  // winner: run.status_changed (+ its receipt/episode events live on other entity ids)
  assert.equal(eventsAfter - eventsMid, 1, 'the loser wrote NO ledger event on the run');
  assert.ok(eventsBefore > 0, 'sanity: ledger was live before the race');
});

// ─── End-to-end over the MCP server: action routing ───────────────────

function rpcClient(extraEnv = {}) {
  const soulDir = mkdtempSync(join(tmpdir(), 'soul-test-lifecycle-e2e-'));
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
const callRaw = async (c, name, args = {}) => {
  const res = await c.request('tools/call', { name, arguments: args });
  return res.result;
};

test('e2e golden guard: soul_run WITHOUT action behaves exactly like Welle A (same capsule shape)', async () => {
  const c = rpcClient();
  try {
    await handshake(c);
    const capsule = await callJson(c, 'soul_run', { task: 'Welle-A shaped submit', idempotency_key: 'golden-1' });
    // exact Welle-A response keys, nothing dropped, nothing renamed
    assert.deepEqual(
      Object.keys(capsule).sort(),
      ['episode_id', 'existing', 'hinweis', 'mode', 'receipt_id', 'run_id', 'status', 'task_contract'].sort()
    );
    assert.equal(capsule.mode, 'context');
    assert.equal(capsule.existing, false);
    assert.equal(capsule.status, 'running');
    assert.equal(capsule.task_contract.source, 'freitext_compiled');
    assertSchemaValid(validateTaskContract, capsule.task_contract, 'golden TaskContract@1');
    assert.ok(capsule.hinweis.includes('soul_feedback'));

    const again = await callJson(c, 'soul_run', { task: 'Welle-A shaped submit', idempotency_key: 'golden-1' });
    assert.equal(again.existing, true);
    assert.equal(again.run_id, capsule.run_id);
  } finally {
    c.child.kill();
  }
});

test('e2e: action routing — cancel, resume, retry over the wire; bad inputs are honest isError', async () => {
  const c = rpcClient();
  try {
    await handshake(c);

    // submit without task -> isError
    const noTask = await callRaw(c, 'soul_run', { action: 'submit' });
    assert.equal(noTask.isError, true);
    // lifecycle action without run_id -> isError
    const noRunId = await callRaw(c, 'soul_run', { action: 'cancel' });
    assert.equal(noRunId.isError, true);
    assert.ok(JSON.parse(noRunId.content[0].text).error.includes('run_id'));

    // submit -> resume -> cancel -> feedback refused -> retry -> feedback closes attempt 2
    const capsule = await callJson(c, 'soul_run', { task: 'lifecycle e2e run', budget: { max_attempts: 2 } });

    const resumed = await callJson(c, 'soul_run', { action: 'resume', run_id: capsule.run_id });
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.receipt_id, capsule.receipt_id, 'resume re-delivers, never creates');
    assert.equal(resumed.existing, true);

    const cancelled = await callJson(c, 'soul_run', { action: 'cancel', run_id: capsule.run_id });
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.receipt_status, 'cancelled');

    const cancelTwice = await callRaw(c, 'soul_run', { action: 'cancel', run_id: capsule.run_id });
    assert.equal(cancelTwice.isError, true, 'cancel on cancelled is an honest error');

    const lateFb = await callJson(c, 'soul_feedback', { run_id: capsule.run_id, outcome: 'success' });
    assert.equal(lateFb.run.closed, false);
    assert.equal(lateFb.run.already_closed, true);

    const retried = await callJson(c, 'soul_run', { action: 'retry', run_id: capsule.run_id });
    assert.equal(retried.retried, true);
    assert.equal(retried.attempt, 2);
    assert.notEqual(retried.receipt_id, capsule.receipt_id);

    const fb = await callJson(c, 'soul_feedback', {
      run_id: capsule.run_id,
      outcome: 'success',
      evidence_ref: 'node --test exit 0',
    });
    assert.equal(fb.run.closed, true);
    assert.equal(fb.run.receipt_id, retried.receipt_id, 'feedback closes the attempt-2 receipt');
    assert.equal(fb.run.honesty_class, 'self_attested', 'evidence_ref never upgrades (F02)');

    // retry on the now-succeeded run over the wire -> honest isError (impossible transition)
    const afterSuccess = await callRaw(c, 'soul_run', { action: 'retry', run_id: capsule.run_id });
    assert.equal(afterSuccess.isError, true);
    assert.ok(JSON.parse(afterSuccess.content[0].text).error.includes(`'succeeded'`));
  } finally {
    c.child.kill();
  }
});
