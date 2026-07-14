import test from 'node:test';
import assert from 'node:assert/strict';
import { freshSoulDir } from './helpers.mjs';

freshSoulDir('semantic');

const { capture, forgetMemory } = await import('../dist/src/kernel/memory.js');
const { recall } = await import('../dist/src/kernel/retrieval.js');
const {
  _setEmbedderForTests,
  backfillVectors,
  upsertVector,
  getVector,
  deleteVector,
  semanticCandidates,
  calibrateSimilarity,
  semanticStatus,
} = await import('../dist/src/kernel/semantic.js');
const { getDb, closeDb } = await import('../dist/src/kernel/db.js');

/**
 * Deterministic fake embedder: maps texts onto 4 concept axes by keyword.
 * "deploy"/"netz" share an axis on purpose — that models the paraphrase
 * case (query and memory share meaning but zero significant words).
 */
const AXES = [
  ['kaffee', 'coffee'],
  ['deploy', 'netz'],
  ['studium', 'universität'],
  ['port', 'server'],
];
function fakeEmbed(texts) {
  return Promise.resolve(
    texts.map((t) => {
      const lower = t.toLowerCase();
      const v = new Float32Array(4);
      AXES.forEach((words, i) => {
        if (words.some((w) => lower.includes(w))) v[i] = 1;
      });
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm);
    })
  );
}

test('backfill embeds memories that are missing vectors', async () => {
  _setEmbedderForTests(fakeEmbed);
  capture({ content: 'Das Deployment der Website läuft über GitHub Pages' });
  capture({ content: 'Chriso trinkt morgens Kaffee' });
  // capture()'s own embed is fire-and-forget and may or may not have landed;
  // what must hold after a backfill is the final state: no memory missing a vector.
  await backfillVectors();
  const status = await semanticStatus();
  assert.equal(status.missing, 0);
  assert.ok(status.vectors >= 2);
});

test('recall finds a paraphrase with zero keyword overlap (hybrid mode)', async () => {
  // Query shares no significant word with the memory — FTS5 alone cannot find it.
  const results = await recall('Wie kommt die Seite live ins Netz?', { silent: true });
  assert.ok(results.length >= 1, 'semantic candidates surface despite no keyword match');
  assert.ok(results[0].content.includes('Deployment'));
  assert.ok(results[0].scoreParts.semantic > 0, 'semantic component contributes');
  assert.equal(results[0].scoreParts.fts, 0, 'no keyword match -> fts component is 0');
});

test('hybrid ranking prefers the semantically related memory', async () => {
  const results = await recall('Wie kommt die Seite live ins Netz?', { silent: true, limit: 5 });
  const contents = results.map((r) => r.content);
  const deployIdx = contents.findIndex((c) => c.includes('Deployment'));
  const coffeeIdx = contents.findIndex((c) => c.includes('Kaffee'));
  assert.equal(deployIdx, 0);
  if (coffeeIdx !== -1) assert.ok(deployIdx < coffeeIdx);
});

test('semantic candidates respect status filters via SQL resolution', async () => {
  const m = capture({ content: 'Das Studium beginnt im Herbst an der Universität' });
  await backfillVectors();
  let results = await recall('Wann startet das Studium?', { silent: true });
  assert.ok(results.some((r) => r.id === m.memory.id));
  forgetMemory(m.memory.id); // soft delete
  results = await recall('Wann startet das Studium?', { silent: true });
  assert.ok(!results.some((r) => r.id === m.memory.id), 'soft-deleted memory never returned');
});

test('hard forget removes the vector (cascade + cache)', async () => {
  const m = capture({ content: 'Der Server läuft auf einem eigenen Port' });
  await backfillVectors();
  assert.ok(getVector(m.memory.id));
  forgetMemory(m.memory.id, { hard: true });
  assert.equal(getVector(m.memory.id), null);
  const row = getDb().prepare(`SELECT COUNT(*) c FROM memory_vectors WHERE id = ?`).get(m.memory.id);
  assert.equal(row.c, 0);
});

test('vector store roundtrip and candidate threshold', () => {
  // embedder off during capture so no async embed races the manual upsert below
  _setEmbedderForTests(null);
  const m = capture({ content: 'threshold probe memory' });
  _setEmbedderForTests(fakeEmbed);
  const v = new Float32Array([1, 0, 0, 0]);
  upsertVector(m.memory.id, v);
  assert.deepEqual(Array.from(getVector(m.memory.id)), [1, 0, 0, 0]);
  // orthogonal query -> below MIN_CANDIDATE_COSINE -> not a candidate
  const far = semanticCandidates(new Float32Array([0, 1, 0, 0]), 10);
  assert.ok(!far.some((c) => c.id === m.memory.id));
  const near = semanticCandidates(new Float32Array([1, 0, 0, 0]), 10);
  assert.ok(near.some((c) => c.id === m.memory.id && c.similarity > 0.99));
  deleteVector(m.memory.id);
  assert.equal(getVector(m.memory.id), null);
});

test('calibration maps the e5 band onto 0..1', () => {
  assert.equal(calibrateSimilarity(0.6), 0);
  assert.equal(calibrateSimilarity(0.95), 1);
  assert.ok(calibrateSimilarity(0.8) > 0.5 && calibrateSimilarity(0.8) < 0.6);
  assert.equal(calibrateSimilarity(0.2), 0);
  assert.equal(calibrateSimilarity(0.99), 1);
});

test('without an embedder, recall degrades to lexical and semantic part is 0', async () => {
  _setEmbedderForTests(null); // semantic off again
  const results = await recall('Deployment GitHub Pages', { silent: true });
  assert.ok(results.length >= 1);
  assert.equal(results[0].scoreParts.semantic, 0);
  assert.ok(results[0].scoreParts.fts > 0);
});

test.after(() => {
  _setEmbedderForTests(null);
  closeDb();
});
