import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const exec = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const installRoot = await mkdtemp(join(tmpdir(), 'soul-release-smoke-'));
let tarballPath;
let child;

async function request(method, params = {}) {
  const id = request.nextId++;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      request.pending.delete(id);
      reject(new Error(`Timed out waiting for ${method}`));
    }, 10_000);

    request.pending.set(id, (message) => {
      clearTimeout(timeout);
      resolve(message);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}
request.nextId = 1;
request.pending = new Map();

try {
  const packed = await exec('npm', ['pack', '--json'], { cwd: root, maxBuffer: 10 * 1024 * 1024 });
  const packResult = JSON.parse(packed.stdout);
  assert.equal(packResult.length, 1, 'npm pack must produce exactly one tarball');
  tarballPath = join(root, packResult[0].filename);

  await exec('npm', ['init', '-y'], { cwd: installRoot });
  await exec('npm', ['install', '--no-audit', '--no-fund', tarballPath], {
    cwd: installRoot,
    maxBuffer: 10 * 1024 * 1024,
  });

  const packageRoot = join(installRoot, 'node_modules', 'soul-mcp');
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  const entry = join(packageRoot, packageJson.main);
  const soulDir = join(installRoot, 'soul-data');
  const environment = { ...process.env, SOUL_DIR: soulDir };

  const version = await exec(process.execPath, [entry, '--version'], { env: environment });
  assert.match(version.stdout, /4\.0\.1/, 'installed CLI must report 4.0.1');

  const example = join(packageRoot, 'examples', 'minimal-fix-with-regression-test.skill.json');
  const registered = await exec(process.execPath, [entry, 'skill', 'register', example], { env: environment });
  assert.match(registered.stdout, /minimal-fix-with-regression-test/);

  child = spawn(process.execPath, [entry], {
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buffer = '';
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.id !== undefined && request.pending.has(message.id)) {
        request.pending.get(message.id)(message);
        request.pending.delete(message.id);
      }
    }
  });

  const initialized = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'soul-release-smoke', version: '1.0.0' },
  });
  assert.equal(initialized.result.serverInfo.name, 'soul');
  assert.equal(initialized.result.serverInfo.version, '4.0.1');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);

  const listed = await request('tools/list');
  const toolNames = listed.result.tools.map((tool) => tool.name);
  assert.equal(toolNames.length, 23, 'packed server must expose all 23 MCP tools');
  for (const expected of ['soul_remember', 'soul_context', 'soul_run', 'soul_feedback', 'soul_import']) {
    assert.ok(toolNames.includes(expected), `packed server is missing ${expected}`);
  }
  assert.equal(stderr, '', 'MCP server must not emit errors during a clean handshake');

  console.log(`Packed release verified: ${packageJson.name}@${packageJson.version}, ${toolNames.length} MCP tools.`);
} finally {
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise((resolve) => child.once('close', resolve));
  }
  if (tarballPath) await rm(tarballPath, { force: true });
  await rm(installRoot, { recursive: true, force: true });
}
