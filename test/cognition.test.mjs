import test from 'node:test';
import assert from 'node:assert/strict';
import { freshSoulDir } from './helpers.mjs';

freshSoulDir('cognition');

const { makePrediction, resolvePrediction, getCalibration, listPredictions, deliberate } = await import('../dist/src/kernel/cognition.js');
const { computeAssignments, resolveAssignment } = await import('../dist/src/kernel/workbench.js');
const { capture } = await import('../dist/src/kernel/memory.js');
const { recall } = await import('../dist/src/kernel/retrieval.js');
const { compileContext } = await import('../dist/src/kernel/context.js');
const { closeDb } = await import('../dist/src/kernel/db.js');

test('predictions register, resolve, and produce an honest calibration record', () => {
  // 6 overconfident predictions: claimed 90%, only 3 hit
  const ids = [];
  for (let i = 0; i < 6; i++) ids.push(makePrediction({ claim: `overconfident claim ${i}`, probability: 0.9 }).id);
  ids.forEach((id, i) => resolvePrediction(id, i < 3 ? 'true' : 'false'));

  const cal = getCalibration();
  assert.equal(cal.resolved, 6);
  assert.ok(cal.brier > 0.2, `overconfidence shows up in Brier (${cal.brier})`);
  assert.ok(cal.note && cal.note.includes('Brier'));
  const bucket = cal.buckets.find((b) => b.range.includes('85'));
  assert.ok(bucket && Math.abs(bucket.actual - 0.5) < 0.01, '85-100% bucket shows the real 50% hit rate');
});

test('a badly missed prediction becomes a learning memory automatically (surprise capture)', async () => {
  const p = makePrediction({ claim: 'The build will pass on the first try', probability: 0.95 });
  resolvePrediction(p.id, 'false');
  const results = await recall('prediction missed build first try', { silent: true });
  const surprise = results.find((m) => m.sourceRef === `prediction:${p.id}`);
  assert.ok(surprise, 'surprise memory exists');
  assert.equal(surprise.sourceType, 'model_assisted');
  assert.equal(surprise.category, 'learning');
});

test('due predictions come back through the workbench and resolve the ledger', () => {
  const p = makePrediction({ claim: 'This due claim is judgeable now', probability: 0.6, dueAt: '2020-01-01T00:00:00.000Z' });
  const views = computeAssignments();
  const assignment = views.find((a) => a.kind === 'prediction_due' && a.prediction?.id === p.id);
  assert.ok(assignment, 'prediction_due assignment issued');
  assert.equal(assignment.memories.length, 0);
  assert.equal(assignment.prediction.claim, p.claim);

  const result = resolveAssignment(assignment.id, { outcome: 'true', reasoning: 'Verified against what happened since.' });
  assert.equal(result.applied, true);
  assert.equal(result.outcome, 'prediction_true');
  assert.ok(listPredictions({ open: true }).every((x) => x.id !== p.id));
});

test('deliberate returns a scaffold with calibration and validated procedures', async () => {
  capture({
    content: 'Validated procedure: before every deploy, run the full test suite and check the staging health endpoint',
    type: 'procedural',
    category: 'solution',
  });
  const d = await deliberate('Should we deploy the new retrieval code tonight?');
  assert.equal(d.kind, 'decision');
  assert.equal(d.scaffold.length, 5);
  assert.ok(d.scaffold.some((s) => s.toLowerCase().includes('opposite')), 'counter-hypothesis step present');
  assert.ok(d.calibration && d.calibration.includes('Brier'), 'calibration record attached');
  assert.ok(d.validated_procedures.some((m) => m.content.includes('staging health')), 'own procedures recalled');

  const diag = await deliberate('Why does the server crash on startup?');
  assert.equal(diag.kind, 'diagnosis');
});

test('capsule briefing carries the calibration note for capable models', async () => {
  const capsule = await compileContext('decide the release strategy', { modelHint: 'claude-opus-4-8', tokenBudget: 4000 });
  assert.equal(capsule.model_profile, 'deep');
  assert.ok(capsule.briefing && capsule.briefing.includes('Brier'), 'calibration feedback reaches the model');
});

test.after(() => closeDb());
