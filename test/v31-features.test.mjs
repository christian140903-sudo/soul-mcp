import test from 'node:test';
import assert from 'node:assert/strict';
import { freshSoulDir } from './helpers.mjs';

freshSoulDir('v31-features');

const { capture, getMemoryById, applyMemoryFeedback, confirmMemory } = await import('../dist/src/kernel/memory.js');
const { computeAssignments, resolveAssignment } = await import('../dist/src/kernel/workbench.js');
const { compileContext, getCurrentClientSessionId, endClientSession, _resetClientSessionForTests } = await import('../dist/src/kernel/context.js');
const { makePrediction, getPrediction, deliberate, commitDeliberation, getCalibration, resolvePrediction } = await import('../dist/src/kernel/cognition.js');
const { getStats } = await import('../dist/src/kernel/stats.js');
const { queryEvents } = await import('../dist/src/kernel/ledger.js');
const { getDb, closeDb } = await import('../dist/src/kernel/db.js');

test('volatile facts get a review window; the stale_fact assignment verifies or expires them', () => {
  const m = capture({
    content: 'The EU has 21 euro members as of 2026-01-01',
    sourceType: 'document',
    volatility: 'volatile',
    verificationRef: 'https://europa.eu (2026-01)',
  });
  assert.ok(m.memory.reviewDueAt, 'volatile fact carries a review window');

  // age it past the window
  getDb().prepare(`UPDATE memories SET review_due_at = '2026-01-01T00:00:00.000Z' WHERE id = ?`).run(m.memory.id);

  const assignment = computeAssignments().find((a) => a.kind === 'stale_fact' && a.memories.some((x) => x.id === m.memory.id));
  assert.ok(assignment, 'stale_fact assignment issued when the window elapses');

  const verified = resolveAssignment(assignment.id, {
    action: 'still_valid',
    evidence_ref: 'https://europa.eu (rechecked)',
    reasoning: 'Membership unchanged as of the recheck.',
  });
  assert.equal(verified.outcome, 'verified');
  const after = getMemoryById(m.memory.id);
  assert.ok(after.reviewDueAt > new Date().toISOString(), 'review window renewed');
  assert.ok(after.lastVerifiedAt, 'verification timestamp set');
  // renewed window -> no immediate re-issue
  const again = computeAssignments().find((a) => a.kind === 'stale_fact' && a.memories.some((x) => x.id === m.memory.id));
  assert.equal(again, undefined);

  // outdated path: another stale fact, agent-sourced, gets expired honestly
  const m2 = capture({ content: 'The starter has eight desktop variants', sourceType: 'agent_inference', volatility: 'volatile' });
  getDb().prepare(`UPDATE memories SET review_due_at = '2026-01-01T00:00:00.000Z' WHERE id = ?`).run(m2.memory.id);
  const a2 = computeAssignments().find((a) => a.kind === 'stale_fact' && a.memories.some((x) => x.id === m2.memory.id));
  assert.ok(a2);
  const expired = resolveAssignment(a2.id, { action: 'outdated', reasoning: 'Starter v4 consolidated them to one.' });
  assert.equal(expired.outcome, 'expired');
  assert.equal(getMemoryById(m2.memory.id).status, 'expired');
});

test('gate-fixes: still_valid needs evidence; user statements cannot be model-verified; confirm renews freshness', () => {
  // F3: still_valid without evidence is rejected, assignment stays open
  const m = capture({ content: 'Vienna transit yearly pass costs 365 euro', sourceType: 'document', volatility: 'volatile' });
  getDb().prepare(`UPDATE memories SET review_due_at = '2026-01-01T00:00:00.000Z' WHERE id = ?`).run(m.memory.id);
  const a = computeAssignments().find((x) => x.kind === 'stale_fact' && x.memories.some((y) => y.id === m.memory.id));
  assert.ok(a);
  const noEvidence = resolveAssignment(a.id, { action: 'still_valid', evidence_ref: '   ', reasoning: 'Looks fine to me overall.' });
  assert.equal(noEvidence.outcome, 'invalid_resolution', 'whitespace evidence rejected');
  // assignment must still be open (guard-rejected resolutions never close)
  assert.equal(
    getDb().prepare(`SELECT status FROM workbench_assignments WHERE id = ?`).get(a.id).status,
    'open',
    'assignment still open after rejected verification'
  );
  // with real evidence the same assignment resolves
  const withEvidence = resolveAssignment(a.id, { action: 'still_valid', evidence_ref: 'https://wienerlinien.at (2026-07)', reasoning: 'Price confirmed on the official page.' });
  assert.equal(withEvidence.outcome, 'verified');

  // F2: a model can never self-verify a USER statement, not even via still_valid
  const us = capture({
    content: 'User says the gym membership runs until December',
    sourceType: 'user_statement', source_ref: 'chat', volatility: 'volatile',
  });
  getDb().prepare(`UPDATE memories SET review_due_at = '2026-01-01T00:00:00.000Z' WHERE id = ?`).run(us.memory.id);
  const ua = computeAssignments().find((x) => x.kind === 'stale_fact' && x.memories.some((y) => y.id === us.memory.id));
  assert.ok(ua);
  const selfVerify = resolveAssignment(ua.id, { action: 'still_valid', evidence_ref: 'https://gym.example', reasoning: 'Website says memberships run yearly.' });
  assert.equal(selfVerify.outcome, 'needs_user', 'user statement must go to the user, whatever the action');

  // F4: the user CAN close the loop — confirm with evidence renews the window
  // and re-arms the detector for the next expiry
  confirmMemory(us.memory.id, { userEvidence: 'User: "ja, läuft bis Dezember"' });
  const after = getMemoryById(us.memory.id);
  assert.ok(after.reviewDueAt > new Date().toISOString(), 'freshness window renewed by user confirmation');
  assert.ok(after.lastVerifiedAt, 'verification recorded');
  const decision = getDb()
    .prepare(`SELECT invalidated_at FROM workbench_decisions WHERE kind='stale_fact' AND subject_key = ? ORDER BY created_at DESC LIMIT 1`)
    .get(us.memory.id);
  assert.ok(decision.invalidated_at, 'needs_user decision invalidated — the fact can return when stale again');
});

test('gate-fix F1: feedback only counts capsule-delivered memories, exactly once', async () => {
  const inCapsule = capture({ content: 'Feedback fairness memory about golang concurrency', sourceType: 'agent_inference' });
  const outsider = capture({ content: 'Completely unrelated cooking recipe for goulash soup', sourceType: 'agent_inference' });
  const capsule = await compileContext('golang concurrency fairness', { tokenBudget: 4000, modelHint: 'claude-fable-5' });
  assert.ok(capsule.relevant_memories.some((x) => x.id === inCapsule.memory.id), 'target memory delivered');

  const outsiderBefore = getMemoryById(outsider.memory.id);
  const r1 = applyMemoryFeedback(capsule.context_id, [inCapsule.memory.id, outsider.memory.id], []);
  assert.equal(r1.used, 1, 'only the delivered memory counts');
  assert.ok(r1.ignored >= 1, 'undelivered id reported as ignored');
  const outsiderAfter = getMemoryById(outsider.memory.id);
  assert.equal(outsiderAfter.usefulCount, outsiderBefore.usefulCount, 'outsider counters untouched');

  // idempotency: repeating the same feedback changes nothing
  const r2 = applyMemoryFeedback(capsule.context_id, [inCapsule.memory.id], [inCapsule.memory.id]);
  assert.equal(r2.used, 0);
  assert.equal(r2.unhelpful, 0, 'already-rated memory cannot flip or double-count');
});

test('a stale user statement needs the user, never silent expiry', () => {
  const m = capture({
    content: 'User says the SBP English exam is on October 3rd',
    sourceType: 'user_statement',
    source_ref: 'chat',
    volatility: 'volatile',
  });
  getDb().prepare(`UPDATE memories SET review_due_at = '2026-01-01T00:00:00.000Z' WHERE id = ?`).run(m.memory.id);
  const a = computeAssignments().find((x) => x.kind === 'stale_fact' && x.memories.some((y) => y.id === m.memory.id));
  assert.ok(a);
  const r = resolveAssignment(a.id, { action: 'outdated', reasoning: 'The date on the website differs now.' });
  assert.equal(r.outcome, 'needs_user');
  assert.equal(getMemoryById(m.memory.id).status, 'active', 'user statement untouched');
});

test('the capsule carries a context_id, marks stale facts, and the feedback loop closes', async () => {
  const used = capture({ content: 'Soul feedback loop test memory about typescript ranking', sourceType: 'agent_inference' });
  const noise = capture({ content: 'Soul feedback loop test memory about typescript noise', sourceType: 'agent_inference' });

  const capsule = await compileContext('typescript ranking feedback test', { tokenBudget: 4000, modelHint: 'claude-fable-5' });
  assert.ok(capsule.context_id?.startsWith('ctx_'), 'capsule carries a context_id');

  const impressions = getDb()
    .prepare(`SELECT memory_id, rank, signal FROM retrieval_impressions WHERE context_id = ?`)
    .all(capsule.context_id);
  assert.ok(impressions.length >= 1, 'impressions recorded for delivered memories');
  assert.ok(impressions.every((i) => i.signal === 'included'));

  const before = getMemoryById(used.memory.id).usefulCount;
  const result = applyMemoryFeedback(capsule.context_id, [used.memory.id], [noise.memory.id]);
  assert.equal(result.used, 1);
  assert.equal(result.unhelpful, 1);
  assert.equal(getMemoryById(used.memory.id).usefulCount, before + 1, 'usage counter fed');
  const signals = new Map(
    getDb()
      .prepare(`SELECT memory_id, signal FROM retrieval_impressions WHERE context_id = ?`)
      .all(capsule.context_id)
      .map((r) => [r.memory_id, r.signal])
  );
  assert.equal(signals.get(used.memory.id), 'used');
  assert.equal(signals.get(noise.memory.id), 'unhelpful');
});

test('client session starts on first capsule and carries the model id; predictions reference it', async () => {
  const sessionId = getCurrentClientSessionId();
  assert.ok(sessionId, 'client session started by capsule compile');
  const row = getDb().prepare(`SELECT * FROM client_sessions WHERE id = ?`).get(sessionId);
  assert.equal(row.model_id, 'claude-fable-5');
  assert.equal(row.provider, 'anthropic');
  assert.equal(row.model_profile, 'deep');

  const p = makePrediction({
    claim: 'The v31 feature test passes',
    probability: 0.9,
    domain: 'code',
    clientSessionId: sessionId,
  });
  const stored = getPrediction(p.id);
  assert.equal(stored.domain, 'code');
  assert.equal(stored.clientSessionId, sessionId);
  resolvePrediction(p.id, 'true', 'agent', 'test run itself');
  assert.equal(getPrediction(p.id).resolutionActor, 'agent');
  assert.equal(getPrediction(p.id).evidenceRef, 'test run itself');

  endClientSession();
  assert.equal(getCurrentClientSessionId(), null);
  assert.ok(getDb().prepare(`SELECT ended_at FROM client_sessions WHERE id = ?`).get(sessionId).ended_at);
  _resetClientSessionForTests();
});

test('calibration note is honest below n=5 (provisional), deliberations close via commit', async () => {
  const note = getCalibration().note;
  assert.ok(note.includes('provisional') || note.includes('Calibration over'), `unexpected note: ${note}`);

  const d = await deliberate('Should the starter keep the 6s autostart?', 'decision');
  assert.ok(d.deliberation_id?.startsWith('delib_'));

  const committed = commitDeliberation({
    deliberationId: d.deliberation_id,
    verdict: 'Keep autostart, but only into the non-bypass standard mode.',
    confidence: 0.8,
    assumptions: ['Chriso wants double-click-and-go'],
  });
  assert.equal(committed.committed, true);
  const events = queryEvents({ eventType: 'deliberation.committed', entityId: d.deliberation_id });
  assert.equal(events.length, 1);
  // double commit is rejected
  assert.equal(commitDeliberation({ deliberationId: d.deliberation_id, verdict: 'x', confidence: 0.5 }).committed, false);
});

test('freshness_due counts a fact that became due earlier today (same-day ISO edge case)', () => {
  const m = capture({ content: 'Same-day freshness edge case fact', sourceType: 'document', volatility: 'volatile' });
  const before = getStats().integrity.freshness_due;
  const oneMinuteAgo = new Date(Date.now() - 60_000).toISOString(); // ISO with T/Z, TODAY
  getDb().prepare(`UPDATE memories SET review_due_at = ? WHERE id = ?`).run(oneMinuteAgo, m.memory.id);
  assert.equal(getStats().integrity.freshness_due, before + 1, 'same-day due fact must be counted');
});

test('session summaries land in session_reflections and the split metrics exist', () => {
  getDb()
    .prepare(
      `INSERT INTO session_reflections (id, session_number, summary, learnings_count, created_at)
       VALUES ('sref_test', 1, 'Test session summary', 0, ?)`
    )
    .run(new Date().toISOString());
  const stats = getStats();
  assert.ok(stats.integrity.reflection_count >= 1);
  assert.ok('user_statement_confirmation_rate' in stats.integrity);
  assert.ok('inference_review_rate' in stats.integrity);
  assert.ok('high_trust_share' in stats.integrity);
  assert.ok('freshness_due' in stats.integrity);
});

test('deliberation double-commit is process-safe: two concurrent processes, exactly one commit', async () => {
  const { spawn } = await import('child_process');
  const d = await deliberate('Two-process commit race check', 'check');
  closeDb(); // release our handle so the children own the file

  const childScript = `
    const { commitDeliberation } = await import(process.argv[1]);
    const r = commitDeliberation({ deliberationId: process.argv[2], verdict: 'race winner', confidence: 0.9 });
    console.log(JSON.stringify(r));
  `;
  const modUrl = new URL('../dist/src/kernel/cognition.js', import.meta.url).href;
  const run = () =>
    new Promise((resolve) => {
      const c = spawn(process.execPath, ['--input-type=module', '-e', childScript, modUrl, d.deliberation_id], {
        env: { ...process.env },
      });
      let out = '';
      c.stdout.on('data', (x) => (out += x));
      c.on('exit', () => resolve(out.trim()));
    });
  const [r1, r2] = await Promise.all([run(), run()]);
  const commits = [r1, r2].map((x) => JSON.parse(x)).filter((x) => x.committed);
  assert.equal(commits.length, 1, `exactly one process must win, got: ${r1} | ${r2}`);
  const events = getDb()
    .prepare(`SELECT COUNT(*) c FROM events WHERE event_type = 'deliberation.committed' AND entity_id = ?`)
    .get(d.deliberation_id);
  assert.equal(events.c, 1, 'exactly one committed event in the ledger');
});

test.after(() => closeDb());
