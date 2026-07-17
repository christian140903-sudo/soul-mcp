import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(readFileSync(new URL('../server.json', import.meta.url), 'utf8'));
const dbSource = readFileSync(new URL('../src/kernel/db.ts', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

test('release metadata: npm, MCP manifest and runtime versions stay aligned', () => {
  assert.equal(pkg.version, '4.0.1');
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.packages[0].version, pkg.version);
  assert.match(dbSource, new RegExp(`SOUL_VERSION = '${pkg.version.replaceAll('.', '\\.')}'`));
  assert.match(readme, new RegExp(`Current release: \\*\\*${pkg.version.replaceAll('.', '\\.')}\\*\\*`));
  assert.equal(pkg.scripts.prepack, 'npm run build');
  assert.equal(pkg.scripts['smoke:pack'], 'node scripts/release-smoke.mjs');
  assert.ok(existsSync(new URL('../docs/assets/soul-banner.webp', import.meta.url)));
});

test('public claims: central honesty boundaries remain prominent', () => {
  assert.match(readme, /No worker/i);
  assert.match(readme, /No model benchmark results/i);
  assert.match(readme, /never issues `deterministic_verified`/i);
  assert.match(readme, /self_attested/);
});
