import test from 'node:test';
import assert from 'node:assert/strict';
import { freshSoulDir } from './helpers.mjs';

freshSoulDir('workbench');

const { capture, getMemoryById } = await import('../dist/src/kernel/memory.js');
const { computeAssignments, resolveAssignment, listAssignments } = await import('../dist/src/kernel/workbench.js');
const { compileContext } = await import('../dist/src/kernel/context.js');
const { _setEmbedderForTests, backfillVectors } = await import('../dist/src/kernel/semantic.js');
const { queryEvents } = await import('../dist/src/kernel/ledger.js');
const { closeDb, getDb } = await import('../dist/src/kernel/db.js');

function findAssignment(views, kind, memoryId) {
  return views.find((a) => a.kind === kind && a.memories.some((m) => m.id === memoryId));
}

test('a disputed pair becomes a dispute assignment; verdict compatible un-disputes both', () => {
  const a = capture({ content: 'User prefers tabs for indentation in python', type: 'preference' });
  const b = capture({ content: 'User prefers spaces for indentation in python', type: 'preference' });
  assert.ok(b.conflicts.length >= 1, 'pair is disputed');

  const views = computeAssignments();
  const assignment = findAssignment(views, 'dispute', a.memory.id);
  assert.ok(assignment, 'dispute assignment issued');
  assert.ok(assignment.instruction.length > 20);
  assert.ok(assignment.respond_with.verdict);

  const result = resolveAssignment(assignment.id, {
    verdict: 'compatible',
    reasoning: 'Tabs vs spaces here describe two different projects; both can be true.',
  });
  assert.equal(result.applied, true);
  assert.equal(result.outcome, 'undisputed');
  assert.equal(getMemoryById(a.memory.id).status, 'active');
  assert.equal(getMemoryById(b.memory.id).status, 'active');
  assert.ok(queryEvents({ eventType: 'memory.undisputed' }).length >= 2);
});

test('a model verdict never overrules a user statement (needs_user guard)', () => {
  const a = capture({ content: 'User lives in Vienna since 2024', type: 'identity', sourceType: 'user_statement' });
  const b = capture({ content: 'User lives in Vienna near Korneuburg since 2020', type: 'identity', sourceType: 'user_statement' });
  assert.ok(b.conflicts.length >= 1);
  const assignment = findAssignment(computeAssignments(), 'dispute', a.memory.id);
  assert.ok(assignment);

  const result = resolveAssignment(assignment.id, {
    verdict: 'contradiction',
    current: b.memory.id,
    reasoning: 'The second statement is more specific and newer.',
  });
  assert.equal(result.applied, false);
  assert.equal(result.outcome, 'needs_user');
  // both sides untouched, still disputed
  assert.equal(getMemoryById(a.memory.id).status, 'disputed');
  assert.equal(getMemoryById(b.memory.id).status, 'disputed');
});

test('contradiction against an agent inference supersedes (kept, linked), never deletes', () => {
  const inference = capture({ content: 'User probably works at a bank downtown', type: 'preference', sourceType: 'agent_inference' });
  const statement = capture({ content: 'User probably works at a startup downtown', type: 'preference', sourceType: 'agent_inference' });
  assert.ok(statement.conflicts.includes(inference.memory.id));
  const assignment = findAssignment(computeAssignments(), 'dispute', inference.memory.id);
  assert.ok(assignment);

  const result = resolveAssignment(assignment.id, {
    verdict: 'contradiction',
    current: statement.memory.id,
    reasoning: 'Later information contradicts the bank guess.',
  });
  assert.equal(result.applied, true);
  assert.equal(result.outcome, 'superseded');
  const loser = getMemoryById(inference.memory.id);
  assert.equal(loser.status, 'superseded', 'loser kept as superseded, not deleted');
  assert.equal(loser.supersededBy, statement.memory.id);
  assert.equal(getMemoryById(statement.memory.id).status, 'active');
});

test('near-duplicates become a merge_review; merge creates a model_assisted memory', async () => {
  _setEmbedderForTests((texts) =>
    Promise.resolve(
      texts.map((t) => {
        // both phrasings of the daemon fact land on the same axis
        const v = new Float32Array([t.toLowerCase().includes('daemon') ? 1 : 0, t.length % 7 === 0 ? 0.05 : 0.01, 0, 0]);
        const n = Math.hypot(...v) || 1;
        return v.map((x) => x / n);
      })
    )
  );
  const a = capture({ content: 'The daemon exposes 128 endpoints on port 4200' });
  const b = capture({ content: 'Miguel daemon runs on :4200 with 128 HTTP endpoints' });
  await backfillVectors();

  const assignment = findAssignment(computeAssignments(), 'merge_review', a.memory.id);
  assert.ok(assignment, 'merge_review issued for the near-duplicate pair');

  const result = resolveAssignment(assignment.id, {
    action: 'merge',
    merged_content: 'The Miguel daemon runs on port 4200 and exposes 128 HTTP endpoints.',
    reasoning: 'Same fact in two phrasings; one memory suffices.',
  });
  assert.equal(result.applied, true);
  assert.equal(result.outcome, 'merged');
  assert.equal(getMemoryById(a.memory.id).status, 'superseded');
  assert.equal(getMemoryById(b.memory.id).status, 'superseded');
  const mergedId = getMemoryById(a.memory.id).supersededBy;
  const merged = getMemoryById(mergedId);
  assert.equal(merged.sourceType, 'model_assisted');
  assert.ok(merged.sourceRef.startsWith('workbench:'));
  _setEmbedderForTests(null);
});

test('low-confidence old inference: endorse raises confidence', () => {
  const m = capture({ content: 'User might be interested in embedded systems', sourceType: 'agent_inference', confidence: 0.3 });
  // age the memory so the detector sees it
  getDb().prepare(`UPDATE memories SET created_at = ? WHERE id = ?`).run('2026-01-01T00:00:00.000Z', m.memory.id);
  const assignment = findAssignment(computeAssignments(), 'low_confidence', m.memory.id);
  assert.ok(assignment, 'low_confidence assignment issued');
  const before = getMemoryById(m.memory.id).confidence;
  const result = resolveAssignment(assignment.id, { action: 'endorse', reasoning: 'Recent sessions confirm this interest.' });
  assert.equal(result.applied, true);
  assert.ok(getMemoryById(m.memory.id).confidence > before);
});

test('invalid resolutions are rejected with the schema error, assignment stays open', () => {
  const a = capture({ content: 'User prefers dark mode everywhere', type: 'preference' });
  const b = capture({ content: 'User prefers light mode everywhere', type: 'preference' });
  assert.ok(b.conflicts.length >= 1);
  const assignment = findAssignment(computeAssignments(), 'dispute', a.memory.id);
  assert.ok(assignment);
  const result = resolveAssignment(assignment.id, { verdict: 'nonsense', reasoning: 'short' });
  assert.equal(result.applied, false);
  assert.equal(result.outcome, 'invalid_resolution');
  assert.ok(listAssignments('open').some((x) => x.id === assignment.id), 'assignment still open');
});

test('context capsule carries briefing + assignments for a deep model, none for a fast one', async () => {
  const deep = await compileContext('plan the next build step', { modelHint: 'claude-fable-5', tokenBudget: 4000 });
  assert.equal(deep.model_profile, 'deep');
  assert.ok(deep.briefing && deep.briefing.length > 20);
  assert.ok(Array.isArray(deep.workbench) && deep.workbench.length >= 1);
  assert.ok(deep.workbench.length <= 2, 'deep profile caps at 2');

  const fast = await compileContext('quick lookup', { modelHint: 'claude-haiku-4-5', tokenBudget: 4000 });
  assert.equal(fast.workbench, undefined);
  assert.equal(fast.briefing, undefined);

  const receipts = queryEvents({ eventType: 'context.compiled' });
  const last = receipts[receipts.length - 1];
  assert.ok('model_profile' in last.payload);
});

test.after(() => {
  _setEmbedderForTests(null);
  closeDb();
});
