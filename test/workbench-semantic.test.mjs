import test from 'node:test';
import assert from 'node:assert/strict';
import { freshSoulDir } from './helpers.mjs';

// Own soul dir: the embedding-scan detectors read ALL stored vectors, so this
// suite must not share a database with other workbench tests.
freshSoulDir('workbench-semantic');

const { capture } = await import('../dist/src/kernel/memory.js');
const { computeAssignments } = await import('../dist/src/kernel/workbench.js');
const { _setEmbedderForTests, backfillVectors, relatedMemories } = await import('../dist/src/kernel/semantic.js');
const { closeDb } = await import('../dist/src/kernel/db.js');

_setEmbedderForTests((texts) =>
  Promise.resolve(
    texts.map((t) => {
      const v = new Float32Array([
        /vim|emacs/i.test(t) ? 1 : 0,
        /kaffee|coffee/i.test(t) ? 1 : 0,
        0,
        0.01,
      ]);
      const n = Math.hypot(...v) || 1;
      return v.map((x) => x / n);
    })
  )
);

test('semantically similar preferences with no word overlap become a dispute, not a merge', async () => {
  const a = capture({ content: 'Prefers the vim editor for quick edits', type: 'preference' });
  const b = capture({ content: 'Nutzt am liebsten Emacs beim Programmieren', type: 'preference' });
  assert.equal(b.conflicts.length, 0, 'word-overlap heuristic does not catch this pair');
  await backfillVectors();

  const views = computeAssignments();
  const assignment = views.find((x) => x.kind === 'dispute' && x.memories.some((m) => m.id === a.memory.id));
  assert.ok(assignment, 'embedding scan issues a dispute for conflict-prone types');
  assert.ok(assignment.memories.some((m) => m.id === b.memory.id));
});

test('relatedMemories returns live nearest neighbors, excluding the memory itself', async () => {
  const c1 = capture({ content: 'Trinkt morgens Kaffee vor der Arbeit' });
  const c2 = capture({ content: 'Coffee first thing in the morning is a habit' });
  await backfillVectors();
  const related = relatedMemories(c1.memory.id, 3);
  assert.ok(related.length >= 1);
  assert.ok(!related.some((r) => r.id === c1.memory.id));
  assert.equal(related[0].id, c2.memory.id);
  assert.ok(related[0].similarity > 0.9);
});

test.after(() => {
  _setEmbedderForTests(null);
  closeDb();
});
