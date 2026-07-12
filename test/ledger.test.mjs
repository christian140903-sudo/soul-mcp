import test from 'node:test';
import assert from 'node:assert/strict';
import { freshSoulDir } from './helpers.mjs';

freshSoulDir('ledger');

const { capture, forgetMemory, correctMemory } = await import('../dist/src/kernel/memory.js');
const { queryEvents, memoriesAsOf } = await import('../dist/src/kernel/ledger.js');
const { closeDb } = await import('../dist/src/kernel/db.js');

test('every capture writes a ledger event', () => {
  const r = capture({ content: 'Vienna is where the user lives' });
  const events = queryEvents({ entityId: r.memory.id });
  assert.ok(events.some((e) => e.eventType === 'memory.captured'));
  assert.equal(events[0].payload.content, 'Vienna is where the user lives');
});

test('corrections leave a full audit trail', () => {
  const orig = capture({ content: 'The meeting is on Tuesday' });
  const corr = correctMemory(orig.memory.id, 'The meeting is on Wednesday');
  const oldEvents = queryEvents({ entityId: orig.memory.id });
  const newEvents = queryEvents({ entityId: corr.memory.id });
  assert.ok(oldEvents.some((e) => e.eventType === 'memory.superseded'));
  assert.ok(newEvents.some((e) => e.eventType === 'memory.corrected'));
});

test('time travel: memoriesAsOf sees deleted memories that were active then', async () => {
  const r = capture({ content: 'The old office was in Graz before the move' });
  // everything so far happened "now"; snapshot a moment after creation
  await new Promise((resolve) => setTimeout(resolve, 10));
  const snapshotTime = new Date().toISOString();
  await new Promise((resolve) => setTimeout(resolve, 10));
  forgetMemory(r.memory.id, { hard: true });

  const then = memoriesAsOf(snapshotTime);
  const found = then.find((m) => m.id === r.memory.id);
  assert.ok(found, 'hard-deleted memory should be visible at a pre-deletion timestamp');
  assert.equal(found.content, 'The old office was in Graz before the move');

  const now = memoriesAsOf(new Date().toISOString());
  assert.equal(now.filter((m) => m.id === r.memory.id).length, 0);
});

test.after(() => closeDb());
