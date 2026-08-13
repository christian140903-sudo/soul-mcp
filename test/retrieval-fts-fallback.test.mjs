import test from 'node:test';
import assert from 'node:assert/strict';
import { freshSoulDir } from './helpers.mjs';

freshSoulDir('retrieval-fts-fallback');

const { capture } = await import('../dist/src/kernel/memory.js');
const { recall } = await import('../dist/src/kernel/retrieval.js');
const { getDb, closeDb } = await import('../dist/src/kernel/db.js');

// The failure counter that drives the log throttle lives at module scope in
// retrieval.ts, so both recall() calls below happen in the same test to keep
// this test self-contained (it would otherwise share state with any other
// test in this file/process).
test('a broken FTS index falls back to empty lexical rows and logs, but a second recall on the same broken index does not flood the log', async () => {
  capture({ content: 'Fallback regression test memory about deployment tooling' });

  // Simulate a corrupt/unusable FTS index the way it could happen on disk.
  getDb().prepare(`DROP TABLE memories_fts`).run();

  const calls = [];
  const originalConsoleError = console.error;
  console.error = (...args) => calls.push(args);
  try {
    const results = await recall('deployment tooling', { silent: true });
    assert.ok(Array.isArray(results), 'recall() must still resolve instead of throwing');
    await recall('deployment tooling again', { silent: true });
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(calls.length, 1, 'two recalls on the same broken index must log exactly once, not per call');
  assert.match(String(calls[0][0]), /\[soul\].*FTS query failed/);
});

test.after(() => closeDb());
