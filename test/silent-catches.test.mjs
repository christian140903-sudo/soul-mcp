// Follow-up to Fix 3 (retrieval.ts FTS catch): the remaining bare
// `catch { ... }` blocks across the kernel now log via the same
// console.error('[soul] ...') stderr idiom instead of swallowing the error.
// Fallback behavior is unchanged in every case — these tests pin both:
// the process must not throw, and the failure must be visible.

import test from 'node:test';
import assert from 'node:assert/strict';
import { freshSoulDir } from './helpers.mjs';

freshSoulDir('silent-catches');

const { getDb, closeDb } = await import('../dist/src/kernel/db.js');
const { startContextRun, getReceiptView } = await import('../dist/src/kernel/runs.js');
const { queryEvents } = await import('../dist/src/kernel/ledger.js');
const { capture, getMemoryById } = await import('../dist/src/kernel/memory.js');
const { registerSkill, transitionSkill, getSkillsForTask, listSkills } = await import('../dist/src/kernel/skills.js');

function captureConsoleError(fn) {
  const calls = [];
  const original = console.error;
  console.error = (...args) => calls.push(args);
  try {
    fn();
  } finally {
    console.error = original;
  }
  return calls;
}

function makeManifest(name, overrides = {}) {
  return {
    contract: 'SkillManifest@1',
    name,
    version: '1.0.0',
    description: 'widget calibration helper for the regression harness',
    lifecycle: 'shadow',
    origin: { type: 'local' },
    compatibility: { models: ['claude-*'] },
    body: { steps: [{ id: 's1', instruction: 'Do the task carefully.' }] },
    created_at: '2026-07-17T00:00:00Z',
    ...overrides,
  };
}

test('runs.ts safeJson: a corrupt receipt.outcome falls back to defaults instead of throwing, and logs', () => {
  const started = startContextRun({ task: 'corrupt-outcome regression check' });
  // SQLite's JSON1 extension is more lenient than JS's JSON.parse (accepts a
  // trailing comma here) — the schema's json_extract-based unique index lets
  // this through, but our own JSON.parse still rejects it. A real, reachable
  // divergence, not just an SQL injection of an arbitrary string.
  getDb().prepare(`UPDATE receipts SET outcome = ? WHERE receipt_id = ?`).run('{"attempt":1,}', started.receipt_id);

  let view;
  const calls = captureConsoleError(() => {
    view = getReceiptView(started.receipt_id);
  });

  assert.ok(view, 'getReceiptView must still return a view, not throw');
  assert.equal(view.fencing_token, 'unknown', 'falls back to the documented default');
  assert.ok(calls.some((c) => String(c[0]).includes('[soul]') && String(c[0]).includes('run JSON')));
});

test('ledger.ts safeJson: a corrupt event payload falls back to {} instead of throwing, and logs', () => {
  capture({ content: 'silent-catches ledger regression memory' });
  const rows = getDb().prepare(`SELECT seq FROM events ORDER BY seq DESC LIMIT 1`).get();
  getDb().prepare(`UPDATE events SET payload = ? WHERE seq = ?`).run('{not json', rows.seq);

  let events;
  const calls = captureConsoleError(() => {
    events = queryEvents({ limit: 5 });
  });

  assert.ok(Array.isArray(events), 'queryEvents must still return an array, not throw');
  const corrupted = events.find((e) => e.seq === rows.seq);
  assert.deepEqual(corrupted.payload, {}, 'corrupt payload falls back to {}');
  assert.ok(calls.some((c) => String(c[0]).includes('[soul]') && String(c[0]).includes('event payload')));
});

test('memory.ts safeParseArray: corrupt stored tags fall back to [] instead of throwing, and logs', () => {
  const r = capture({ content: 'silent-catches memory tags regression' });
  getDb().prepare(`UPDATE memories SET tags = ? WHERE id = ?`).run('{not json', r.memory.id);

  let mem;
  const calls = captureConsoleError(() => {
    mem = getMemoryById(r.memory.id);
  });

  assert.deepEqual(mem.tags, [], 'corrupt tags fall back to an empty array');
  assert.ok(calls.some((c) => String(c[0]).includes('[soul]') && String(c[0]).includes('array JSON')));
});

test('skills.ts getSkillsForTask: a corrupt manifest is excluded (not thrown), and logged', () => {
  const good = registerSkill(makeManifest('good-manifest-skill'));
  const bad = registerSkill(makeManifest('bad-manifest-skill'));
  assert.equal(transitionSkill('good-manifest-skill', 'canary').ok, true);
  assert.equal(transitionSkill('good-manifest-skill', 'promoted', { evidence: { eval_refs: ['e1'] } }).ok, true);
  assert.equal(transitionSkill('bad-manifest-skill', 'canary').ok, true);
  assert.equal(transitionSkill('bad-manifest-skill', 'promoted', { evidence: { eval_refs: ['e2'] } }).ok, true);
  getDb().prepare(`UPDATE skills SET manifest = ? WHERE skill_id = ?`).run('{not json', bad.skill_id);

  let picked;
  const calls = captureConsoleError(() => {
    picked = getSkillsForTask('widget calibration', { modelHint: 'claude-fable-5' });
  });

  assert.ok(picked.some((s) => s.name === 'good-manifest-skill'), 'the valid skill is still matched');
  assert.ok(!picked.some((s) => s.name === 'bad-manifest-skill'), 'the corrupt skill is excluded, not thrown');
  assert.ok(calls.some((c) => String(c[0]).includes('[soul]') && String(c[0]).includes('manifest')));
});

test('skills.ts listSkills: a corrupt manifest leaves description empty instead of throwing, and logs', () => {
  const skill = registerSkill(makeManifest('list-corrupt-skill'));
  getDb().prepare(`UPDATE skills SET manifest = ? WHERE skill_id = ?`).run('{not json', skill.skill_id);

  let all;
  const calls = captureConsoleError(() => {
    all = listSkills();
  });

  const row = all.find((s) => s.skill_id === skill.skill_id);
  assert.equal(row.description, '', 'corrupt manifest leaves description empty, listing still succeeds');
  assert.ok(calls.some((c) => String(c[0]).includes('[soul]') && String(c[0]).includes('manifest')));
});

test.after(() => closeDb());
