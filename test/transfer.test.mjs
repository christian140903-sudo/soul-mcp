import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { freshSoulDir } from './helpers.mjs';

freshSoulDir('transfer-source');

const { capture } = await import('../dist/src/kernel/memory.js');
const { setIdentityFacet } = await import('../dist/src/kernel/identity.js');
const { createGoal } = await import('../dist/src/kernel/goals.js');
const { exportAll, importAll, importV1Export } = await import('../dist/src/kernel/transfer.js');
const { computeAssignments, resolveAssignment } = await import('../dist/src/kernel/workbench.js');
const { makePrediction, resolvePrediction } = await import('../dist/src/kernel/cognition.js');
const { closeDb, getDb } = await import('../dist/src/kernel/db.js');

test('export -> import into empty soul is a faithful round-trip, and re-import is idempotent', () => {
  // populate source — including the detector memory and the calibration record
  const m1 = capture({ content: 'Round trip memory one about sqlite fidelity' });
  capture({ content: 'Round trip memory two about npm publishing' });
  setIdentityFacet('preferred_language', 'TypeScript', { confidence: 0.8 });
  createGoal({ title: 'Ship the passport format', kind: 'commitment', dueAt: '2031-05-05' });

  // one resolved prediction (calibration) and one still open — all v7
  // context fields non-empty so the round-trip proves every column
  const pDone = makePrediction({
    claim: 'The passport test passes', probability: 0.85,
    decisionId: 'delib_rt1', domain: 'code', clientSessionId: 'cs_rt',
  });
  resolvePrediction(pDone.id, 'true', 'agent', 'test-run evidence');
  makePrediction({ claim: 'The starter ships this week', probability: 0.6, dueAt: '2031-01-01T00:00:00.000Z' });

  // one cooldown decision (unclear) and one terminal decision (compatible)
  const a = capture({ content: 'User prefers vim keybindings in every editor', type: 'preference', sourceType: 'agent_inference' });
  const b = capture({ content: 'User prefers default keybindings in every editor', type: 'preference', sourceType: 'agent_inference' });
  assert.ok(b.conflicts.length >= 1);
  const dispute = computeAssignments().find((x) => x.kind === 'dispute' && x.memories.some((m) => m.id === a.memory.id));
  assert.ok(dispute);
  resolveAssignment(dispute.id, { verdict: 'unclear', reasoning: 'No way to tell from stored context alone.' });
  const pair2a = capture({ content: 'User works standing desk mornings routine', type: 'preference', sourceType: 'agent_inference' });
  const pair2b = capture({ content: 'User works standing desk evenings routine', type: 'preference', sourceType: 'agent_inference' });
  assert.ok(pair2b.conflicts.length >= 1);
  const d2 = computeAssignments().find((x) => x.kind === 'dispute' && x.memories.some((m) => m.id === pair2a.memory.id));
  assert.ok(d2);
  resolveAssignment(d2.id, { verdict: 'compatible', reasoning: 'Both can be true across different weeks.' });

  // v3.1: diary + client sessions travel too
  getDb().prepare("INSERT INTO session_reflections (id, session_number, summary, learnings_count, created_at) VALUES ('sref_rt', 1, 'roundtrip summary', 0, ?)").run(new Date().toISOString());
  getDb().prepare("INSERT INTO client_sessions (id, client_name, provider, model_id, started_at) VALUES ('cs_rt', 'claude-code', 'anthropic', 'claude-fable-5', ?)").run(new Date().toISOString());

  const data = exportAll();
  assert.ok(data.checksum);
  assert.ok(data.memories.length >= 2);
  assert.ok(data.events.length >= 2);
  assert.equal(data.predictions.length, 2, 'predictions travel with the passport');
  assert.equal(data.session_reflections.length, 1, 'diary travels with the passport');
  assert.ok(data.client_sessions.length >= 1, 'client sessions travel with the passport');
  assert.ok(data.workbench_decisions.length >= 2, 'decisions travel with the passport');
  const terminalDecision = data.workbench_decisions.find((d) => d.terminal === 1);
  const cooldownDecision = data.workbench_decisions.find((d) => d.terminal === 0 && d.next_review_at);
  assert.ok(terminalDecision, 'export contains a terminal decision');
  assert.ok(cooldownDecision, 'export contains a cooldown decision');

  // switch to a brand-new soul dir
  closeDb();
  process.env.SOUL_DIR = mkdtempSync(join(tmpdir(), 'soul-test-transfer-dest-'));

  const result = importAll(data);
  assert.equal(result.checksumValid, true);
  assert.equal(result.memories.imported, data.memories.length);
  assert.equal(result.identity.imported, data.identity.length);
  assert.equal(result.goals.imported, data.goals.length);
  assert.equal(result.events.imported, data.events.length);
  assert.equal(result.predictions.imported, 2);
  assert.equal(result.workbench_decisions.imported, data.workbench_decisions.length);

  // fidelity: timestamps, counters, ids survive
  const row = getDb().prepare(`SELECT * FROM memories WHERE id = ?`).get(m1.memory.id);
  assert.ok(row, 'memory id preserved');
  assert.equal(row.created_at, m1.memory.createdAt);
  assert.equal(row.access_count, m1.memory.accessCount);

  // decision field fidelity, and the detector honors imported verdicts
  const imp = getDb().prepare(`SELECT * FROM workbench_decisions WHERE id = ?`).get(terminalDecision.id);
  assert.equal(imp.outcome, terminalDecision.outcome);
  assert.equal(imp.subject_key, terminalDecision.subject_key);
  assert.equal(imp.next_review_at, terminalDecision.next_review_at);
  const reissued = computeAssignments().filter(
    (x) => x.kind === 'dispute' && x.memories.some((m) => m.id === pair2a.memory.id)
  );
  assert.equal(reissued.length, 0, 'imported terminal decision blocks re-issue in the new soul');

  // resolved prediction fidelity (calibration survives) — including v7 fields
  const pRow = getDb().prepare(`SELECT * FROM predictions WHERE id = ?`).get(pDone.id);
  assert.equal(pRow.outcome, 'true');
  assert.equal(pRow.resolution_actor, 'agent', 'v7 prediction fields survive the round-trip');
  assert.equal(pRow.decision_id, 'delib_rt1');
  assert.equal(pRow.domain, 'code');
  assert.equal(pRow.client_session_id, 'cs_rt');
  assert.equal(pRow.evidence_ref, 'test-run evidence');
  assert.equal(getDb().prepare(`SELECT summary FROM session_reflections WHERE id = 'sref_rt'`).get().summary, 'roundtrip summary');
  assert.equal(getDb().prepare(`SELECT model_id FROM client_sessions WHERE id = 'cs_rt'`).get().model_id, 'claude-fable-5');

  // idempotency: importing again changes nothing
  const again = importAll(data);
  assert.equal(again.memories.imported, 0);
  assert.equal(again.identity.imported, 0);
  assert.equal(again.goals.imported, 0);
  assert.equal(again.events.imported, 0);
  assert.equal(again.predictions.imported, 0);
  assert.equal(again.workbench_decisions.imported, 0);
  assert.equal(again.session_reflections.imported, 0);
  assert.equal(again.client_sessions.imported, 0);
});

test('a pre-3.0.1 passport (no decisions/predictions fields) still verifies its checksum', () => {
  closeDb();
  process.env.SOUL_DIR = mkdtempSync(join(tmpdir(), 'soul-test-transfer-legacy-'));
  // constructed exactly as 3.0.0 exportAll() built it: five body fields, same order
  const body = {
    memories: [],
    identity: [],
    goals: [],
    events: [],
    meta: { soul_version: '3.0.0' },
  };
  const legacy = {
    format: 'soul-passport',
    version: '2.0.0',
    exportedAt: '2026-07-13T00:00:00.000Z',
    checksum: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
    ...body,
  };
  const result = importAll(legacy);
  assert.equal(result.checksumValid, true, 'legacy checksum (without new fields) must verify');
});

test('tampered export fails the checksum and the import is refused (3.1.1)', () => {
  closeDb();
  process.env.SOUL_DIR = mkdtempSync(join(tmpdir(), 'soul-test-transfer-tamper-'));
  capture({ content: 'memory in the tamper test soul' });
  const data = exportAll();
  data.memories[0].content = 'silently edited content';
  closeDb();
  process.env.SOUL_DIR = mkdtempSync(join(tmpdir(), 'soul-test-transfer-tamper-dest-'));
  // A checksum mismatch now REFUSES the import instead of importing with a flag:
  // an import that trusts ids/provenance/status verbatim must not run on
  // unverified data.
  assert.throws(() => importAll(data), /checksum does not verify/i);
  // and nothing was written
  assert.equal(getDb().prepare(`SELECT COUNT(*) c FROM memories`).get().c, 0, 'refused import writes nothing');
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
