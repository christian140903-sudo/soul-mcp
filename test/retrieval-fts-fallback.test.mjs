import test from 'node:test';
import assert from 'node:assert/strict';
import { freshSoulDir } from './helpers.mjs';

freshSoulDir('retrieval-fts-fallback');

const { capture } = await import('../dist/src/kernel/memory.js');
const { recall } = await import('../dist/src/kernel/retrieval.js');
const { getDb, closeDb } = await import('../dist/src/kernel/db.js');

test('a broken FTS index still falls back to empty lexical rows, but the failure is logged (not silent)', async () => {
  capture({ content: 'Fallback regression test memory about deployment tooling' });

  // Simulate a corrupt/unusable FTS index the way it could happen on disk.
  getDb().prepare(`DROP TABLE memories_fts`).run();

  const calls = [];
  const originalConsoleError = console.error;
  console.error = (...args) => calls.push(args);
  try {
    const results = await recall('deployment tooling', { silent: true });
    assert.ok(Array.isArray(results), 'recall() must still resolve instead of throwing');
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(calls.length, 1, 'the FTS failure must be logged exactly once, not swallowed silently');
  assert.match(String(calls[0][0]), /\[soul\].*FTS query failed/);
});

test.after(() => closeDb());
