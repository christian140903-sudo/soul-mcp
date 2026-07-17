/**
 * End-to-end MCP smoke test: spawn the real binary exactly like an MCP client
 * does (piped stdio, no args) and speak JSON-RPC to it. This is the test that
 * would have caught the v1 packaging bug.
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
  const soulDir = mkdtempSync(join(tmpdir(), 'soul-test-server-'));
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
      const msg = JSON.parse(line); // any non-JSON on stdout must fail the test
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

test('the default binary invocation serves MCP: initialize, list tools, call a tool', async () => {
  const { child, request, notify } = rpcClient();
  try {
    const init = await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'soul-test', version: '0.0.0' },
    });
    assert.equal(init.result.serverInfo.name, 'soul');
    assert.match(init.result.serverInfo.version, /^4\./);
    assert.ok(
      typeof init.result.instructions === 'string' && init.result.instructions.includes('soul_context'),
      'server serves its session protocol via the instructions field'
    );
    notify('notifications/initialized');

    const tools = await request('tools/list');
    const names = tools.result.tools.map((t) => t.name);
    for (const expected of ['soul_remember', 'soul_recall', 'soul_context', 'soul_confirm', 'soul_correct', 'soul_timeline', 'soul_review_queue', 'soul_export', 'soul_import']) {
      assert.ok(names.includes(expected), `missing tool ${expected}`);
    }

    const resources = await request('resources/list');
    const uris = resources.result.resources.map((r) => r.uri);
    assert.ok(uris.includes('soul://status'));
    assert.ok(uris.includes('soul://constitution'));

    const prompts = await request('prompts/list');
    assert.ok(prompts.result.prompts.some((p) => p.name === 'soul-daily-review'));

    const remember = await request('tools/call', {
      name: 'soul_remember',
      arguments: { content: 'End-to-end test memory about the MCP handshake' },
    });
    const payload = JSON.parse(remember.result.content[0].text);
    assert.equal(payload.outcome, 'stored');

    const recallResult = await request('tools/call', {
      name: 'soul_recall',
      arguments: { query: 'MCP handshake' },
    });
    const recallPayload = JSON.parse(recallResult.result.content[0].text);
    assert.ok(recallPayload.found >= 1);
  } finally {
    child.kill();
  }
});

test('provenance guard: tool writes default to agent_inference; user_statement needs evidence; confirm is booked honestly', async () => {
  const { child, request, notify } = rpcClient();
  try {
    await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'soul-test', version: '0.0.0' },
    });
    notify('notifications/initialized');

    // 1. no source_type -> agent_inference, not user_statement
    const bare = await request('tools/call', {
      name: 'soul_remember',
      arguments: { content: 'The starter cockpit will show backup age going forward' },
    });
    const barePayload = JSON.parse(bare.result.content[0].text);
    assert.equal(barePayload.source_type, 'agent_inference', 'tool-call default must be agent_inference');

    // 2. user_statement without source_ref -> downgraded, and the response says so
    const claimed = await request('tools/call', {
      name: 'soul_remember',
      arguments: { content: 'User said they moved the vault to a new disk', source_type: 'user_statement' },
    });
    const claimedPayload = JSON.parse(claimed.result.content[0].text);
    assert.equal(claimedPayload.source_type, 'agent_inference', 'unevidenced user_statement must be downgraded');
    assert.ok(claimedPayload.message.includes('provenance'), 'downgrade must be stated, not silent');

    // 3. user_statement with source_ref -> accepted
    const evidenced = await request('tools/call', {
      name: 'soul_remember',
      arguments: {
        content: 'User confirmed the Soul DB lives at ~/.soul/memories.db',
        source_type: 'user_statement',
        source_ref: 'chat:2026-07-14 "ja, die DB liegt unter ~/.soul"',
      },
    });
    const evidencedPayload = JSON.parse(evidenced.result.content[0].text);
    assert.equal(evidencedPayload.source_type, 'user_statement');

    // 4. confirm without user_evidence applies, but the ledger books the agent
    const confirmBare = await request('tools/call', {
      name: 'soul_confirm',
      arguments: { id: barePayload.id },
    });
    const confirmBarePayload = JSON.parse(confirmBare.result.content[0].text);
    assert.equal(confirmBarePayload.confirmed, true);
    assert.equal(confirmBarePayload.booked_as, 'agent');

    // 5. confirm with user_evidence is booked as the user
    const confirmUser = await request('tools/call', {
      name: 'soul_confirm',
      arguments: { id: evidencedPayload.id, user_evidence: 'User: "stimmt, bestätige ich"' },
    });
    const confirmUserPayload = JSON.parse(confirmUser.result.content[0].text);
    assert.equal(confirmUserPayload.booked_as, 'user');

    // 6. the ledger actors match what was booked
    const timeline = await request('tools/call', {
      name: 'soul_timeline',
      arguments: { event_type: 'memory.confirmed' },
    });
    const events = JSON.parse(timeline.result.content[0].text).events;
    const actors = new Map(events.map((e) => [e.entityId, e.actor]));
    assert.equal(actors.get(barePayload.id), 'agent');
    assert.equal(actors.get(evidencedPayload.id), 'user');

    // 7. the review flow still works on a REAL candidate: sensitive content is
    //    held, and confirming upgrades it (booked honestly either way)
    const candidate = await request('tools/call', {
      name: 'soul_remember',
      arguments: { content: 'User monthly budget for tools is 150 euro', category: 'financial' },
    });
    const candidatePayload = JSON.parse(candidate.result.content[0].text);
    assert.equal(candidatePayload.status, 'candidate', 'financial content is held as candidate');
    const confirmCandidate = await request('tools/call', {
      name: 'soul_confirm',
      arguments: { id: candidatePayload.id },
    });
    const confirmCandidatePayload = JSON.parse(confirmCandidate.result.content[0].text);
    assert.equal(confirmCandidatePayload.confirmed, true);
    assert.equal(confirmCandidatePayload.status, 'confirmed', 'candidate upgraded despite agent booking');
    assert.equal(confirmCandidatePayload.booked_as, 'agent');

    // 8. identity: confirmed=true without user_evidence is downgraded and says so
    const facet = await request('tools/call', {
      name: 'soul_identity',
      arguments: { aspect: 'favorite_shell', value: 'zsh', confirmed: true },
    });
    const facetPayload = JSON.parse(facet.result.content[0].text);
    assert.equal(facetPayload.identity.status, 'observed', 'unevidenced confirmation downgraded');
    assert.ok(facetPayload.message.includes('provenance'));
    const facetEvidenced = await request('tools/call', {
      name: 'soul_identity',
      arguments: { aspect: 'favorite_shell', value: 'zsh', confirmed: true, user_evidence: 'User: "ich nutze zsh"' },
    });
    assert.equal(JSON.parse(facetEvidenced.result.content[0].text).identity.status, 'confirmed');

    // 9. correct: without user_evidence the new memory is the agent's inference
    const correction = await request('tools/call', {
      name: 'soul_correct',
      arguments: { id: evidencedPayload.id, content: 'User confirmed the Soul DB lives at ~/.soul/memories.db (WAL mode)' },
    });
    const correctionPayload = JSON.parse(correction.result.content[0].text);
    assert.equal(correctionPayload.source_type, 'agent_inference');
    assert.ok(correctionPayload.message.includes('provenance'));
  } finally {
    child.kill();
  }
});

test('evidence_ref flows through the public MCP path: predict -> workbench -> resolve', async () => {
  const { child, request, notify, soulDir } = rpcClient();
  try {
    await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'soul-test', version: '0.0.0' },
    });
    notify('notifications/initialized');

    const made = await request('tools/call', {
      name: 'soul_predict',
      arguments: { claim: 'The MCP evidence path works', probability: 0.9, due_at: '2026-01-01T00:00:00.000Z', domain: 'code' },
    });
    const predId = JSON.parse(made.result.content[0].text).id;

    const wb = await request('tools/call', { name: 'soul_workbench', arguments: {} });
    const assignments = JSON.parse(wb.result.content[0].text).assignments;
    const due = assignments.find((a) => a.kind === 'prediction_due' && a.prediction?.id === predId);
    assert.ok(due, 'due prediction surfaced through the workbench');

    const resolved = await request('tools/call', {
      name: 'soul_resolve',
      arguments: {
        assignment_id: due.id,
        resolution: { outcome: 'true', evidence_ref: 'test/server.test.mjs run', reasoning: 'The test itself demonstrates the path end to end.' },
      },
    });
    assert.equal(JSON.parse(resolved.result.content[0].text).applied, true);

    // verify the persisted column directly in the server's database
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(join(soulDir, 'memories.db'), { readonly: true });
    const row = db.prepare('SELECT evidence_ref, resolution_actor, domain FROM predictions WHERE id = ?').get(predId);
    db.close();
    assert.equal(row.evidence_ref, 'test/server.test.mjs run');
    assert.equal(row.resolution_actor, 'agent');
    assert.equal(row.domain, 'code');
  } finally {
    child.kill();
  }
});

test('soul_reflect summary reaches the timeline as session.reflected and survives an export/import roundtrip', async () => {
  const source = rpcClient();
  let passport;
  const summary = 'Closed the 3.2.0 audit round: import screening, fail-closed checksum, forget clears FTS.';
  try {
    await source.request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'soul-test', version: '0.0.0' },
    });
    source.notify('notifications/initialized');

    // soul_reflect(summary) writes the diary entry + the session.reflected event
    const reflect = await source.request('tools/call', {
      name: 'soul_reflect',
      arguments: { summary, learnings: ['Fail-closed beats fail-open for untrusted imports.'] },
    });
    assert.equal(JSON.parse(reflect.result.content[0].text).summary_stored, true);

    // soul_timeline shows the event with the same summary payload
    const timeline = await source.request('tools/call', {
      name: 'soul_timeline', arguments: { event_type: 'session.reflected' },
    });
    const events = JSON.parse(timeline.result.content[0].text).events;
    assert.equal(events.length, 1, 'exactly one session.reflected event');
    const reflected = events[0];
    assert.equal(reflected.eventType, 'session.reflected');
    assert.equal(reflected.payload.summary, summary, 'timeline carries the same summary payload');
    const reflectionId = reflected.entityId; // the session_reflections id

    // export the whole soul
    const exported = await source.request('tools/call', { name: 'soul_export', arguments: {} });
    passport = exported.result.content[0].text;

    // sanity: the diary entry is in the passport under its id
    const parsed = JSON.parse(passport);
    assert.ok(parsed.session_reflections.some((r) => r.id === reflectionId && r.summary === summary),
      'reflection travels in the passport with its id');
  } finally {
    source.child.kill();
  }

  // import into a brand-new soul and confirm the reflection id is preserved
  const dest = rpcClient();
  try {
    await dest.request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'soul-test', version: '0.0.0' },
    });
    dest.notify('notifications/initialized');

    const imported = await dest.request('tools/call', { name: 'soul_import', arguments: { data: passport } });
    const importPayload = JSON.parse(imported.result.content[0].text);
    assert.equal(importPayload.success, true, 'valid passport imports');
    assert.ok(importPayload.session_reflections.imported >= 1, 'the reflection is imported');

    // the same session.reflected event, same summary, same reflection id is on the new timeline
    const timeline2 = await dest.request('tools/call', {
      name: 'soul_timeline', arguments: { event_type: 'session.reflected' },
    });
    const events2 = JSON.parse(timeline2.result.content[0].text).events;
    const match = events2.find((e) => e.payload.summary === summary);
    assert.ok(match, 'reflected event survived the roundtrip');

    // and the diary row itself is there, keyed by the original id
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(join(dest.soulDir, 'memories.db'), { readonly: true });
    const row = db.prepare('SELECT id, summary FROM session_reflections WHERE summary = ?').get(summary);
    db.close();
    assert.ok(row, 'reflection row present after import');
    assert.equal(row.id, match.entityId, 'reflection id preserved across the roundtrip');
  } finally {
    dest.child.kill();
  }
});

test('CLI mode still works when run with a command argument', async () => {
  const child = spawn(process.execPath, [join(root, 'dist/src/index.js'), 'status'], {
    env: { ...process.env, SOUL_DIR: mkdtempSync(join(tmpdir(), 'soul-test-cli-')) },
  });
  let out = '';
  child.stdout.on('data', (c) => (out += c.toString()));
  await new Promise((resolve) => child.on('exit', resolve));
  assert.ok(out.includes('not initialized'), `unexpected output: ${out}`);
});
