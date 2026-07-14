import test from 'node:test';
import assert from 'node:assert/strict';
import { freshSoulDir } from './helpers.mjs';

freshSoulDir('provenance-guards');

const { capture, confirmMemory, correctMemory, forgetMemory, getMemoryById } = await import('../dist/src/kernel/memory.js');
const { setIdentityFacet, getIdentityFacet } = await import('../dist/src/kernel/identity.js');
const { createGoal, updateGoal } = await import('../dist/src/kernel/goals.js');
const { queryEvents } = await import('../dist/src/kernel/ledger.js');
const { closeDb } = await import('../dist/src/kernel/db.js');

function lastEventFor(eventType, entityId) {
  const events = queryEvents({ eventType, entityId, limit: 5 });
  return events[events.length - 1];
}

test('a confirmed facet loses confirmed status when the VALUE changes without fresh evidence', () => {
  setIdentityFacet('home_city', 'Vienna', { confirmed: true, userEvidence: 'User: "ich wohne in Wien"' });
  assert.equal(getIdentityFacet('home_city').status, 'confirmed');

  // unevidenced value change (e.g. via soul_reflect or a bare tool call)
  setIdentityFacet('home_city', 'Graz', { sourceType: 'reflection' });
  const facet = getIdentityFacet('home_city');
  assert.equal(facet.value, 'Graz');
  assert.equal(facet.status, 'observed', 'old confirmation must not cover a new value');

  // unchanged value keeps its status
  setIdentityFacet('lang', 'Deutsch', { confirmed: true, userEvidence: 'User: "Deutsch bitte"' });
  setIdentityFacet('lang', 'Deutsch', {});
  assert.equal(getIdentityFacet('lang').status, 'confirmed', 'same value keeps confirmed');
});

test('whitespace evidence never mints user authority', () => {
  const facet = setIdentityFacet('editor', 'zed', { confirmed: true, userEvidence: '   ' });
  assert.equal(facet.status, 'observed');

  const m = capture({ content: 'User keyboard layout is colemak maybe', sourceType: 'agent_inference' });
  confirmMemory(m.memory.id, { userEvidence: '  \n ' });
  assert.equal(lastEventFor('memory.confirmed', m.memory.id).actor, 'agent');
});

test('the actor user cannot be forged: it exists only alongside evidence', () => {
  const m = capture({ content: 'User probably prefers rebase over merge', sourceType: 'agent_inference' });

  confirmMemory(m.memory.id, {}); // no evidence, no actor parameter exists anymore
  assert.equal(lastEventFor('memory.confirmed', m.memory.id).actor, 'agent');

  const corrected = correctMemory(m.memory.id, 'User prefers merge commits after all', {});
  assert.equal(corrected.memory.sourceType, 'agent_inference');
  assert.equal(lastEventFor('memory.corrected', corrected.memory.id).actor, 'agent');

  const evidenced = correctMemory(corrected.memory.id, 'User prefers rebase, stated explicitly', {
    userEvidence: 'User: "immer rebase"',
  });
  assert.equal(evidenced.memory.sourceType, 'user_statement');
  assert.equal(lastEventFor('memory.corrected', evidenced.memory.id).actor, 'user');
});

test('goals are booked as the agent by default, as the user only with evidence', () => {
  const g1 = createGoal({ title: 'Refactor the retrieval layer' });
  assert.equal(lastEventFor('goal.created', g1.id).actor, 'agent');

  const g2 = createGoal({ title: 'Pass the SBP maths exam', userEvidence: 'User: "Mathe im Oktober ist fix"' });
  assert.equal(lastEventFor('goal.created', g2.id).actor, 'user');

  updateGoal(g1.id, { progress: 0.5 });
  assert.equal(lastEventFor('goal.updated', g1.id).actor, 'agent');

  updateGoal(g2.id, { status: 'completed', progress: 1 }, 'User: "bestanden!"');
  assert.equal(lastEventFor('goal.completed', g2.id).actor, 'user');
});

test('forget is booked honestly', () => {
  const m1 = capture({ content: 'Temporary note about a build flag', sourceType: 'agent_inference' });
  forgetMemory(m1.memory.id, {});
  assert.equal(lastEventFor('memory.deleted', m1.memory.id).actor, 'agent');

  const m2 = capture({ content: 'User old address before the move', sourceType: 'agent_inference' });
  forgetMemory(m2.memory.id, { userEvidence: 'User: "das kannst du vergessen"' });
  assert.equal(lastEventFor('memory.deleted', m2.memory.id).actor, 'user');
  assert.equal(getMemoryById(m2.memory.id).status, 'deleted');
});

test.after(() => closeDb());
