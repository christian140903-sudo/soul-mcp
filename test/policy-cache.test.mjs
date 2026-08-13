import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, utimesSync } from 'fs';
import { freshSoulDir } from './helpers.mjs';

freshSoulDir('policy-cache');

const { loadConstitution, constitutionPath, storeRuleFor } = await import('../dist/src/kernel/policy.js');

test('unchanged constitution.json still hits the cache (no re-read per call)', () => {
  const a = loadConstitution();
  const b = loadConstitution();
  assert.equal(a, b, 'same object identity expected when the file has not changed');
});

test('editing constitution.json on disk takes effect without an explicit resetConstitutionCache() call', () => {
  loadConstitution();
  assert.equal(storeRuleFor('default'), 'auto');

  const path = constitutionPath();
  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  raw.store.default = 'confirm';
  writeFileSync(path, JSON.stringify(raw, null, 2));
  // Force a distinct mtime: some filesystems coalesce writes that happen
  // within the same tick to an identical timestamp.
  const future = new Date(Date.now() + 5000);
  utimesSync(path, future, future);

  assert.equal(
    storeRuleFor('default'),
    'confirm',
    'a manual edit to ~/.soul/constitution.json should be picked up on the next access'
  );
});
