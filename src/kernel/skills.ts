/**
 * Declarative Skill-Registry — Soul 4.0 Phase 3.
 *
 * Design rules (SOUL4-PLAN Phase 3, THREAT-MODEL TB5 + §5.5, DECISIONS
 * F04/F06/F07/F08/F10, design/SIGNED-PACK-TRUST.md):
 *
 * - Skills are DATA, never code. Every manifest is validated against the
 *   committed SkillManifest@1 positive grammar (ajv) — anything outside the
 *   grammar is invalid, not "suspicious". A deny layer (secret/injection
 *   screening + URLs outside declared reference fields) sits behind it as
 *   defense in depth.
 * - Skills can NEVER extend rights (monotony law F06/TB9). The schema has no
 *   grant field; this module never touches authority, tools or network.
 * - Lifecycle shadow → canary → promoted → deprecated → revoked is enforced
 *   in code; every skill starts in shadow (local AND pack); revoked is
 *   terminal. Every transition (and every refusal) is a ledger event.
 * - canary → promoted requires an evidence parameter: a STRUCTURAL reference
 *   to eval runs/receipts. Honest limit: in this wave the reference is
 *   checked for shape and recorded, not verified for content — the content
 *   check IS the eval harness (Phase-3 gate acceptance), not this module.
 * - Capsule exposure is task-scoped: getSkillsForTask returns ≤3 promoted
 *   skills, deterministically matched (compatibility vector + token overlap,
 *   no LLM call). shadow is never exposed; canary only via explicit opt-in
 *   (isolated eval/canary runs, TB5.3).
 * - importPack implements SignedPackEnvelope@1: schema validation, Ed25519
 *   verification over the canonical signing header (node:crypto), TOFU key
 *   pinning (unknown key ⇒ refuse fail-closed; pinning is a separate explicit
 *   user action), version monotony per (key_id, pack_name), per-section
 *   hashes. Pack skills always start in shadow.
 *
 * Pack FILE format (a deliberate Phase-3 decision, documented for the gate):
 * SignedPackEnvelope@1 is additionalProperties:false, so the payload cannot
 * live inside the envelope object. A pack file is therefore
 *   { "envelope": <SignedPackEnvelope@1>, "payload": { "<section>": <content> } }
 * The payload is bound to the signature via the per-section hashes in the
 * signed header — exactly the F01 tuple principle.
 */

import { createHash, createPublicKey, verify as cryptoVerify } from 'crypto';
import AjvModule from 'ajv/dist/2020.js';
import { getDb, SOUL_VERSION } from './db.js';
import { appendEvent } from './ledger.js';
import { detectSecret, detectInjection } from './policy.js';
import { cancelRun } from './runs.js';
import { newId, nowIso } from '../util/core.js';
import { SKILL_MANIFEST_SCHEMA, SIGNED_PACK_ENVELOPE_SCHEMA } from './skill-contracts.js';

// ─── Schema validation (ajv, same dialect as the contract tests) ──────

const Ajv2020 = (AjvModule as unknown as { default?: unknown }).default ?? AjvModule;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ajv = new (Ajv2020 as any)({ strict: false, allErrors: true, validateFormats: false });
const validateManifestSchema = ajv.compile(SKILL_MANIFEST_SCHEMA);
const validateEnvelopeSchema = ajv.compile(SIGNED_PACK_ENVELOPE_SCHEMA);

// ─── Types ────────────────────────────────────────────────────────────

export type SkillLifecycle = 'shadow' | 'canary' | 'promoted' | 'deprecated' | 'revoked';

export interface SkillManifest {
  contract: 'SkillManifest@1';
  name: string;
  version: string;
  description: string;
  lifecycle: SkillLifecycle;
  origin: { type: 'local' | 'imported' | 'pack'; pack_signature?: string; imported_at?: string };
  compatibility: {
    models: string[];
    os?: string[];
    required_tools?: string[];
    min_context_tokens?: number;
  };
  environment_fingerprint?: string;
  dependencies?: Array<{ name: string; version_range: string }>;
  body: {
    steps: Array<{ id: string; instruction: string }>;
    rubric?: string[];
    verifier_hints?: string[];
    context_recipe?: { memory_types?: string[]; token_budget?: number };
    io_schema?: Record<string, unknown>;
    references?: Array<{ label: string; target: string; note?: string }>;
  };
  created_at?: string;
}

export interface SkillRow {
  skill_id: string;
  name: string;
  version: string;
  manifest: string;
  lifecycle_state: SkillLifecycle;
  compatibility: string;
  source: 'local' | 'pack';
  publisher_key_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface RefusedResult {
  ok: false;
  refused: true;
  reason: string;
  detail?: string;
}

// ─── Canonicalization + hashing (same rules as transfer.ts / DECISIONS
//     Anhang A: JSON with recursively sorted keys, UTF-8) ──────────────

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function sha256Hex(s: string | Buffer): string {
  return createHash('sha256').update(s).digest('hex');
}

// ─── Semver (minimal, for monotony + min_soul_version only) ───────────

function parseSemver(v: string): { nums: [number, number, number]; pre: string | null } | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v);
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null };
}

/** -1 / 0 / 1. Prerelease sorts below the same release (simple string order among prereleases). */
export function semverCompare(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) throw new Error(`not a semver: ${!pa ? a : b}`);
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i]! !== pb.nums[i]!) return pa.nums[i]! < pb.nums[i]! ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

// ─── Screening (deny layer BEHIND the positive grammar, F07) ──────────

const URL_PATTERN = /\b(?:https?|ftp|file):\/\//i;

/**
 * Returns a refusal reason or null. The grammar already limits what CAN be
 * expressed; this layer catches secrets anywhere in the manifest, stored
 * injection in instruction text, and URLs outside the declared reference
 * fields (references[].target is the ONLY place a URL may live — and it is
 * never auto-loaded, TB5.2).
 */
function screenManifest(m: SkillManifest): string | null {
  const secret = detectSecret(canonicalStringify(m));
  if (secret) return `secret_detected:${secret}`;

  const instructionTexts: string[] = [
    m.description,
    ...m.body.steps.map((s) => s.instruction),
    ...(m.body.rubric ?? []),
    ...(m.body.verifier_hints ?? []),
    ...(m.body.references ?? []).map((r) => `${r.label} ${r.note ?? ''}`),
  ];
  for (const text of instructionTexts) {
    if (detectInjection(text)) return 'injection_pattern';
    if (URL_PATTERN.test(text)) return 'url_outside_references';
  }
  return null;
}

// ─── Manifest validation ──────────────────────────────────────────────

export function validateSkillManifest(doc: unknown): { valid: boolean; errors?: string } {
  const ok = validateManifestSchema(doc);
  if (ok) return { valid: true };
  return { valid: false, errors: JSON.stringify(validateManifestSchema.errors) };
}

// ─── Registration ─────────────────────────────────────────────────────

export interface RegisterSkillResult {
  ok: true;
  skill_id: string;
  name: string;
  version: string;
  lifecycle: 'shadow';
  source: 'local' | 'pack';
}

/**
 * Register a skill. ALWAYS lands in shadow — a manifest claiming another
 * lifecycle is normalized to shadow (start state, not an error) and the
 * original claim is recorded in the ledger event.
 */
export function registerSkill(
  doc: unknown,
  opts: { source?: 'local' | 'pack'; publisherKeyId?: string; actor?: string } = {}
): RegisterSkillResult | RefusedResult {
  const actor = opts.actor ?? 'user';
  const v = validateSkillManifest(doc);
  if (!v.valid) {
    appendEvent('skill.refused', 'skill', null, { reason: 'schema_invalid', errors: v.errors }, { actor });
    return { ok: false, refused: true, reason: 'schema_invalid', detail: v.errors };
  }
  const manifest = structuredClone(doc) as SkillManifest;

  const screenReason = screenManifest(manifest);
  if (screenReason) {
    appendEvent('skill.refused', 'skill', null, {
      reason: screenReason, name: manifest.name, version: manifest.version,
    }, { actor });
    return { ok: false, refused: true, reason: screenReason };
  }

  const db = getDb();
  const existing = db
    .prepare(`SELECT skill_id FROM skills WHERE name = ? AND version = ?`)
    .get(manifest.name, manifest.version) as { skill_id: string } | undefined;
  if (existing) {
    appendEvent('skill.refused', 'skill', existing.skill_id, {
      reason: 'duplicate', name: manifest.name, version: manifest.version,
    }, { actor });
    return {
      ok: false, refused: true, reason: 'duplicate',
      detail: `${manifest.name}@${manifest.version} is already registered (${existing.skill_id}).`,
    };
  }

  const originalLifecycle = manifest.lifecycle;
  manifest.lifecycle = 'shadow'; // TB5.4: every skill starts in shadow, no exceptions
  const skillId = newId('skill');
  const now = nowIso();
  const source = opts.source ?? 'local';

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO skills (skill_id, name, version, manifest, lifecycle_state, compatibility, source, publisher_key_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'shadow', ?, ?, ?, ?, ?)`
    ).run(
      skillId,
      manifest.name,
      manifest.version,
      JSON.stringify(manifest),
      JSON.stringify(manifest.compatibility),
      source,
      opts.publisherKeyId ?? null,
      now,
      now
    );
    appendEvent('skill.registered', 'skill', skillId, {
      name: manifest.name,
      version: manifest.version,
      lifecycle: 'shadow',
      source,
      publisher_key_id: opts.publisherKeyId ?? null,
      ...(originalLifecycle !== 'shadow' ? { original_lifecycle_claim: originalLifecycle } : {}),
    }, { actor });
  });
  tx();

  return { ok: true, skill_id: skillId, name: manifest.name, version: manifest.version, lifecycle: 'shadow', source };
}

// ─── Lifecycle transitions ────────────────────────────────────────────

/**
 * Allowed transitions. shadow→canary is the only way up from shadow;
 * canary→promoted needs evidence; canary→shadow and promoted→canary are the
 * rollback paths; deprecated cannot come back (re-promotion means a new
 * version through the full ladder); revoked is terminal. Everything can be
 * revoked (kill switch) except revoked itself.
 */
const ALLOWED_TRANSITIONS: Record<SkillLifecycle, SkillLifecycle[]> = {
  shadow: ['canary', 'revoked'],
  canary: ['promoted', 'shadow', 'revoked'],
  promoted: ['deprecated', 'canary', 'revoked'],
  deprecated: ['revoked'],
  revoked: [],
};

export interface PromotionEvidence {
  /** structured references to eval runs / receipts (checked for shape, not content — see module header) */
  eval_refs: string[];
}

export interface TransitionResult {
  ok: true;
  skill_id: string;
  name: string;
  version: string;
  from: SkillLifecycle;
  to: SkillLifecycle;
  /** open runs referencing this skill that were cancelled by the rollback sweep */
  cancelled_runs: string[];
}

function findSkill(name: string, version?: string): SkillRow | { ambiguous: string[] } | null {
  const db = getDb();
  if (version) {
    return (db.prepare(`SELECT * FROM skills WHERE name = ? AND version = ?`).get(name, version) as SkillRow | undefined) ?? null;
  }
  const rows = db.prepare(`SELECT * FROM skills WHERE name = ?`).all(name) as SkillRow[];
  if (rows.length === 0) return null;
  if (rows.length > 1) return { ambiguous: rows.map((r) => r.version) };
  return rows[0]!;
}

export function transitionSkill(
  name: string,
  to: SkillLifecycle,
  opts: { version?: string; evidence?: PromotionEvidence; reason?: string; actor?: string } = {}
): TransitionResult | RefusedResult {
  const actor = opts.actor ?? 'user';
  const db = getDb();
  const found = findSkill(name, opts.version);
  if (!found) return { ok: false, refused: true, reason: 'not_found', detail: `No skill named '${name}'${opts.version ? `@${opts.version}` : ''}.` };
  if ('ambiguous' in found) {
    return { ok: false, refused: true, reason: 'ambiguous_version', detail: `Skill '${name}' has versions ${found.ambiguous.join(', ')} — pass one explicitly.` };
  }
  const skill = found;
  const from = skill.lifecycle_state;

  const refuse = (reason: string, detail?: string): RefusedResult => {
    appendEvent('skill.transition_refused', 'skill', skill.skill_id, {
      name: skill.name, version: skill.version, from, to, reason,
    }, { actor });
    return { ok: false, refused: true, reason, detail };
  };

  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    return refuse(
      'transition_not_allowed',
      `${from} → ${to} is not a legal transition (allowed from ${from}: ${ALLOWED_TRANSITIONS[from].join(', ') || 'none — revoked is terminal'}).`
    );
  }

  if (to === 'promoted') {
    const ev = opts.evidence;
    const refsOk =
      ev !== undefined &&
      Array.isArray(ev.eval_refs) &&
      ev.eval_refs.length >= 1 &&
      ev.eval_refs.every((r) => typeof r === 'string' && r.trim().length > 0);
    if (!refsOk) {
      return refuse(
        'evidence_required',
        'canary → promoted requires evidence: { eval_refs: [<eval-run/receipt reference>, …] }. ' +
        'The reference is checked structurally and recorded in the ledger; its CONTENT is verified by the eval harness, not here.'
      );
    }
  }

  // Rollback sweep (SOUL4-PLAN Phase 3: "Rollback inkl. laufender Runs"):
  // leaving 'promoted' (or revoking) cancels open runs whose TaskContract
  // carries a skill_ref to this skill. Honest note: in this wave soul_run's
  // compiled contracts do not attach skill_refs yet, so the sweep usually
  // finds nothing — the mechanism exists and is tested so the invariant
  // holds the day contracts start carrying refs.
  const cancelledRuns: string[] = [];
  if (from === 'promoted' || to === 'revoked') {
    const openRuns = db
      .prepare(`SELECT run_id, task_contract FROM runs WHERE status IN ('queued','running','waiting_verification')`)
      .all() as Array<{ run_id: string; task_contract: string }>;
    for (const r of openRuns) {
      let contract: { skill_refs?: Array<{ name?: string; version?: string }> };
      try {
        contract = JSON.parse(r.task_contract);
      } catch {
        continue;
      }
      const refs = Array.isArray(contract.skill_refs) ? contract.skill_refs : [];
      if (refs.some((ref) => ref?.name === skill.name && (!ref.version || ref.version === skill.version))) {
        const res = cancelRun(r.run_id);
        if (res.cancelled) cancelledRuns.push(r.run_id);
      }
    }
  }

  const now = nowIso();
  const manifest = JSON.parse(skill.manifest) as SkillManifest;
  manifest.lifecycle = to;
  const tx = db.transaction(() => {
    db.prepare(`UPDATE skills SET lifecycle_state = ?, manifest = ?, updated_at = ? WHERE skill_id = ?`)
      .run(to, JSON.stringify(manifest), now, skill.skill_id);
    appendEvent(to === 'revoked' ? 'skill.revoked' : 'skill.lifecycle_changed', 'skill', skill.skill_id, {
      name: skill.name,
      version: skill.version,
      from,
      to,
      ...(opts.evidence ? { evidence: opts.evidence } : {}),
      ...(opts.reason ? { reason: opts.reason } : {}),
      ...(cancelledRuns.length > 0 ? { cancelled_runs: cancelledRuns } : {}),
    }, { actor });
  });
  tx();

  return { ok: true, skill_id: skill.skill_id, name: skill.name, version: skill.version, from, to, cancelled_runs: cancelledRuns };
}

// ─── Task-scoped capsule selection (TB5.3: ≤3, deterministic) ─────────

export interface CapsuleSkill {
  name: string;
  version: string;
  description: string;
  source: 'local' | 'pack';
  lifecycle: SkillLifecycle;
  reason: string;
  steps: Array<{ id: string; instruction: string }>;
  rubric?: string[];
}

const MAX_SKILLS_PER_CAPSULE = 3;

function tokenize(s: string): Set<string> {
  return new Set(
    s.toLowerCase().split(/[^a-z0-9äöüß]+/).filter((t) => t.length > 2)
  );
}

/** Glob match for compatibility.models entries like "claude-*". */
function modelMatches(patterns: string[], modelHint: string): boolean {
  const hint = modelHint.toLowerCase();
  return patterns.some((p) => {
    const rx = new RegExp('^' + p.toLowerCase().split('*').map(escapeRx).join('.*') + '$');
    return rx.test(hint);
  });
}

function escapeRx(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Deterministic selection: promoted skills only (canary ONLY via explicit
 * opt-in for isolated eval/canary runs — soul_context never sets it), whose
 * compatibility vector matches (model glob when a hint exists, OS when
 * declared, min_context_tokens within the budget when given), ranked by
 * token overlap between the task text and the skill's name+description.
 * No overlap → no exposure. Ties break on name, then newest version.
 */
export function getSkillsForTask(
  task: string,
  opts: { modelHint?: string; tokenBudget?: number; includeCanary?: boolean; limit?: number } = {}
): CapsuleSkill[] {
  const db = getDb();
  const states = opts.includeCanary ? ['promoted', 'canary'] : ['promoted'];
  const rows = db
    .prepare(`SELECT * FROM skills WHERE lifecycle_state IN (${states.map(() => '?').join(',')})`)
    .all(...states) as SkillRow[];
  if (rows.length === 0) return [];

  const taskTokens = tokenize(task);
  const scored: Array<{ row: SkillRow; manifest: SkillManifest; score: number }> = [];
  for (const row of rows) {
    let manifest: SkillManifest;
    try {
      manifest = JSON.parse(row.manifest) as SkillManifest;
    } catch {
      continue;
    }
    const compat = manifest.compatibility;
    if (opts.modelHint && !modelMatches(compat.models, opts.modelHint)) continue;
    if (compat.os && compat.os.length > 0 && !compat.os.includes(process.platform)) continue;
    if (
      opts.tokenBudget !== undefined &&
      compat.min_context_tokens !== undefined &&
      compat.min_context_tokens > opts.tokenBudget
    ) continue;

    const skillTokens = tokenize(`${manifest.name.split('-').join(' ')} ${manifest.description}`);
    let score = 0;
    for (const t of taskTokens) if (skillTokens.has(t)) score++;
    if (score >= 1) scored.push({ row, manifest, score });
  }

  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.row.name !== b.row.name) return a.row.name < b.row.name ? -1 : 1;
    return semverCompare(b.row.version, a.row.version);
  });

  const limit = Math.min(opts.limit ?? MAX_SKILLS_PER_CAPSULE, MAX_SKILLS_PER_CAPSULE);
  return scored.slice(0, limit).map(({ row, manifest, score }) => ({
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    source: row.source,
    lifecycle: row.lifecycle_state,
    reason: `matches the task keywords (overlap ${score}); lifecycle ${row.lifecycle_state}`,
    steps: manifest.body.steps,
    ...(manifest.body.rubric ? { rubric: manifest.body.rubric } : {}),
  }));
}

export function listSkills(): Array<{
  skill_id: string; name: string; version: string; lifecycle: SkillLifecycle;
  source: string; publisher_key_id: string | null; description: string; updated_at: string;
}> {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM skills ORDER BY name ASC, version ASC`).all() as SkillRow[];
  return rows.map((r) => {
    let description = '';
    try { description = (JSON.parse(r.manifest) as SkillManifest).description; } catch { /* keep empty */ }
    return {
      skill_id: r.skill_id, name: r.name, version: r.version,
      lifecycle: r.lifecycle_state, source: r.source,
      publisher_key_id: r.publisher_key_id, description, updated_at: r.updated_at,
    };
  });
}

// ─── Signed packs: Ed25519 + TOFU + monotony (SIGNED-PACK-TRUST) ──────

export interface SignedPackEnvelope {
  contract: 'SignedPackEnvelope@1';
  pack_name: string;
  pack_version: string;
  publisher: { key_id: string; algo: 'ed25519'; pubkey: string };
  sections: Array<{ name: string; version: string; hash: string; required: boolean }>;
  signature: string;
  created_at: string;
  min_soul_version: string;
}

export interface PackFile {
  envelope: SignedPackEnvelope;
  payload: Record<string, unknown>;
}

function rawPubkeyBytes(pubkey: string): Buffer | null {
  const m = /^ed25519:([A-Za-z0-9+/]{43}=)$/.exec(pubkey);
  if (!m) return null;
  const raw = Buffer.from(m[1]!, 'base64');
  return raw.length === 32 ? raw : null;
}

/** key_id = SHA-256 fingerprint of the raw 32 pubkey bytes (SIGNED-PACK-TRUST §1). */
export function keyIdOf(pubkey: string): string | null {
  const raw = rawPubkeyBytes(pubkey);
  if (!raw) return null;
  return `sha256:${sha256Hex(raw)}`;
}

/** The canonical signing header — exactly the fields listed in SIGNED-PACK-TRUST §2. */
export function signingHeader(env: SignedPackEnvelope): string {
  return canonicalStringify({
    pack_name: env.pack_name,
    pack_version: env.pack_version,
    publisher: env.publisher,
    sections: env.sections,
    created_at: env.created_at,
    min_soul_version: env.min_soul_version,
  });
}

function verifyEnvelopeSignature(env: SignedPackEnvelope): boolean {
  const raw = rawPubkeyBytes(env.publisher.pubkey);
  if (!raw) return false;
  const sigMatch = /^ed25519:([A-Za-z0-9+/]{86}==)$/.exec(env.signature);
  if (!sigMatch) return false;
  const sig = Buffer.from(sigMatch[1]!, 'base64');
  if (sig.length !== 64) return false;
  try {
    // Raw Ed25519 pubkey → SPKI DER (fixed 12-byte prefix for Ed25519).
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]);
    const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    return cryptoVerify(null, Buffer.from(signingHeader(env), 'utf8'), key, sig);
  } catch {
    return false;
  }
}

export interface PinKeyResult {
  ok: true;
  key_id: string;
  already_pinned: boolean;
}

/**
 * Pin a publisher key (TOFU). This is a SEPARATE explicit user action — the
 * import path never pins. Verifies key_id === sha256(raw pubkey bytes) so a
 * mislabeled fingerprint can never be pinned.
 */
export function pinTrustedKey(input: { keyId: string; pubkey: string; label?: string; actor?: string }): PinKeyResult | RefusedResult {
  const actor = input.actor ?? 'user';
  const computed = keyIdOf(input.pubkey);
  if (!computed) return { ok: false, refused: true, reason: 'pubkey_malformed' };
  if (computed !== input.keyId) {
    return {
      ok: false, refused: true, reason: 'key_id_mismatch',
      detail: `key_id ${input.keyId} does not match the pubkey fingerprint ${computed}.`,
    };
  }
  const db = getDb();
  const existing = db.prepare(`SELECT pubkey FROM trusted_keys WHERE key_id = ?`).get(input.keyId) as { pubkey: string } | undefined;
  if (existing) {
    if (existing.pubkey !== input.pubkey) {
      // structurally impossible while key_id is the pubkey hash — defense in depth
      return { ok: false, refused: true, reason: 'pinned_key_conflict' };
    }
    return { ok: true, key_id: input.keyId, already_pinned: true };
  }
  db.prepare(`INSERT INTO trusted_keys (key_id, pubkey, pinned_at, label) VALUES (?, ?, ?, ?)`)
    .run(input.keyId, input.pubkey, nowIso(), input.label ?? null);
  appendEvent('key.pinned', 'trusted_key', input.keyId, { label: input.label ?? null, verified: 'tofu' }, { actor });
  return { ok: true, key_id: input.keyId, already_pinned: false };
}

export interface ImportPackResult {
  ok: true;
  pack_name: string;
  pack_version: string;
  key_id: string;
  skills_registered: Array<{ name: string; version: string; skill_id: string; lifecycle: 'shadow' }>;
  sections_skipped: string[];
}

/**
 * Import a signed skill pack — fail-closed at every step. Refusal order:
 * schema → key_id/pubkey consistency → SECTION GRAMMAR (sorted by
 * (name, version) tuple, duplicate-free — normative per SIGNED-PACK-TRUST §2,
 * enforced BEFORE the signature check, never silently normalized) → key
 * pinned (TOFU) → signature → min_soul_version → version monotony → section
 * hashes → unknown required section → per-skill manifest validation/
 * screening. Known sections are (name, version) TUPLES (F01): this reader
 * knows exactly ('skills','1') — a required 'skills' section with a foreign
 * version is refused fail-closed, an optional one is skipped.
 * Every refusal is a pack.refused ledger event; success is pack.imported.
 */
export function importPack(doc: unknown, opts: { actor?: string } = {}): ImportPackResult | RefusedResult {
  const actor = opts.actor ?? 'user';
  const refuse = (reason: string, detail?: string, extra: Record<string, unknown> = {}): RefusedResult => {
    appendEvent('pack.refused', 'pack', null, { reason, ...(detail ? { detail } : {}), ...extra }, { actor });
    return { ok: false, refused: true, reason, detail };
  };

  if (doc === null || typeof doc !== 'object' || !('envelope' in doc)) {
    return refuse('pack_file_malformed', 'Expected { envelope: SignedPackEnvelope@1, payload: {…} }.');
  }
  const envelope = (doc as PackFile).envelope;
  const rawPayload = (doc as PackFile).payload ?? {};
  if (typeof rawPayload !== 'object' || rawPayload === null || Array.isArray(rawPayload)) {
    return refuse('pack_file_malformed', 'payload must be an object keyed by section name.');
  }
  const payload = rawPayload as Record<string, unknown>;

  if (!validateEnvelopeSchema(envelope)) {
    return refuse('envelope_schema_invalid', JSON.stringify(validateEnvelopeSchema.errors));
  }
  const env = envelope as SignedPackEnvelope;

  // key_id must BE the fingerprint of the transported pubkey
  const computedKeyId = keyIdOf(env.publisher.pubkey);
  if (!computedKeyId || computedKeyId !== env.publisher.key_id) {
    return refuse('key_id_mismatch', `Envelope key_id ${env.publisher.key_id} does not match pubkey fingerprint ${computedKeyId ?? 'unparseable'}.`);
  }

  // Section grammar (SIGNED-PACK-TRUST §2, normative): sections MUST arrive
  // sorted by the (name, version) tuple ascending and duplicate-free.
  // Enforced BEFORE the signature check and never silently normalized — two
  // byte-representations of the same signed header being both acceptable
  // would be canonicalization ambiguity, i.e. attack surface.
  for (let i = 1; i < env.sections.length; i++) {
    const prev = env.sections[i - 1]!;
    const cur = env.sections[i]!;
    if (prev.name === cur.name && prev.version === cur.version) {
      return refuse('duplicate_section', `Section ('${cur.name}', '${cur.version}') appears twice — ambiguous under one signature.`);
    }
    if (prev.name > cur.name || (prev.name === cur.name && prev.version > cur.version)) {
      return refuse('sections_not_sorted', 'sections must be sorted ascending by the (name, version) tuple (canonical form; refused, never normalized).');
    }
  }

  // TOFU: unknown key ⇒ refuse fail-closed; pinning is a separate action
  const db = getDb();
  const pinned = db.prepare(`SELECT pubkey FROM trusted_keys WHERE key_id = ?`).get(env.publisher.key_id) as { pubkey: string } | undefined;
  if (!pinned) {
    return refuse(
      'unknown_publisher_key',
      `Publisher key ${env.publisher.key_id} is not pinned. Verify the fingerprint out-of-band, then pin it explicitly (soul-mcp skill pin <pack.json>).`,
      { key_id: env.publisher.key_id }
    );
  }
  if (pinned.pubkey !== env.publisher.pubkey) {
    return refuse('pinned_key_conflict', `Pinned pubkey for ${env.publisher.key_id} differs from the envelope's pubkey.`);
  }

  if (!verifyEnvelopeSignature(env)) {
    return refuse('signature_invalid', 'Ed25519 signature over the canonical signing header does not verify.');
  }

  if (semverCompare(SOUL_VERSION, env.min_soul_version) < 0) {
    return refuse('min_soul_version_unmet', `Pack requires soul >= ${env.min_soul_version}, this is ${SOUL_VERSION}.`);
  }

  // Version monotony per (key_id, pack_name): equal or lower ⇒ refuse.
  const prev = db
    .prepare(`SELECT highest_version FROM pack_versions WHERE key_id = ? AND pack_name = ?`)
    .get(env.publisher.key_id, env.pack_name) as { highest_version: string } | undefined;
  if (prev && semverCompare(env.pack_version, prev.highest_version) <= 0) {
    return refuse(
      'version_not_monotonic',
      `Pack ${env.pack_name}@${env.pack_version} does not exceed the recorded ${prev.highest_version} for this publisher — downgrade/replay refused.`
    );
  }

  // Per-section hash check for KNOWN sections; unknown required ⇒ refuse.
  // Known = (name, version) TUPLE (F01 semantics): a known name with a
  // foreign version is NOT known — required ⇒ refuse, optional ⇒ skip.
  const KNOWN_SECTIONS = new Set(['skills@1']);
  const sectionsSkipped: string[] = [];
  for (const s of env.sections) {
    if (!KNOWN_SECTIONS.has(`${s.name}@${s.version}`)) {
      if (s.required) return refuse('unknown_required_section', `Section ('${s.name}', '${s.version}') is required but this reader does not know that (name, version) tuple.`);
      sectionsSkipped.push(`${s.name}@${s.version}`);
      continue;
    }
    if (!(s.name in payload)) {
      return refuse('section_payload_missing', `Section '${s.name}' is listed in the envelope but missing from the payload.`);
    }
    const got = `sha256:${sha256Hex(canonicalStringify(payload[s.name]))}`;
    if (got !== s.hash) {
      return refuse('section_hash_mismatch', `Section '${s.name}': payload hash ${got} != signed ${s.hash}.`);
    }
  }

  const skillsSection = env.sections.find((s) => s.name === 'skills' && s.version === '1');
  const manifests = skillsSection ? (payload['skills'] as unknown) : [];
  if (skillsSection && !Array.isArray(manifests)) {
    return refuse('skills_section_malformed', 'payload.skills must be an array of SkillManifest@1 objects.');
  }

  // Register all skills + bump the monotony record in ONE transaction —
  // a single bad manifest refuses the whole pack (fail-closed, no partials).
  const registered: ImportPackResult['skills_registered'] = [];
  const now = nowIso();
  try {
    const tx = db.transaction(() => {
      for (const m of manifests as unknown[]) {
        const r = registerSkill(m, { source: 'pack', publisherKeyId: env.publisher.key_id, actor });
        if (!r.ok) {
          throw new Error(`skill refused (${r.reason}${r.detail ? `: ${r.detail}` : ''})`);
        }
        registered.push({ name: r.name, version: r.version, skill_id: r.skill_id, lifecycle: 'shadow' });
      }
      db.prepare(
        `INSERT INTO pack_versions (key_id, pack_name, highest_version, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(key_id, pack_name) DO UPDATE SET highest_version = excluded.highest_version, updated_at = excluded.updated_at`
      ).run(env.publisher.key_id, env.pack_name, env.pack_version, now);
      appendEvent('pack.imported', 'pack', `${env.publisher.key_id}/${env.pack_name}`, {
        pack_name: env.pack_name,
        pack_version: env.pack_version,
        key_id: env.publisher.key_id,
        skills: registered.map((s) => `${s.name}@${s.version}`),
        sections_skipped: sectionsSkipped,
      }, { actor });
    });
    tx();
  } catch (error) {
    return refuse('skill_in_pack_refused', String(error instanceof Error ? error.message : error), {
      pack_name: env.pack_name, pack_version: env.pack_version, key_id: env.publisher.key_id,
    });
  }

  return {
    ok: true,
    pack_name: env.pack_name,
    pack_version: env.pack_version,
    key_id: env.publisher.key_id,
    skills_registered: registered,
    sections_skipped: sectionsSkipped,
  };
}
