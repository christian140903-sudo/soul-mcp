/**
 * Export / import ("Soul Passport", local file edition).
 *
 * Guarantees:
 * - export -> import into an empty Soul reproduces memories, identity, goals
 *   and the event ledger with timestamps and counters intact,
 * - import is idempotent: re-importing the same file changes nothing
 *   (matched by memory id, goal id and identity aspect),
 * - a checksum over the payload detects truncated/corrupted files.
 */

import { createHash } from 'crypto';
import { getDb } from './db.js';
import { appendEvent } from './ledger.js';
import { rowToMemory, capture, type Memory } from './memory.js';
import { getAllIdentity, setIdentityFacet, type IdentityFacet } from './identity.js';
import { detectSecret, detectInjection, classifySensitiveCategory, storeRuleFor } from './policy.js';
import { type Goal } from './goals.js';
import { nowIso } from '../util/core.js';

/** Statuses at which an imported memory would become live (recallable). */
const LIVE_STATUSES = new Set(['candidate', 'active', 'confirmed', 'disputed']);

export interface SoulExportV2 {
  format: 'soul-passport';
  version: '2.0.0';
  exportedAt: string;
  checksum: string;
  memories: Memory[];
  identity: IdentityFacet[];
  goals: Goal[];
  events: Array<Record<string, unknown>>;
  meta: Record<string, string>;
  /** since 3.0.1 — the detectors' long-term verdict memory travels with the soul */
  workbench_decisions?: Array<Record<string, unknown>>;
  /** since 3.0.1 — the calibration record travels with the soul */
  predictions?: Array<Record<string, unknown>>;
  /** since 3.1 — the session diary travels with the soul */
  session_reflections?: Array<Record<string, unknown>>;
  /** since 3.1 — which client/model wrote what (referenced by predictions) */
  client_sessions?: Array<Record<string, unknown>>;
  // DELIBERATE: retrieval_impressions are NOT part of the passport — they are
  // local measurement data (ranks/signals for retrieval evaluation), not soul
  // substance, and do not survive a transfer.
}

export function exportAll(opts: { includeEvents?: boolean } = {}): SoulExportV2 {
  const db = getDb();
  const memories = (db.prepare(`SELECT * FROM memories ORDER BY created_at ASC`).all() as any[]).map(rowToMemory);
  const identity = getAllIdentity();
  const goals = (db.prepare(`SELECT * FROM goals ORDER BY created_at ASC`).all() as any[]).map((row) => ({
    id: row.id,
    title: row.title,
    description: row.description,
    kind: row.kind,
    status: row.status,
    priority: row.priority,
    progress: row.progress,
    dueAt: row.due_at,
    parentId: row.parent_id,
    namespace: row.namespace,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
  const events = opts.includeEvents === false
    ? []
    : (db.prepare(`SELECT * FROM events ORDER BY seq ASC`).all() as any[]);
  const metaRows = db.prepare(`SELECT key, value FROM meta`).all() as Array<{ key: string; value: string }>;
  const meta: Record<string, string> = {};
  for (const r of metaRows) meta[r.key] = r.value;

  const workbench_decisions = db
    .prepare(`SELECT * FROM workbench_decisions ORDER BY created_at ASC`)
    .all() as Array<Record<string, unknown>>;
  const predictions = db
    .prepare(`SELECT * FROM predictions ORDER BY created_at ASC`)
    .all() as Array<Record<string, unknown>>;
  const session_reflections = db
    .prepare(`SELECT * FROM session_reflections ORDER BY created_at ASC`)
    .all() as Array<Record<string, unknown>>;
  const client_sessions = db
    .prepare(`SELECT * FROM client_sessions ORDER BY started_at ASC`)
    .all() as Array<Record<string, unknown>>;

  const body = { memories, identity, goals, events, meta, workbench_decisions, predictions, session_reflections, client_sessions };
  const checksum = createHash('sha256').update(JSON.stringify(body)).digest('hex');

  appendEvent('data.exported', 'system', null, {
    memories: memories.length,
    identity: identity.length,
    goals: goals.length,
    events: events.length,
    workbench_decisions: workbench_decisions.length,
    predictions: predictions.length,
  });

  return {
    format: 'soul-passport',
    version: '2.0.0',
    exportedAt: nowIso(),
    checksum,
    ...body,
  };
}

export interface ImportResult {
  memories: { imported: number; skipped: number };
  identity: { imported: number; skipped: number };
  goals: { imported: number; skipped: number };
  events: { imported: number; skipped: number };
  workbench_decisions: { imported: number; skipped: number };
  predictions: { imported: number; skipped: number };
  session_reflections: { imported: number; skipped: number };
  client_sessions: { imported: number; skipped: number };
  checksumValid: boolean;
  /** Live memories screened on import (3.1.1): the same guards capture() applies. */
  screened: {
    secrets_dropped: number;
    quarantined: number;
    provenance_downgraded: number;
  };
  /**
   * Present only for PassportEnvelope@3 imports (3.2.0): unknown OPTIONAL
   * sections this reader could not interpret and therefore skipped. Their
   * hashes were in the verified section list, so tampering stays provable.
   */
  skipped_sections?: Array<{ name: string; version: string }>;
}

/** Thrown when the passport checksum does not verify. Import is refused (3.1.1). */
export class ChecksumMismatchError extends Error {
  constructor(where?: string) {
    super(
      (where
        ? `Passport section '${where}' checksum does not verify — `
        : 'Passport checksum does not verify — ') +
        'the file was modified or corrupted after export. ' +
        'Import refused. Re-export from the source soul, or restore an untampered copy.'
    );
    this.name = 'ChecksumMismatchError';
  }
}

/**
 * Thrown when a PassportEnvelope@3 carries a required section this reader does
 * not understand. fail-closed: refuse rather than import a soul we can only
 * partially validate (F01). Import is refused, nothing is written.
 */
export class UnsupportedSectionError extends Error {
  readonly reason = 'unsupported_required_section';
  constructor(sectionName: string) {
    super(
      `Passport requires section '${sectionName}', which this reader (3.2.0) does not understand. ` +
        'Import refused. Use a reader that supports this section, or re-export without it.'
    );
    this.name = 'UnsupportedSectionError';
  }
}

// ─── PassportEnvelope@3 reader (F01 / SOUL4-DECISIONS §Anhang A) ───────────
//
// 3.2.0 ships the READER only; exportAll() still writes 2.0.0. The point is
// timing: the first fail-closed importer in the wild already understands the
// 4.0 sectioned format, so forward-compat needs no later major (SOUL4 §F01).
//
// Envelope shape:
//   { format:'soul-passport', version:'3.0.0', exportedAt,
//     sections:[{name,version,hash:'sha256:…',required}]  // sorted by name
//     checksum: sha256 over canonical JSON of `sections`,
//     core: {…the 2.0.0 body…}, <sectionName>: {…}, … }
//
// Reader rule: verify the section-list checksum → verify every KNOWN section's
// hash → an unknown REQUIRED section refuses → an unknown OPTIONAL section is
// skipped (its hash is in the verified list, so tampering stays provable for a
// more capable reader). In 3.2.0 the only known section is 'core'.

/** The sections a 3.2.0 reader can validate and import. */
// A section is "known" only as a (name, version) tuple (r2 gate F01): a
// validly-hashed core@<future-version> must NOT be parsed with 2.0.0
// semantics. Unknown version of a known name = unknown section.
const KNOWN_SECTIONS: Record<string, ReadonlySet<string>> = {
  core: new Set(['2.0.0']),
};
function isKnownSection(name: string, version: string): boolean {
  return KNOWN_SECTIONS[name]?.has(version) ?? false;
}

interface EnvelopeSectionRef {
  name: string;
  version: string;
  hash: string;
  required: boolean;
}

export interface SoulEnvelopeV3 {
  format: 'soul-passport';
  version: '3.0.0';
  exportedAt: string;
  sections: EnvelopeSectionRef[];
  checksum: string;
  [sectionName: string]: unknown;
}

/**
 * Canonical JSON: object keys sorted recursively, so the same logical value
 * always hashes to the same bytes regardless of key order in the source file.
 * Arrays keep their order (it is semantic — e.g. the sorted section list).
 */
function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Is this parsed object a PassportEnvelope@3 (as opposed to a 2.0.0 body)? */
export function isEnvelopeV3(data: unknown): data is SoulEnvelopeV3 {
  return (
    !!data &&
    typeof data === 'object' &&
    (data as any).format === 'soul-passport' &&
    (data as any).version === '3.0.0' &&
    Array.isArray((data as any).sections)
  );
}

/**
 * Read a PassportEnvelope@3, validate every section it is responsible for, and
 * import the 'core' section through the unchanged 2.0.0 path (importAll).
 *
 * The core body inside an envelope carries NO inner 2.0.0 `checksum` — the
 * envelope's section hash IS its integrity proof. To reuse importAll verbatim
 * (screening, downgrades, idempotency all unchanged) without a second checksum
 * scheme, we compute the exact 2.0.0 checksum the core body would have and
 * attach it before delegating. importAll's internal check then passes by
 * construction; the real integrity gate already ran here against the section
 * hash. One integrity mechanism per byte, no double-checksum logic.
 */
export function importEnvelopeV3(env: SoulEnvelopeV3): ImportResult {
  // (a) The section list is the root of trust — verify its checksum first.
  const listChecksum = sha256Hex(canonicalStringify(env.sections));
  if (env.checksum !== listChecksum) {
    appendEvent('data.imported', 'system', null, {
      refused: true,
      reason: 'checksum_mismatch',
      envelope: '3.0.0',
      where: 'sections',
    });
    throw new ChecksumMismatchError('sections');
  }

  // (b/c) Walk the verified list: validate known sections, decide on unknown.
  const skipped: Array<{ name: string; version: string }> = [];
  let coreRef: EnvelopeSectionRef | undefined;

  for (const ref of env.sections) {
    if (isKnownSection(ref.name, ref.version)) {
      // (b) Known section: hash its content and compare against the list.
      const content = env[ref.name];
      const want = ref.hash.startsWith('sha256:') ? ref.hash.slice('sha256:'.length) : ref.hash;
      const got = sha256Hex(canonicalStringify(content));
      if (got !== want) {
        appendEvent('data.imported', 'system', null, {
          refused: true,
          reason: 'checksum_mismatch',
          envelope: '3.0.0',
          where: ref.name,
        });
        throw new ChecksumMismatchError(ref.name);
      }
      if (ref.name === 'core') coreRef = ref;
    } else if (ref.required) {
      // (c) Unknown (name,version) + required → fail-closed refusal, nothing
      // written. This includes a known NAME at an unsupported version.
      appendEvent('data.imported', 'system', null, {
        refused: true,
        reason: 'unsupported_required_section',
        envelope: '3.0.0',
        section: ref.name,
        section_version: ref.version,
      });
      throw new UnsupportedSectionError(`${ref.name}@${ref.version}`);
    } else {
      // Unknown + optional → skip. We deliberately do NOT hash its content:
      // the reader cannot interpret it, but its hash sits in the now-verified
      // section list, so any tampering stays provable for a 4.0 reader that
      // DOES read it. A 3.2.0 reader never touches that content.
      skipped.push({ name: ref.name, version: ref.version });
      appendEvent('import.section_skipped', 'system', null, {
        envelope: '3.0.0',
        section: ref.name,
        version: ref.version,
        reason: 'unknown optional section — not understood by reader 3.2.0',
      });
    }
  }

  if (!coreRef) {
    // A passport with no core section carries no soul to import. Treat a
    // required-but-absent core as a malformed envelope.
    throw new Error("PassportEnvelope@3 has no 'core' section — nothing to import.");
  }

  // Delegate the verified core body through the unchanged 2.0.0 import path.
  // Recompute the 2.0.0 checksum so importAll's internal check passes; the
  // envelope's section hash was the real integrity gate (see doc-comment).
  const coreBody = env.core as Record<string, unknown>;
  const twoZeroBody: Record<string, unknown> = {
    memories: coreBody.memories ?? [],
    identity: coreBody.identity ?? [],
    goals: coreBody.goals ?? [],
    events: coreBody.events ?? [],
    meta: coreBody.meta ?? {},
  };
  if (coreBody.workbench_decisions !== undefined) twoZeroBody.workbench_decisions = coreBody.workbench_decisions;
  if (coreBody.predictions !== undefined) twoZeroBody.predictions = coreBody.predictions;
  if (coreBody.session_reflections !== undefined) twoZeroBody.session_reflections = coreBody.session_reflections;
  if (coreBody.client_sessions !== undefined) twoZeroBody.client_sessions = coreBody.client_sessions;
  const innerChecksum = createHash('sha256').update(JSON.stringify(twoZeroBody)).digest('hex');

  const coreV2: SoulExportV2 = {
    ...(coreBody as any),
    format: 'soul-passport',
    version: '2.0.0',
    checksum: innerChecksum,
  };

  const result = importAll(coreV2);
  if (skipped.length) result.skipped_sections = skipped;
  return result;
}

/**
 * TEST/TOOLING HELPER — builds a valid PassportEnvelope@3 around a 2.0.0 core
 * body (and optional extra sections). NOT used by exportAll (which stays at
 * 2.0.0); it exists so tests can produce well-formed envelopes and so the 4.0
 * writer can reuse the canonical hashing/list-building logic. Each extra
 * section supplies its own {version, required, content}; its hash is computed
 * here so the envelope is internally consistent by construction.
 */
export function buildEnvelopeV3(
  coreBody: Record<string, unknown>,
  extraSections: Record<string, { version: string; required: boolean; content: unknown }> = {}
): SoulEnvelopeV3 {
  const refs: EnvelopeSectionRef[] = [
    { name: 'core', version: '2.0.0', hash: `sha256:${sha256Hex(canonicalStringify(coreBody))}`, required: true },
  ];
  for (const [name, spec] of Object.entries(extraSections)) {
    refs.push({
      name,
      version: spec.version,
      hash: `sha256:${sha256Hex(canonicalStringify(spec.content))}`,
      required: spec.required,
    });
  }
  refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const env: SoulEnvelopeV3 = {
    format: 'soul-passport',
    version: '3.0.0',
    exportedAt: nowIso(),
    sections: refs,
    checksum: sha256Hex(canonicalStringify(refs)),
    core: coreBody,
  };
  for (const [name, spec] of Object.entries(extraSections)) env[name] = spec.content;
  return env;
}

export function importAll(data: SoulExportV2): ImportResult {
  const db = getDb();
  if (data.format !== 'soul-passport') {
    throw new Error(`Unknown export format: ${(data as any).format ?? 'missing'}. Expected 'soul-passport'.`);
  }
  // The checksum body mirrors exactly the fields present in the file, so
  // passports exported before 3.0.1 (without decisions/predictions) still
  // verify against their original checksum.
  const body: Record<string, unknown> = {
    memories: data.memories ?? [],
    identity: data.identity ?? [],
    goals: data.goals ?? [],
    events: data.events ?? [],
    meta: data.meta ?? {},
  };
  if (data.workbench_decisions !== undefined) body.workbench_decisions = data.workbench_decisions;
  if (data.predictions !== undefined) body.predictions = data.predictions;
  if (data.session_reflections !== undefined) body.session_reflections = data.session_reflections;
  if (data.client_sessions !== undefined) body.client_sessions = data.client_sessions;
  const checksumValid =
    data.checksum === createHash('sha256').update(JSON.stringify(body)).digest('hex');

  // 3.1.1: a checksum mismatch means the file was altered after export. An
  // import that trusts ids, provenance and status verbatim must not run on
  // unverified data — refuse instead of importing with a warning flag.
  if (!checksumValid) {
    appendEvent('data.imported', 'system', null, { refused: true, reason: 'checksum_mismatch' });
    throw new ChecksumMismatchError();
  }

  const result: ImportResult = {
    memories: { imported: 0, skipped: 0 },
    identity: { imported: 0, skipped: 0 },
    goals: { imported: 0, skipped: 0 },
    events: { imported: 0, skipped: 0 },
    workbench_decisions: { imported: 0, skipped: 0 },
    predictions: { imported: 0, skipped: 0 },
    session_reflections: { imported: 0, skipped: 0 },
    client_sessions: { imported: 0, skipped: 0 },
    checksumValid,
    screened: { secrets_dropped: 0, quarantined: 0, provenance_downgraded: 0 },
  };

  const memExists = db.prepare(`SELECT 1 FROM memories WHERE id = ?`);
  const insertMem = db.prepare(
    `INSERT INTO memories (
      id, content, content_hash, type, category, tags, importance, confidence,
      sensitivity, status, namespace, source_type, source_ref, valid_from, valid_until,
      supersedes, superseded_by, contradicts, access_count, useful_count,
      created_at, updated_at, last_accessed_at, version,
      volatility, last_verified_at, review_due_at, verification_ref
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const identityExists = db.prepare(`SELECT 1 FROM identity WHERE aspect = ? AND namespace = ?`);
  const insertIdentity = db.prepare(
    `INSERT INTO identity (aspect, namespace, value, confidence, evidence, status, source_type, first_seen, last_updated)
     VALUES (?,?,?,?,?,?,?,?,?)`
  );
  const goalExists = db.prepare(`SELECT 1 FROM goals WHERE id = ?`);
  const insertGoal = db.prepare(
    `INSERT INTO goals (id, title, description, kind, status, priority, progress, due_at, parent_id, namespace, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  // events are matched by (recorded_at, event_type, entity_id) — sequence
  // numbers are local to each database and not portable
  const eventExists = db.prepare(
    `SELECT 1 FROM events WHERE recorded_at = ? AND event_type = ? AND (entity_id = ? OR (entity_id IS NULL AND ? IS NULL))`
  );
  const insertEvent = db.prepare(
    `INSERT INTO events (event_type, entity_type, entity_id, payload, actor, recorded_at, valid_from, valid_until)
     VALUES (?,?,?,?,?,?,?,?)`
  );
  const decisionExists = db.prepare(`SELECT 1 FROM workbench_decisions WHERE id = ?`);
  const insertDecision = db.prepare(
    `INSERT INTO workbench_decisions
       (id, kind, subject_key, subject_revision, outcome, terminal, next_review_at, assignment_id, actor, reasoning, created_at, invalidated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const predictionExists = db.prepare(`SELECT 1 FROM predictions WHERE id = ?`);
  const insertPrediction = db.prepare(
    `INSERT INTO predictions (id, claim, probability, due_at, namespace, model_hint, created_at, resolved_at, outcome,
       decision_id, domain, client_session_id, resolution_actor, evidence_ref)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const reflectionExists = db.prepare(`SELECT 1 FROM session_reflections WHERE id = ?`);
  const insertReflection = db.prepare(
    `INSERT INTO session_reflections (id, session_number, summary, learnings_count, client_session_id, created_at)
     VALUES (?,?,?,?,?,?)`
  );
  const clientSessionExists = db.prepare(`SELECT 1 FROM client_sessions WHERE id = ?`);
  const insertClientSession = db.prepare(
    `INSERT INTO client_sessions (id, client_name, provider, model_id, model_profile, started_at, ended_at)
     VALUES (?,?,?,?,?,?,?)`
  );

  const rows = {
    memories: data.memories ?? [],
    identity: data.identity ?? [],
    goals: data.goals ?? [],
    events: data.events ?? [],
  };

  const tx = db.transaction(() => {
    for (const m of rows.memories) {
      if (memExists.get(m.id)) {
        result.memories.skipped++;
        continue;
      }

      // 3.1.1 import screening: a passport is untrusted input. A raw insert
      // used to bypass every guard capture() enforces. Memories that would
      // become live (recallable) are screened with the SAME checks; non-live
      // statuses (superseded/deleted/expired/rejected) never surface in recall
      // and pass through unchanged as historical tombstones.
      let status: string = m.status;
      let sourceType: string = m.sourceType;
      let sourceRef: string | null = m.sourceRef ?? null;
      const isLive = LIVE_STATUSES.has(status);

      if (isLive) {
        // (a) Secrets are never stored — drop the row, keep a redacted event.
        const secretKind = detectSecret(m.content);
        if (secretKind) {
          appendEvent('import.memory_skipped', 'memory', m.id, {
            reason: `secret detected (${secretKind})`,
            content_redacted: true,
          }, { actor: 'import' });
          result.screened.secrets_dropped++;
          result.memories.skipped++;
          continue;
        }
        // (b) Constitution 'never' for the category — drop, like capture().
        if (storeRuleFor(m.category) === 'never') {
          appendEvent('import.memory_skipped', 'memory', m.id, {
            reason: `constitution: store.${m.category} = never`,
          }, { actor: 'import' });
          result.memories.skipped++;
          continue;
        }
        // (c) Injection-looking content is quarantined, not imported live.
        if (detectInjection(m.content)) {
          status = 'quarantined';
          appendEvent('memory.quarantined', 'memory', m.id, {
            reason: 'import: content matches stored-instruction/injection patterns',
          }, { actor: 'import' });
          result.screened.quarantined++;
        }
        // (d) Provenance guard: user_statement authority requires a source_ref
        // citing the user's words. An import cannot mint it — downgrade.
        if (sourceType === 'user_statement' && !sourceRef?.trim()) {
          sourceType = 'import';
          appendEvent('import.provenance_downgraded', 'memory', m.id, {
            from: 'user_statement',
            to: 'import',
            reason: 'no source_ref backing the user statement',
          }, { actor: 'import' });
          result.screened.provenance_downgraded++;
        }
      }

      // Sensitivity is re-derived so private-category content is excluded from
      // context capsules per constitution even if the passport understated it.
      const sensitiveCategory = classifySensitiveCategory(m.content);
      const sensitivity = sensitiveCategory ? 'private' : m.sensitivity;

      insertMem.run(
        m.id, m.content, m.contentHash, m.type, m.category, JSON.stringify(m.tags ?? []),
        m.importance, m.confidence, sensitivity, status, m.namespace, sourceType,
        sourceRef, m.validFrom, m.validUntil, m.supersedes, m.supersededBy,
        JSON.stringify(m.contradicts ?? []), m.accessCount, m.usefulCount,
        m.createdAt, m.updatedAt, m.lastAccessedAt, m.version,
        m.volatility ?? 'stable', m.lastVerifiedAt ?? null, m.reviewDueAt ?? null, m.verificationRef ?? null
      );
      result.memories.imported++;
    }
    for (const f of rows.identity) {
      if (identityExists.get(f.aspect, f.namespace ?? 'default')) {
        result.identity.skipped++;
        continue;
      }
      insertIdentity.run(
        f.aspect, f.namespace ?? 'default', f.value, f.confidence, f.evidence,
        f.status ?? 'observed', f.sourceType ?? 'import', f.firstSeen, f.lastUpdated
      );
      result.identity.imported++;
    }
    for (const g of rows.goals) {
      if (goalExists.get(g.id)) {
        result.goals.skipped++;
        continue;
      }
      insertGoal.run(
        g.id, g.title, g.description, g.kind, g.status, g.priority, g.progress,
        g.dueAt, g.parentId, g.namespace, g.createdAt, g.updatedAt
      );
      result.goals.imported++;
    }
    for (const e of rows.events) {
      const entityId = (e.entity_id as string | null) ?? null;
      if (eventExists.get(e.recorded_at, e.event_type, entityId, entityId)) {
        result.events.skipped++;
        continue;
      }
      insertEvent.run(
        e.event_type, e.entity_type, entityId, e.payload ?? '{}', e.actor ?? 'import',
        e.recorded_at, e.valid_from ?? null, e.valid_until ?? null
      );
      result.events.imported++;
    }
    for (const d of (data.workbench_decisions ?? []) as any[]) {
      if (decisionExists.get(d.id)) {
        result.workbench_decisions.skipped++;
        continue;
      }
      insertDecision.run(
        d.id, d.kind, d.subject_key, d.subject_revision ?? null, d.outcome,
        d.terminal ?? 0, d.next_review_at ?? null, d.assignment_id, d.actor ?? 'import',
        d.reasoning ?? null, d.created_at, d.invalidated_at ?? null
      );
      result.workbench_decisions.imported++;
    }
    for (const p of (data.predictions ?? []) as any[]) {
      if (predictionExists.get(p.id)) {
        result.predictions.skipped++;
        continue;
      }
      insertPrediction.run(
        p.id, p.claim, p.probability, p.due_at ?? null, p.namespace ?? 'default',
        p.model_hint ?? null, p.created_at, p.resolved_at ?? null, p.outcome ?? null,
        p.decision_id ?? null, p.domain ?? null, p.client_session_id ?? null,
        p.resolution_actor ?? null, p.evidence_ref ?? null
      );
      result.predictions.imported++;
    }
    for (const r of (data.session_reflections ?? []) as any[]) {
      if (reflectionExists.get(r.id)) {
        result.session_reflections.skipped++;
        continue;
      }
      insertReflection.run(r.id, r.session_number, r.summary, r.learnings_count ?? 0, r.client_session_id ?? null, r.created_at);
      result.session_reflections.imported++;
    }
    for (const c of (data.client_sessions ?? []) as any[]) {
      if (clientSessionExists.get(c.id)) {
        result.client_sessions.skipped++;
        continue;
      }
      insertClientSession.run(
        c.id, c.client_name ?? null, c.provider ?? null, c.model_id ?? null,
        c.model_profile ?? null, c.started_at, c.ended_at ?? null
      );
      result.client_sessions.imported++;
    }
  });
  tx();

  appendEvent('data.imported', 'system', null, {
    ...result,
    checksum_valid: checksumValid,
  });

  return result;
}

/** v1 export files (from soul-mcp 1.x soul_export) can still be imported. */
export function importV1Export(data: {
  version: string;
  memories: Array<{ content: string; category: string; tags: string[]; importance: number; createdAt?: string }>;
  identity: Array<{ aspect: string; value: string; confidence: number }>;
}): { imported: number; skipped: number } {
  let imported = 0;
  let skipped = 0;
  for (const m of data.memories ?? []) {
    const r = capture({
      content: m.content,
      category: m.category,
      tags: m.tags,
      importance: m.importance,
      sourceType: 'import',
      sourceRef: 'v1-export',
    });
    if (r.outcome === 'stored' || r.outcome === 'candidate') imported++;
    else skipped++;
  }
  for (const f of data.identity ?? []) {
    setIdentityFacet(f.aspect, f.value, { confidence: f.confidence, sourceType: 'import' });
  }
  return { imported, skipped };
}
