import test from 'node:test';
import assert from 'node:assert/strict';
import { freshSoulDir } from './helpers.mjs';

freshSoulDir('workbench-decisions');

const { capture, getMemoryById, listDisputedPairs } = await import('../dist/src/kernel/memory.js');
const { computeAssignments, resolveAssignment, listAssignments } = await import('../dist/src/kernel/workbench.js');
const { _setEmbedderForTests, backfillVectors } = await import('../dist/src/kernel/semantic.js');
const { makePrediction, getPrediction } = await import('../dist/src/kernel/cognition.js');
const { closeDb, getDb } = await import('../dist/src/kernel/db.js');

function findAssignment(views, kind, memoryId) {
  return views.find((a) => a.kind === kind && a.memories.some((m) => m.id === memoryId));
}
function findPredictionAssignment(views, predictionId) {
  return views.find((a) => a.kind === 'prediction_due' && a.prediction?.id === predictionId);
}

/** The S1 regression check: after a resolution, three fresh detector runs
 *  must not re-issue an assignment for the same subject. */
function assertNoReissue(kind, memoryId, label) {
  for (let i = 0; i < 3; i++) {
    const again = findAssignment(computeAssignments(), kind, memoryId);
    assert.equal(again, undefined, `${label}: run ${i + 1} re-issued a ${kind} assignment`);
  }
}

test('keep_separate is terminal: the merge pair is never re-issued', async () => {
  _setEmbedderForTests((texts) =>
    Promise.resolve(
      texts.map((t) => {
        const v = new Float32Array([t.toLowerCase().includes('starter') ? 1 : 0, 0.02, 0, 0]);
        const n = Math.hypot(...v) || 1;
        return v.map((x) => x / n);
      })
    )
  );
  const a = capture({ content: 'The starter script lives in the repo under agent/', sourceType: 'agent_inference' });
  const b = capture({ content: 'The desktop starter is only a pointer to the repo script', sourceType: 'agent_inference' });
  await backfillVectors();

  const assignment = findAssignment(computeAssignments(), 'merge_review', a.memory.id);
  assert.ok(assignment, 'merge_review issued for the near-duplicate pair');

  const result = resolveAssignment(assignment.id, {
    action: 'keep_separate',
    reasoning: 'They carry distinct information: location vs. pointer semantics.',
  });
  assert.equal(result.applied, true);
  assert.equal(result.outcome, 'kept_separate');

  assertNoReissue('merge_review', a.memory.id, 'keep_separate');
  _setEmbedderForTests(null);
});

test('unclear dispute gets a cooldown: not re-issued immediately', () => {
  const a = capture({ content: 'User codes mornings for the deep work block', type: 'preference', sourceType: 'agent_inference' });
  const b = capture({ content: 'User codes evenings for the deep work block', type: 'preference', sourceType: 'agent_inference' });
  assert.ok(b.conflicts.length >= 1, 'pair is disputed');

  const assignment = findAssignment(computeAssignments(), 'dispute', a.memory.id);
  assert.ok(assignment, 'dispute assignment issued');

  const result = resolveAssignment(assignment.id, {
    verdict: 'unclear',
    reasoning: 'Not enough evidence in context to say which schedule holds today.',
  });
  assert.equal(result.applied, true);

  // the pair legitimately stays disputed for the USER channel …
  assert.ok(
    listDisputedPairs(20).some((p) => [p.a.id, p.b.id].includes(a.memory.id)),
    'pair remains visible in the review queue'
  );
  // … but the MODEL must not be asked again while the cooldown runs
  assertNoReissue('dispute', a.memory.id, 'unclear');
});

test('needs_user verdict stops model re-issue; the pair stays in the user review queue', () => {
  const a = capture({ content: 'User favorite editor is Zed since spring', type: 'preference', sourceType: 'user_statement' });
  const b = capture({ content: 'User favorite editor is VS Code since spring', type: 'preference', sourceType: 'user_statement' });
  assert.ok(b.conflicts.length >= 1);

  const assignment = findAssignment(computeAssignments(), 'dispute', a.memory.id);
  assert.ok(assignment);

  const result = resolveAssignment(assignment.id, {
    verdict: 'contradiction',
    current: b.memory.id,
    reasoning: 'The newer statement should win.',
  });
  assert.equal(result.applied, false);
  assert.equal(result.outcome, 'needs_user');

  assert.ok(
    listDisputedPairs(20).some((p) => [p.a.id, p.b.id].includes(a.memory.id)),
    'pair stays in the user review queue'
  );
  assertNoReissue('dispute', a.memory.id, 'needs_user');
});

test('doubt on a low-confidence inference gets a cooldown', () => {
  const m = capture({ content: 'User might switch the vault to Logseq eventually', sourceType: 'agent_inference', confidence: 0.3 });
  getDb().prepare(`UPDATE memories SET created_at = ? WHERE id = ?`).run('2026-01-01T00:00:00.000Z', m.memory.id);

  const assignment = findAssignment(computeAssignments(), 'low_confidence', m.memory.id);
  assert.ok(assignment, 'low_confidence assignment issued');

  const result = resolveAssignment(assignment.id, { action: 'doubt', reasoning: 'No sign of this in months of sessions.' });
  assert.equal(result.applied, true);
  // confidence dropped but stays inside the detector window -> without a
  // decision record this would bounce right back
  assertNoReissue('low_confidence', m.memory.id, 'doubt');
});

test('recommend_confirm on a stale candidate gets a cooldown', () => {
  const m = capture({ content: 'User bank appointment for the business account is pending', category: 'financial' });
  assert.equal(m.outcome, 'candidate', 'financial content is held as candidate');
  getDb().prepare(`UPDATE memories SET created_at = ? WHERE id = ?`).run('2026-01-01T00:00:00.000Z', m.memory.id);

  const assignment = findAssignment(computeAssignments(), 'stale_candidate', m.memory.id);
  assert.ok(assignment, 'stale_candidate assignment issued');

  const result = resolveAssignment(assignment.id, {
    action: 'recommend_confirm',
    reasoning: 'Worth keeping; the user should confirm the appointment fact.',
  });
  assert.equal(result.applied, true);
  assertNoReissue('stale_candidate', m.memory.id, 'recommend_confirm');
});

test('still_open prediction is snoozed, not re-issued immediately', () => {
  const p = makePrediction({ claim: 'The v4 starter ships this week', probability: 0.7, dueAt: '2026-01-01T00:00:00.000Z' });

  const assignment = findPredictionAssignment(computeAssignments(), p.id);
  assert.ok(assignment, 'prediction_due assignment issued');

  const result = resolveAssignment(assignment.id, {
    outcome: 'still_open',
    reasoning: 'The build is mid-flight; judgeable in a few days.',
  });
  assert.equal(result.applied, true);
  assert.equal(getPrediction(p.id).resolvedAt, null, 'prediction stays open');

  for (let i = 0; i < 3; i++) {
    const again = findPredictionAssignment(computeAssignments(), p.id);
    assert.equal(again, undefined, `still_open: run ${i + 1} re-issued the prediction`);
  }
});

test('correcting one side of a needs_user pair frees the partner and empties the queue', async () => {
  const { correctMemory } = await import('../dist/src/kernel/memory.js');
  const a = capture({ content: 'User plans the exam block for early October', type: 'goal', sourceType: 'user_statement' });
  const b = capture({ content: 'User plans the exam block for late October', type: 'goal', sourceType: 'user_statement' });
  assert.ok(b.conflicts.length >= 1);

  const assignment = findAssignment(computeAssignments(), 'dispute', a.memory.id);
  assert.ok(assignment);
  const verdict = resolveAssignment(assignment.id, {
    verdict: 'contradiction',
    current: b.memory.id,
    reasoning: 'Later plan should win.',
  });
  assert.equal(verdict.outcome, 'needs_user');

  // the user resolves it by correcting one side
  const corrected = correctMemory(a.memory.id, 'User plans the exam block for late October (confirmed)', {
    userEvidence: 'User: "es wird der späte Oktober"',
  });
  assert.equal(corrected.memory.sourceType, 'user_statement');

  // the old memory is superseded AND its partner is freed — no stale pair
  assert.equal(getMemoryById(a.memory.id).status, 'superseded');
  const partner = getMemoryById(b.memory.id);
  assert.ok(!partner.contradicts.includes(a.memory.id), 'back-link removed from the partner');
  assert.ok(
    !listDisputedPairs(50).some((p) => [p.a.id, p.b.id].includes(a.memory.id)),
    'review queue holds no stale pair'
  );
});

test('a resolution the guards reject leaves the assignment open (no silent resolved)', async () => {
  _setEmbedderForTests((texts) =>
    Promise.resolve(
      texts.map((t) => {
        const v = new Float32Array([0.01, t.toLowerCase().includes('cockpit') ? 1 : 0, 0, 0]);
        const n = Math.hypot(...v) || 1;
        return v.map((x) => x / n);
      })
    )
  );
  const a = capture({ content: 'The cockpit shows the backup age in hours', sourceType: 'agent_inference' });
  const b = capture({ content: 'Cockpit displays backup age (hours) prominently', sourceType: 'agent_inference' });
  await backfillVectors();

  const assignment = findAssignment(computeAssignments(), 'merge_review', a.memory.id);
  assert.ok(assignment, 'merge_review issued');

  // merge without merged_content: schema-valid but rejected by the apply guard
  const result = resolveAssignment(assignment.id, { action: 'merge', reasoning: 'These are the same fact twice.' });
  assert.equal(result.applied, false);
  assert.equal(result.outcome, 'invalid_resolution');
  assert.ok(
    listAssignments('open').some((x) => x.id === assignment.id),
    'assignment must stay open when nothing was applied'
  );
  _setEmbedderForTests(null);
});

test('every applied resolution leaves a decision record', () => {
  const rows = getDb().prepare(`SELECT kind, outcome, terminal FROM workbench_decisions`).all();
  assert.ok(rows.length >= 5, `expected decision records, got ${rows.length}`);
  const outcomes = new Set(rows.map((r) => r.outcome));
  assert.ok(outcomes.has('kept_separate'), 'keep_separate recorded');
  assert.ok(outcomes.has('needs_user'), 'needs_user recorded');
});

test.after(() => {
  _setEmbedderForTests(null);
  closeDb();
});
