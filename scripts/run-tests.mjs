import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const testDirectory = fileURLToPath(new URL('../test/', import.meta.url));
const testFiles = readdirSync(testDirectory)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => fileURLToPath(new URL(`../test/${name}`, import.meta.url)));

if (testFiles.length === 0) {
  console.error('No test files found.');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...testFiles], {
  stdio: 'inherit',
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);
