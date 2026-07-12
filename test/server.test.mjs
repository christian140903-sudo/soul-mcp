/**
 * End-to-end MCP smoke test: spawn the real binary exactly like an MCP client
 * does (piped stdio, no args) and speak JSON-RPC to it. This is the test that
 * would have caught the v1 packaging bug.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function rpcClient() {
  const child = spawn(process.execPath, [join(root, 'dist/src/index.js')], {
    env: { ...process.env, SOUL_DIR: mkdtempSync(join(tmpdir(), 'soul-test-server-')) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  const pending = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line); // any non-JSON on stdout must fail the test
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  let nextId = 1;
  const request = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`timeout waiting for ${method}`));
        }
      }, 10000);
    });
  const notify = (method, params = {}) => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  };
  return { child, request, notify };
}

test('the default binary invocation serves MCP: initialize, list tools, call a tool', async () => {
  const { child, request, notify } = rpcClient();
  try {
    const init = await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'soul-test', version: '0.0.0' },
    });
    assert.equal(init.result.serverInfo.name, 'soul');
    assert.equal(init.result.serverInfo.version, '2.0.0');
    notify('notifications/initialized');

    const tools = await request('tools/list');
    const names = tools.result.tools.map((t) => t.name);
    for (const expected of ['soul_remember', 'soul_recall', 'soul_context', 'soul_confirm', 'soul_correct', 'soul_timeline', 'soul_review_queue', 'soul_export', 'soul_import']) {
      assert.ok(names.includes(expected), `missing tool ${expected}`);
    }

    const resources = await request('resources/list');
    const uris = resources.result.resources.map((r) => r.uri);
    assert.ok(uris.includes('soul://status'));
    assert.ok(uris.includes('soul://constitution'));

    const prompts = await request('prompts/list');
    assert.ok(prompts.result.prompts.some((p) => p.name === 'soul-daily-review'));

    const remember = await request('tools/call', {
      name: 'soul_remember',
      arguments: { content: 'End-to-end test memory about the MCP handshake' },
    });
    const payload = JSON.parse(remember.result.content[0].text);
    assert.equal(payload.outcome, 'stored');

    const recallResult = await request('tools/call', {
      name: 'soul_recall',
      arguments: { query: 'MCP handshake' },
    });
    const recallPayload = JSON.parse(recallResult.result.content[0].text);
    assert.ok(recallPayload.found >= 1);
  } finally {
    child.kill();
  }
});

test('CLI mode still works when run with a command argument', async () => {
  const child = spawn(process.execPath, [join(root, 'dist/src/index.js'), 'status'], {
    env: { ...process.env, SOUL_DIR: mkdtempSync(join(tmpdir(), 'soul-test-cli-')) },
  });
  let out = '';
  child.stdout.on('data', (c) => (out += c.toString()));
  await new Promise((resolve) => child.on('exit', resolve));
  assert.ok(out.includes('not initialized'), `unexpected output: ${out}`);
});
