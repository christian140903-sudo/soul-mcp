import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { freshSoulDir } from './helpers.mjs';

freshSoulDir('envelope-v3');

const { exportAll, importAll, importEnvelopeV3, buildEnvelopeV3, isEnvelopeV3, ChecksumMismatchError, UnsupportedSectionError } =
  await import('../dist/src/kernel/transfer.js');
const { capture, getMemoryById } = await import('../dist/src/kernel/memory.js');
const { closeDb } = await import('../dist/src/kernel/db.js');

/** Canonical stringify mirroring transfer.ts (recursively sorted keys). */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = canonical(value[k]);
    return out;
  }
  return value;
}
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/** A 2.0.0 core body (the shape importAll consumes), with one live memory. */
function coreBodyWith(memories) {
  return { memories, identity: [], goals: [], events: [], meta: {} };
}
function memRow(overrides) {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? `mem_env_${Math.random().toString(36).slice(2)}`,
    content: overrides.content,
    contentHash: 'deadbeef',
    type: 'semantic',
    category: 'general',
    tags: [],
    importance: 0.5,
    confidence: 0.5,
    sensitivity: 'personal',
    status: overrides.status ?? 'active',
    namespace: 'default',
    sourceType: 'agent_inference',
    sourceRef: null,
    validFrom: null, validUntil: null, supersedes: null, supersededBy: null,
    contradicts: [], accessCount: 0, usefulCount: 0,
    createdAt: now, updatedAt: now, lastAccessedAt: null, version: 1,
    volatility: 'stable', lastVerifiedAt: null, reviewDueAt: null, verificationRef: null,
  };
}

// ─── valid envelope with only core imports identically to the 2.0.0 path ──

test('envelope with only core imports identically to the 2.0.0 path', () => {
  closeDb();
  process.env.SOUL_DIR = mkdtempSync(join(tmpdir(), 'soul-env-core-'));
  const core = coreBodyWith([memRow({ id: 'mem_env_core_1', content: 'Chriso lives in Vienna' })]);
  const env = buildEnvelopeV3(core);
  assert.ok(isEnvelopeV3(env), 'buildEnvelopeV3 produces a recognizable envelope');

  const result = importEnvelopeV3(env);
  assert.equal(result.memories.imported, 1);
  assert.equal(result.checksumValid, true, 'core body passes the 2.0.0 internal check by construction');
  assert.equal(getMemoryById('mem_env_core_1').content, 'Chriso lives in Vienna');
  assert.equal(result.skipped_sections, undefined, 'no sections skipped when only core is present');

  // Same input through the plain 2.0.0 path yields the same import counts.
  closeDb();
  process.env.SOUL_DIR = mkdtempSync(join(tmpdir(), 'soul-env-core2-'));
  const twoZero = { format: 'soul-passport', version: '2.0.0', exportedAt: new Date().toISOString(),
    checksum: sha256(JSON.stringify(core)), ...core };
  const direct = importAll(twoZero);
  assert.equal(direct.memories.imported, result.memories.imported);
});

// ─── unknown OPTIONAL section: core imports, skip is reported ──────────────

test('envelope with an unknown optional section imports core and reports it skipped', () => {
  closeDb();
  process.env.SOUL_DIR = mkdtempSync(join(tmpdir(), 'soul-env-opt-'));
  const core = coreBodyWith([memRow({ id: 'mem_env_opt_1', content: 'likes espresso' })]);
  const env = buildEnvelopeV3(core, {
    skills: { version: '1', required: false, content: { some: 'future data' } },
  });

  const result = importEnvelopeV3(env);
  assert.equal(result.memories.imported, 1);
  assert.equal(getMemoryById('mem_env_opt_1').content, 'likes espresso');
  assert.deepEqual(result.skipped_sections, [{ name: 'skills', version: '1' }]);
});

// ─── unknown REQUIRED section: refuse, nothing written ─────────────────────

test('envelope with an unknown required section is refused and writes nothing', () => {
  closeDb();
  process.env.SOUL_DIR = mkdtempSync(join(tmpdir(), 'soul-env-req-'));
  const core = coreBodyWith([memRow({ id: 'mem_env_req_1', content: 'should not be imported' })]);
  const env = buildEnvelopeV3(core, {
    receipts: { version: '1', required: true, content: { critical: true } },
  });

  assert.throws(
    () => importEnvelopeV3(env),
    (err) => err instanceof UnsupportedSectionError && /receipts/.test(err.message),
  );
  assert.equal(getMemoryById('mem_env_req_1'), null, 'core is not imported when a required section is unknown');
});

// ─── tamper on the sections list → ChecksumMismatchError ───────────────────

test('tampering with the sections list is caught by the list checksum', () => {
  closeDb();
  process.env.SOUL_DIR = mkdtempSync(join(tmpdir(), 'soul-env-tamper-list-'));
  const core = coreBodyWith([memRow({ id: 'mem_env_tl_1', content: 'original' })]);
  const env = buildEnvelopeV3(core);
  // Flip a bit in the (verified) section list without recomputing the checksum.
  env.sections[0].version = '9.9.9';

  assert.throws(
    () => importEnvelopeV3(env),
    (err) => err instanceof ChecksumMismatchError && /section/.test(err.message),
  );
  assert.equal(getMemoryById('mem_env_tl_1'), null, 'nothing written on a list-checksum mismatch');
});

// ─── tamper on core content (list untouched) → ChecksumMismatchError('core')

test('tampering with core content is caught by the core section hash', () => {
  closeDb();
  process.env.SOUL_DIR = mkdtempSync(join(tmpdir(), 'soul-env-tamper-core-'));
  const core = coreBodyWith([memRow({ id: 'mem_env_tc_1', content: 'original' })]);
  const env = buildEnvelopeV3(core);
  // Change core AFTER the hash was fixed; the list (with the old hash) is intact.
  env.core.memories[0].content = 'tampered';

  assert.throws(
    () => importEnvelopeV3(env),
    (err) => err instanceof ChecksumMismatchError && /core/.test(err.message),
  );
  assert.equal(getMemoryById('mem_env_tc_1'), null, 'nothing written on a core-hash mismatch');
});

// ─── tamper on an unknown optional section: core still imports ─────────────
//
// The 3.2.0 reader CANNOT verify a section it does not understand — it never
// reads that content. Its hash sits in the verified section list, so the
// manipulation stays provable for a 4.0 reader that DOES read it. A 3.2.0
// reader therefore imports core regardless. We assert exactly that.

test('tampering with an unknown optional section still imports core (provable for 4.0)', () => {
  closeDb();
  process.env.SOUL_DIR = mkdtempSync(join(tmpdir(), 'soul-env-tamper-opt-'));
  const core = coreBodyWith([memRow({ id: 'mem_env_to_1', content: 'core survives' })]);
  const env = buildEnvelopeV3(core, {
    skills: { version: '1', required: false, content: { data: 'genuine' } },
  });
  // Tamper the optional content only; its hash in the list stays as-built.
  env.skills = { data: 'tampered' };

  const result = importEnvelopeV3(env);
  assert.equal(result.memories.imported, 1, 'core imports — reader never validates unknown content');
  assert.equal(getMemoryById('mem_env_to_1').content, 'core survives');
  assert.deepEqual(result.skipped_sections, [{ name: 'skills', version: '1' }]);
});

// ─── a plain 2.0.0 passport still imports unchanged ────────────────────────

test('a plain 2.0.0 passport is not an envelope and imports through the old path', () => {
  closeDb();
  process.env.SOUL_DIR = mkdtempSync(join(tmpdir(), 'soul-env-legacy-'));
  const core = coreBodyWith([memRow({ id: 'mem_env_legacy_1', content: 'legacy body' })]);
  const twoZero = { format: 'soul-passport', version: '2.0.0', exportedAt: new Date().toISOString(),
    checksum: sha256(JSON.stringify(core)), ...core };
  assert.equal(isEnvelopeV3(twoZero), false, '2.0.0 is not detected as an envelope');
  const result = importAll(twoZero);
  assert.equal(result.memories.imported, 1);
  assert.equal(getMemoryById('mem_env_legacy_1').content, 'legacy body');
});

// ─── the writer still exports 2.0.0 (F01: reader-only in 3.2.0) ────────────

test('exportAll still writes format 2.0.0, not an envelope', () => {
  closeDb();
  process.env.SOUL_DIR = mkdtempSync(join(tmpdir(), 'soul-env-writer-'));
  capture({ content: 'a memory to export' });
  const passport = exportAll();
  assert.equal(passport.version, '2.0.0', 'writer unchanged — envelope is reader-only in 3.2.0');
  assert.equal(isEnvelopeV3(passport), false);
});

test.after(() => closeDb());

// r2 gate F01: a section is known only as a (name, version) tuple — a validly
// hashed core at a FUTURE version must refuse, never parse with 2.0.0 semantics.
test('envelope with core at an unsupported version refuses fail-closed (nothing written)', () => {
  const before = exportAll({ includeEvents: false }).memories.length;
  const env = buildEnvelopeV3(coreBodyWith([memRow({ id: 'mem_futurecore1', content: 'from the future' })]));
  env.sections = env.sections.map((sec) =>
    sec.name === 'core' ? { ...sec, version: '9.9.9' } : sec
  );
  // re-seal the section list so ONLY the version tuple (not the checksum) is under test
  env.checksum = createHash('sha256').update(JSON.stringify(canonical(env.sections))).digest('hex');
  assert.throws(() => importEnvelopeV3(env), (err) => {
    assert.equal(err.name, 'UnsupportedSectionError');
    assert.match(err.message, /core@9\.9\.9/);
    return true;
  });
  const after = exportAll({ includeEvents: false }).memories.length;
  assert.equal(after, before, 'nothing was written');
});
