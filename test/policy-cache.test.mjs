import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, statSync, utimesSync } from 'fs';
import { freshSoulDir } from './helpers.mjs';

freshSoulDir('policy-cache');

const { loadConstitution, constitutionPath, storeRuleFor } = await import('../dist/src/kernel/policy.js');

test('an unchanged constitution.json hits the cache once the mtime is past the grace window', () => {
  loadConstitution();
  const path = constitutionPath();
  // Backdate the file so the very first read already sits outside the 2s
  // grace window used to guard against coarse mtime resolution — otherwise
  // every read right after a write would look "recent" and never hit cache.
  const past = new Date(Date.now() - 10_000);
  utimesSync(path, past, past);

  const a = loadConstitution();
  const b = loadConstitution();
  assert.equal(a, b, 'same object identity expected when the file has not changed and is past the grace window');
});

test('editing constitution.json on disk takes effect without an explicit resetConstitutionCache() call', () => {
  loadConstitution();
  assert.equal(storeRuleFor('default'), 'auto');

  const path = constitutionPath();
  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  raw.store.default = 'confirm';
  writeFileSync(path, JSON.stringify(raw, null, 2));

  assert.equal(
    storeRuleFor('default'),
    'confirm',
    'a manual edit to ~/.soul/constitution.json should be picked up on the next access'
  );
});

test('a same-mtime, same-size edit within the grace window is still picked up (mtime granularity hardening)', () => {
  loadConstitution();
  const path = constitutionPath();
  const originalMtime = statSync(path).mtimeMs;

  // Same length as '30d' — this edit alone would be invisible to a
  // size-based check too, isolating the grace-window mechanism.
  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  assert.equal(raw.retention.candidate, '30d');
  raw.retention.candidate = '45d';
  writeFileSync(path, JSON.stringify(raw, null, 2));
  // Simulate a filesystem with coarse mtime resolution: force the same
  // mtime as the first write, even though the content changed. (Even if a
  // filesystem's own precision keeps this from colliding exactly, the
  // assertion below is still a valid regression pin for the grace window.)
  utimesSync(path, new Date(originalMtime), new Date(originalMtime));

  assert.equal(
    loadConstitution().retention.candidate,
    '45d',
    'an edit within the grace window must not be hidden by an identical (mtime, size) signature'
  );
});
