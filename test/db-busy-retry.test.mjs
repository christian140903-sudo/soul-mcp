import test from 'node:test';
import assert from 'node:assert/strict';
import { freshSoulDir } from './helpers.mjs';

freshSoulDir('db-busy-retry');

const { withBusyRetry, getDb, closeDb } = await import('../dist/src/kernel/db.js');

function busyError() {
  const err = new Error('database is locked');
  err.code = 'SQLITE_BUSY';
  return err;
}

test('withBusyRetry retries SQLITE_BUSY and returns the eventual success', () => {
  let calls = 0;
  const result = withBusyRetry(() => {
    calls++;
    if (calls < 3) throw busyError();
    return 'ok';
  }, 5, 1);
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('withBusyRetry gives up after exhausting its attempts and rethrows', () => {
  let calls = 0;
  assert.throws(
    () =>
      withBusyRetry(
        () => {
          calls++;
          throw busyError();
        },
        3,
        1
      ),
    /database is locked/
  );
  assert.equal(calls, 3);
});

test('withBusyRetry does not retry errors other than SQLITE_BUSY / SQLITE_LOCKED', () => {
  let calls = 0;
  assert.throws(
    () =>
      withBusyRetry(() => {
        calls++;
        throw new Error('constraint failed');
      }, 5, 1),
    /constraint failed/
  );
  assert.equal(calls, 1, 'a non-busy error must fail fast, not retry');
});

test('getDb() wraps db.transaction() with retry at the connection level (chokepoint, no per-call-site opt-in)', () => {
  const db = getDb();
  let calls = 0;
  const tx = db.transaction(() => {
    calls++;
    if (calls < 3) throw busyError();
    return 'ok';
  });
  // Called exactly like every real kernel call site: tx(), no manual wrapping.
  const result = tx();
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('the .immediate() transaction variant also retries at the chokepoint', () => {
  const db = getDb();
  let calls = 0;
  const tx = db.transaction(() => {
    calls++;
    if (calls < 2) throw busyError();
    return 'ok';
  });
  const result = tx.immediate();
  assert.equal(result, 'ok');
  assert.equal(calls, 2);
});

test.after(() => closeDb());
