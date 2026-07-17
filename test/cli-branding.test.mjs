import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('CLI help reports the runtime release and contains no stale v2 banner', () => {
  const result = spawnSync(process.execPath, ['dist/src/index.js', '--help'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Soul MCP v4\.0\.1/);
  assert.doesNotMatch(result.stdout, /Soul MCP v2/);
});
