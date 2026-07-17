// Soul 4.0 Phase 2 Welle B — Chaos-Testmatrix (DECISIONS F09, SOUL4-PLAN
// Phase 2 Akzeptanz: "kill −9 an JEDER Grenze — je eigener Testfall").
//
// Context mode boundaries: the MCP server is spawned as a child process,
// SIGKILLed at a defined boundary, then a NEW server process starts on the
// SAME database and the invariants are checked:
//   a) kill BEFORE the first soul_run call  -> db untouched, clean restart
//   b) kill RIGHT AFTER the soul_run reply  -> run => receipt + episode
//      (the synchronous transaction), restart reaper runs without error
//   c) kill MID-FLOOD of pipelined soul_run calls -> NO run without receipt,
//      NO episode without run (SQL joins prove it), idempotency keys unique
//   d) kill AFTER a soul_feedback close -> closed receipt persists, double
//      feedback after restart is refused
//   e) reaper crash safety: expired pending receipt + TTL=0, server killed
//      right after spawn, started again -> the receipt expires exactly ONCE
//      (transactional sweep — no double ledger event)
// Every case additionally asserts PRAGMA integrity_check = ok.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import Database from 'better-sqlite3';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// ─── Server child-process harness (SIGKILL-able, reusable SOUL_DIR) ────

function spawnServer(soulDir, extraEnv = {}) {
  const child = spawn(process.execPath, [join(root, 'dist/src/index.js')], {
    env: { ...process.env, SOUL_DIR: soulDir, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  const pending = new Map();
  const responses = [];
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined) {
        responses.push(msg);
        if (pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
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
  // fire-and-forget request: pipelined, nobody waits for the reply
  const fire = (method, params = {}) => {
    const id = nextId++;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return id;
  };
  const notify = (method, params = {}) => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  };
  const kill9 = async () => {
    child.kill('SIGKILL');
    await once(child, 'exit');
  };
  return { child, request, fire, notify, kill9, responses };
}

async function handshake(c) {
  await c.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'soul-chaos', version: '0.0.0' },
  });
  c.notify('notifications/initialized');
}

const callJson = async (c, name, args = {}) => {
  const res = await c.request('tools/call', { name, arguments: args });
  return JSON.parse(res.result.content[0].text);
};

function openDb(soulDir) {
  // Plain better-sqlite3 handle — opening recovers the WAL of the killed
  // process; no kernel code involved, we inspect raw persisted state.
  return new Database(join(soulDir, 'memories.db'));
}

function assertIntegrity(db) {
  const rows = db.pragma('integrity_check');
  assert.deepEqual(rows, [{ integrity_check: 'ok' }], 'PRAGMA integrity_check must be ok');
}

function assertRunInvariants(db) {
  const runsWithoutReceipt = db
    .prepare(
      `SELECT COUNT(*) c FROM runs r LEFT JOIN receipts rc ON rc.run_id = r.run_id WHERE rc.receipt_id IS NULL`
    )
    .get().c;
  assert.equal(runsWithoutReceipt, 0, 'INVARIANT: no run without a receipt (synchronous transaction)');
  const receiptsWithoutRun = db
    .prepare(`SELECT COUNT(*) c FROM receipts rc LEFT JOIN runs r ON r.run_id = rc.run_id WHERE r.run_id IS NULL`)
    .get().c;
  assert.equal(receiptsWithoutRun, 0, 'INVARIANT: no receipt without a run');
  const episodesWithoutRun = db
    .prepare(
      `SELECT COUNT(*) c FROM episodes e LEFT JOIN runs r ON r.run_id = e.run_id WHERE e.run_id IS NOT NULL AND r.run_id IS NULL`
    )
    .get().c;
  assert.equal(episodesWithoutRun, 0, 'INVARIANT: no episode pointing at a missing run');
  const runsWithoutEpisode = db
    .prepare(`SELECT COUNT(*) c FROM runs r LEFT JOIN episodes e ON e.run_id = r.run_id WHERE e.episode_id IS NULL`)
    .get().c;
  assert.equal(runsWithoutEpisode, 0, 'INVARIANT: every run has an episode');
  const keys = db.prepare(`SELECT COUNT(*) total, COUNT(DISTINCT idempotency_key) uniq FROM runs`).get();
  assert.equal(keys.total, keys.uniq, 'INVARIANT: idempotency keys are unique');
}

// ─── a) kill BEFORE the first soul_run call ───────────────────────────

test('chaos a: SIGKILL before the first soul_run — db untouched, clean restart', async () => {
  const soulDir = mkdtempSync(join(tmpdir(), 'soul-chaos-a-'));
  const s1 = spawnServer(soulDir);
  await handshake(s1);
  await s1.kill9();

  {
    const db = openDb(soulDir);
    assert.equal(db.prepare(`SELECT COUNT(*) c FROM runs`).get().c, 0, 'no runs were created');
    assert.equal(db.prepare(`SELECT COUNT(*) c FROM receipts`).get().c, 0, 'no receipts were created');
    assert.equal(db.prepare(`SELECT COUNT(*) c FROM episodes`).get().c, 0, 'no episodes were created');
    assertIntegrity(db);
    db.close();
  }

  // restart on the same db is clean and fully usable
  const s2 = spawnServer(soulDir);
  try {
    await handshake(s2);
    const capsule = await callJson(s2, 'soul_run', { task: 'post-restart smoke run' });
    assert.equal(capsule.status, 'running');
  } finally {
    await s2.kill9();
  }
});

// ─── b) kill RIGHT AFTER the soul_run response ────────────────────────

test('chaos b: SIGKILL immediately after the soul_run reply — run => receipt + episode persisted', async () => {
  const soulDir = mkdtempSync(join(tmpdir(), 'soul-chaos-b-'));
  const s1 = spawnServer(soulDir);
  await handshake(s1);
  const capsule = await callJson(s1, 'soul_run', { task: 'killed right after the reply' });
  await s1.kill9(); // no waiting, no flush courtesy — SIGKILL

  {
    const db = openDb(soulDir);
    const run = db.prepare(`SELECT * FROM runs WHERE run_id = ?`).get(capsule.run_id);
    assert.ok(run, 'the run the client saw is persisted');
    const receipt = db.prepare(`SELECT * FROM receipts WHERE run_id = ?`).get(capsule.run_id);
    assert.ok(receipt, 'INVARIANT: run exists => receipt exists (synchronous transaction)');
    assert.equal(receipt.status, 'pending');
    const episode = db.prepare(`SELECT * FROM episodes WHERE run_id = ?`).get(capsule.run_id);
    assert.ok(episode, 'episode persisted in the same transaction');
    assert.equal(episode.outcome, 'PENDING');
    assertRunInvariants(db);
    assertIntegrity(db);
    db.close();
  }

  // restart: the startup reaper sweep runs without error, server is usable
  const s2 = spawnServer(soulDir);
  try {
    await handshake(s2);
    const fb = await callJson(s2, 'soul_feedback', { run_id: capsule.run_id, outcome: 'success' });
    assert.equal(fb.run.closed, true, 'the surviving run is closable after restart');
  } finally {
    await s2.kill9();
  }
});

// ─── c) kill MID-FLOOD of pipelined soul_run calls ────────────────────

test('chaos c: SIGKILL amid a flood of pipelined soul_run calls — joins prove no orphans', async () => {
  const soulDir = mkdtempSync(join(tmpdir(), 'soul-chaos-c-'));
  const s1 = spawnServer(soulDir);
  await handshake(s1);

  // 5 confirmed runs so the invariants below cannot pass vacuously ...
  for (let i = 0; i < 5; i++) {
    await callJson(s1, 'soul_run', { task: `flood warm-up ${i}` });
  }
  // ... then 25 pipelined calls, killed without waiting for ANY reply.
  for (let i = 0; i < 25; i++) {
    s1.fire('tools/call', { name: 'soul_run', arguments: { task: `flood pipelined ${i}` } });
  }
  await s1.kill9();

  {
    const db = openDb(soulDir);
    const runs = db.prepare(`SELECT COUNT(*) c FROM runs`).get().c;
    assert.ok(runs >= 5, `at least the 5 confirmed runs persisted (got ${runs})`);
    assertRunInvariants(db);
    assertIntegrity(db);
    db.close();
  }

  // restart: reaper boots, server fully usable, invariants still hold
  const s2 = spawnServer(soulDir);
  try {
    await handshake(s2);
    const capsule = await callJson(s2, 'soul_run', { task: 'post-flood smoke run' });
    assert.equal(capsule.status, 'running');
  } finally {
    await s2.kill9();
  }
  {
    const db = openDb(soulDir);
    assertRunInvariants(db);
    assertIntegrity(db);
    db.close();
  }
});

// ─── d) kill AFTER a soul_feedback close ──────────────────────────────

test('chaos d: SIGKILL after soul_feedback close — closed receipt persists, double feedback refused after restart', async () => {
  const soulDir = mkdtempSync(join(tmpdir(), 'soul-chaos-d-'));
  const s1 = spawnServer(soulDir);
  await handshake(s1);
  const capsule = await callJson(s1, 'soul_run', { task: 'closed then killed' });
  const fb = await callJson(s1, 'soul_feedback', {
    run_id: capsule.run_id,
    outcome: 'success',
    evidence_ref: 'node --test exit 0',
  });
  assert.equal(fb.run.closed, true);
  await s1.kill9();

  {
    const db = openDb(soulDir);
    const receipt = db.prepare(`SELECT * FROM receipts WHERE receipt_id = ?`).get(capsule.receipt_id);
    assert.equal(receipt.status, 'closed', 'the close survived the kill');
    assert.equal(receipt.honesty_class, 'self_attested', 'evidence_ref never upgrades (F02); the ref is carried in outcome JSON');
    assert.ok(receipt.closed_at);
    const episode = db.prepare(`SELECT outcome, outcome_source FROM episodes WHERE run_id = ?`).get(capsule.run_id);
    assert.equal(episode.outcome, 'success');
    assertIntegrity(db);
    db.close();
  }

  const s2 = spawnServer(soulDir);
  try {
    await handshake(s2);
    const again = await callJson(s2, 'soul_feedback', { run_id: capsule.run_id, outcome: 'failure' });
    assert.equal(again.run.closed, false, 'double feedback after restart is refused');
    assert.equal(again.run.already_closed, true);
  } finally {
    await s2.kill9();
  }
  {
    const db = openDb(soulDir);
    const episode = db.prepare(`SELECT outcome FROM episodes WHERE run_id = ?`).get(capsule.run_id);
    assert.equal(episode.outcome, 'success', 'the refused double feedback rewrote nothing');
    db.close();
  }
});

// ─── e) reaper crash safety: expire exactly ONCE ──────────────────────

test('chaos e: reaper crash safety — expired pending receipt is closed exactly once across kill/restart', async () => {
  const soulDir = mkdtempSync(join(tmpdir(), 'soul-chaos-e-'));

  // 1. produce a pending receipt (default TTL, stays pending)
  const s1 = spawnServer(soulDir);
  await handshake(s1);
  const capsule = await callJson(s1, 'soul_run', { task: 'nobody will ever confirm this' });
  await s1.kill9();

  // 2. start with TTL=0 (the receipt is now expired) and SIGKILL immediately —
  //    the constructor sweep may or may not have committed; the transaction
  //    guarantees all-or-nothing either way.
  const s2 = spawnServer(soulDir, { SOUL_RECEIPT_TTL_DAYS: '0' });
  s2.child.kill('SIGKILL');
  await once(s2.child, 'exit');

  // 3. start again with TTL=0 and let the startup sweep finish for sure
  //    (the sweep runs at server construction, before initialize is answered).
  const s3 = spawnServer(soulDir, { SOUL_RECEIPT_TTL_DAYS: '0' });
  await handshake(s3);
  await s3.kill9();

  {
    const db = openDb(soulDir);
    const receipt = db.prepare(`SELECT * FROM receipts WHERE receipt_id = ?`).get(capsule.receipt_id);
    assert.equal(receipt.status, 'closed');
    assert.equal(receipt.issued_by, 'reaper');
    assert.equal(JSON.parse(receipt.outcome).status, 'expired_unconfirmed');
    assert.equal(receipt.honesty_class, 'self_attested', 'silence never upgrades');

    // exactly ONE receipt.closed event — no double expiry across the crash
    const closeEvents = db
      .prepare(`SELECT COUNT(*) c FROM events WHERE event_type = 'receipt.closed' AND entity_id = ?`)
      .get(capsule.receipt_id).c;
    assert.equal(closeEvents, 1, 'the receipt expired exactly once (no double ledger event)');

    // exactly ONE reaper run-failure event for this run
    const reaperFails = db
      .prepare(
        `SELECT COUNT(*) c FROM events WHERE event_type = 'run.status_changed' AND entity_id = ? AND payload LIKE '%"via":"reaper"%'`
      )
      .get(capsule.run_id).c;
    assert.equal(reaperFails, 1, 'the run failed via reaper exactly once');

    const episode = db.prepare(`SELECT outcome, outcome_source FROM episodes WHERE run_id = ?`).get(capsule.run_id);
    assert.equal(episode.outcome, 'expired_unconfirmed');
    assert.equal(episode.outcome_source, 'expired_unconfirmed', 'missingness, not a verdict');

    assertIntegrity(db);
    db.close();
  }
});
