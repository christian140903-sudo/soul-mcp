/**
 * Golden-transcript contract tests for the three gaps flagged UNGETESTET in
 * docs/API-MATRIX.md: V10 (per-tool user-authority booking), V13 (disputed
 * memory delivered flagged inside the context capsule), V21 (soul_feedback
 * never marks unmentioned capsule memories as unhelpful).
 *
 * Everything runs over the real MCP path (spawned binary, JSON-RPC over stdio),
 * exactly like test/server.test.mjs. The ledger and per-memory columns are
 * asserted either via soul_timeline or by reading the server's own DB directly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function rpcClient() {
  const soulDir = mkdtempSync(join(tmpdir(), 'soul-test-golden-'));
  const child = spawn(process.execPath, [join(root, 'dist/src/index.js')], {
    env: { ...process.env, SOUL_DIR: soulDir },
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

/** Latest ledger actor for an (event_type, entity_id) pair, via soul_timeline. */
async function ledgerActor(c, eventType, entityId) {
  const tl = await callJson(c, 'soul_timeline', { event_type: eventType });
  const matches = tl.events.filter((e) => e.entityId === entityId);
  return matches.length ? matches[matches.length - 1].actor : undefined;
}

// ---------------------------------------------------------------------------
// V10 — per-tool user-authority booking across all six authority tools.
// remember is covered by provenance-guards.test.mjs; here are the other five,
// each MIT user_evidence (actor 'user') and OHNE (action applies, actor 'agent').
// ---------------------------------------------------------------------------

test('V10 soul_confirm: user_evidence books the user, its absence honestly books the agent', async () => {
  const c = rpcClient();
  try {
    await handshake(c);
    const withEv = await callJson(c, 'soul_remember', { content: 'User leans toward tabs over spaces for indentation' });
    const p1 = await callJson(c, 'soul_confirm', { id: withEv.id, user_evidence: 'User: "ja, Tabs stimmt"' });
    assert.equal(p1.confirmed, true);
    assert.equal(p1.booked_as, 'user');
    assert.equal(await ledgerActor(c, 'memory.confirmed', withEv.id), 'user');

    const noEv = await callJson(c, 'soul_remember', { content: 'User seems to favor pnpm as the package manager' });
    const p2 = await callJson(c, 'soul_confirm', { id: noEv.id });
    assert.equal(p2.confirmed, true, 'confirmation still applies without evidence');
    assert.equal(p2.booked_as, 'agent');
    assert.equal(await ledgerActor(c, 'memory.confirmed', noEv.id), 'agent');
  } finally {
    c.child.kill();
  }
});

test('V10 soul_correct: user_evidence yields user_statement + user actor; without it agent inference', async () => {
  const c = rpcClient();
  try {
    await handshake(c);
    const base = await callJson(c, 'soul_remember', {
      content: 'User confirmed the deploy target is fly.io',
      source_type: 'user_statement',
      source_ref: 'chat "wir deployen auf fly"',
    });

    const evidenced = await callJson(c, 'soul_correct', {
      id: base.id,
      content: 'User corrected: the deploy target is actually Railway',
      user_evidence: 'User: "nein, Railway"',
    });
    assert.equal(evidenced.source_type, 'user_statement');
    assert.equal(evidenced.supersedes, base.id);
    assert.equal(await ledgerActor(c, 'memory.corrected', evidenced.new_id), 'user');

    const bare = await callJson(c, 'soul_correct', {
      id: evidenced.new_id,
      content: 'Deploy target might be Render instead',
    });
    assert.equal(bare.source_type, 'agent_inference', 'no evidence -> agent inference');
    assert.ok(bare.message.includes('provenance'), 'downgrade is stated, not silent');
    assert.equal(await ledgerActor(c, 'memory.corrected', bare.new_id), 'agent');
  } finally {
    c.child.kill();
  }
});

test('V10 soul_forget: user_evidence books the deletion as the user, its absence as the agent', async () => {
  const c = rpcClient();
  try {
    await handshake(c);
    const withEv = await callJson(c, 'soul_remember', { content: 'User old office desk location note' });
    const f1 = await callJson(c, 'soul_forget', { id: withEv.id, user_evidence: 'User: "das kannst du vergessen"' });
    assert.equal(f1.forgotten, true);
    assert.equal(f1.booked_as, 'user');
    assert.equal(await ledgerActor(c, 'memory.deleted', withEv.id), 'user');

    const noEv = await callJson(c, 'soul_remember', { content: 'A transient scratch note about a build flag' });
    const f2 = await callJson(c, 'soul_forget', { id: noEv.id });
    assert.equal(f2.forgotten, true, 'forget still applies without evidence');
    assert.equal(f2.booked_as, 'agent');
    assert.equal(await ledgerActor(c, 'memory.deleted', noEv.id), 'agent');
  } finally {
    c.child.kill();
  }
});

test('V10 soul_identity: confirmed=true needs user_evidence to reach confirmed status + user actor', async () => {
  const c = rpcClient();
  try {
    await handshake(c);
    // The identity ledger keys events by `${namespace}:${aspect}`, not a row id.
    const facetEntity = (f) => `${f.namespace}:${f.aspect}`;

    const evidenced = await callJson(c, 'soul_identity', {
      aspect: 'timezone', value: 'Europe/Vienna', confirmed: true, user_evidence: 'User: "ich bin in Wien"',
    });
    assert.equal(evidenced.identity.status, 'confirmed');
    assert.equal(await ledgerActor(c, 'identity.updated', facetEntity(evidenced.identity)), 'user');

    const bare = await callJson(c, 'soul_identity', {
      aspect: 'editor', value: 'neovim', confirmed: true,
    });
    assert.equal(bare.identity.status, 'observed', 'unevidenced confirmed=true is downgraded, facet still set');
    assert.ok(bare.message.includes('provenance'));
    assert.equal(await ledgerActor(c, 'identity.updated', facetEntity(bare.identity)), 'agent');
  } finally {
    c.child.kill();
  }
});

test('V10 soul_goal: create MIT user_evidence books the user, OHNE it the agent', async () => {
  const c = rpcClient();
  try {
    await handshake(c);
    const withEv = await callJson(c, 'soul_goal', {
      action: 'create', title: 'Pass the SBP maths exam in October', user_evidence: 'User: "Mathe im Oktober ist fix"',
    });
    assert.equal(withEv.booked_as, 'user');
    assert.equal(await ledgerActor(c, 'goal.created', withEv.created.id), 'user');

    const noEv = await callJson(c, 'soul_goal', { action: 'create', title: 'Refactor the retrieval scoring layer' });
    assert.equal(noEv.booked_as, 'agent', 'agent-initiated goal is booked honestly');
    assert.equal(await ledgerActor(c, 'goal.created', noEv.created.id), 'agent');
  } finally {
    c.child.kill();
  }
});

// ---------------------------------------------------------------------------
// V13 — a disputed memory is delivered into the context capsule flagged
// disputed:true, and the conflict is listed in known_conflicts with both sides.
// Two contradicting preference memories with high word overlap trigger the
// word-overlap conflict heuristic deterministically (detectConflicts).
// ---------------------------------------------------------------------------

test('V13 a disputed memory reaches the context capsule flagged, with both sides in known_conflicts', async () => {
  const c = rpcClient();
  try {
    await handshake(c);

    // Two preference memories that share most significant words but differ ->
    // both marked disputed and linked (word-overlap heuristic, jaccard >= 0.4).
    const a = await callJson(c, 'soul_remember', {
      content: 'User prefers dark mode editor themes for long coding sessions',
      category: 'preference',
    });
    const b = await callJson(c, 'soul_remember', {
      content: 'User prefers light mode editor themes for long coding sessions',
      category: 'preference',
    });
    assert.ok(
      b.message.includes('contradict') || b.outcome === 'stored',
      'second contradicting preference is stored and flagged as a potential conflict'
    );

    // Confirm the dispute was linked in the DB before we compile the capsule.
    const { default: Database } = await import('better-sqlite3');
    const dbCheck = new Database(join(c.soulDir, 'memories.db'), { readonly: true });
    const statusA = dbCheck.prepare('SELECT status FROM memories WHERE id = ?').get(a.id);
    const statusB = dbCheck.prepare('SELECT status FROM memories WHERE id = ?').get(b.id);
    dbCheck.close();
    assert.equal(statusA.status, 'disputed', 'first memory turned disputed');
    assert.equal(statusB.status, 'disputed', 'second memory turned disputed');

    // Compile a capsule whose task matches the disputed memories so recall
    // surfaces at least one of them (which pulls the pair into known_conflicts).
    const capsule = await callJson(c, 'soul_context', {
      task: 'editor themes preference for coding sessions',
      token_budget: 4000,
    });

    const delivered = capsule.relevant_memories.filter((m) => m.id === a.id || m.id === b.id);
    assert.ok(delivered.length >= 1, 'at least one side of the dispute is delivered in the capsule');
    for (const m of delivered) {
      assert.equal(m.disputed, true, 'delivered disputed memory is flagged disputed:true, not presented as fact');
    }

    const pair = capsule.known_conflicts.find(
      (k) => (k.a === a.id && k.b === b.id) || (k.a === b.id && k.b === a.id)
    );
    assert.ok(pair, 'the conflict appears in known_conflicts with both sides');
    assert.ok(pair.note && /do not treat either as fact/i.test(pair.note), 'the conflict note warns against treating either as fact');
  } finally {
    c.child.kill();
  }
});

// ---------------------------------------------------------------------------
// V21 — soul_feedback with only used_ids=[first] must not touch the other
// delivered capsule memories: no unhelpful signal, no importance malus, no
// useful_count bump. Only the named one flips to signal 'used'.
// ---------------------------------------------------------------------------

test('V21 soul_feedback marks only the named memory used; unmentioned capsule memories stay untouched', async () => {
  const c = rpcClient();
  try {
    await handshake(c);

    // Seed a few clearly-recallable memories on one topic so the capsule
    // delivers several of them together.
    const seeds = [
      'The retrieval scoring layer uses BM25 over the FTS index',
      'The retrieval scoring layer also blends a recency decay term',
      'The retrieval scoring layer breaks ties by importance then id',
    ];
    const ids = [];
    for (const content of seeds) {
      const r = await callJson(c, 'soul_remember', { content });
      ids.push(r.id);
    }

    const capsule = await callJson(c, 'soul_context', {
      task: 'retrieval scoring layer',
      token_budget: 4000,
    });
    const deliveredIds = capsule.relevant_memories.map((m) => m.id).filter((id) => ids.includes(id));
    assert.ok(deliveredIds.length >= 2, 'the capsule delivers at least two of the seeded memories');

    const usedId = deliveredIds[0];
    const untouchedIds = deliveredIds.slice(1);

    const fb = await callJson(c, 'soul_feedback', {
      context_id: capsule.context_id,
      used_ids: [usedId],
    });
    assert.equal(fb.used, 1, 'exactly the named memory is booked used');
    assert.equal(fb.unhelpful, 0, 'no memory is booked unhelpful');

    // Read the persisted signals and per-memory counters directly.
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(join(c.soulDir, 'memories.db'), { readonly: true });
    const sigOf = (memId) =>
      db.prepare('SELECT signal FROM retrieval_impressions WHERE context_id = ? AND memory_id = ?')
        .get(capsule.context_id, memId)?.signal;
    const memOf = (memId) =>
      db.prepare('SELECT useful_count, importance FROM memories WHERE id = ?').get(memId);

    assert.equal(sigOf(usedId), 'used', 'the named memory transitioned to used');
    assert.equal(memOf(usedId).useful_count, 1, 'the named memory got its useful_count bump');

    for (const other of untouchedIds) {
      assert.equal(sigOf(other), 'included', `unmentioned memory ${other} stays 'included' (unknown, NOT unhelpful)`);
      const row = memOf(other);
      assert.equal(row.useful_count, 0, 'unmentioned memory keeps useful_count 0');
      assert.equal(row.importance, 0.5, 'unmentioned memory keeps its default importance (no unhelpful malus)');
    }
    db.close();
  } finally {
    c.child.kill();
  }
});

// TB3 availability guard (threat model F14): oversized import refused before parse
test('soul_import refuses an oversized payload before parsing (fail-closed, reason too_large)', async () => {
  const soulDir = mkdtempSync(join(tmpdir(), 'soul-test-doslimit-'));
  const child = spawn(process.execPath, [join(root, 'dist/src/index.js')], {
    env: { ...process.env, SOUL_DIR: soulDir, SOUL_MAX_IMPORT_BYTES: '1000' },
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
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout ${method}`)); } }, 10000);
    });
  try {
    await request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'soul-test', version: '0.0.0' },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
    const big = JSON.stringify({ format: 'soul-passport', pad: 'x'.repeat(5000) });
    const res = await request('tools/call', { name: 'soul_import', arguments: { data: big } });
    const payload = JSON.parse(res.result.content[0].text);
    assert.equal(payload.success, false);
    assert.equal(payload.reason, 'too_large');
    // nothing was written: a fresh export is empty
    const exp = await request('tools/call', { name: 'soul_export', arguments: {} });
    const passport = JSON.parse(exp.result.content[0].text);
    assert.equal((passport.memories ?? []).length, 0);
  } finally {
    child.kill();
  }
});
