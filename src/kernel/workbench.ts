/**
 * The workbench: the Denkpartner protocol's server side.
 *
 * Soul cannot think. But an LLM sits in front of it in every session. The
 * workbench turns that model into Soul's reasoning engine WITHOUT MCP
 * sampling (deprecated, and unsupported by major clients): Soul computes,
 * deterministically, what needs judgment — unresolved disputes, near-
 * duplicate clusters, low-confidence inferences, stale candidates — and
 * hands them to the model as structured assignments inside tool results.
 * The model answers through soul_resolve; the resolution is validated
 * against the persisted assignment and applied under policy guards.
 *
 * Guards, enforced in code, not prompt:
 * - A model verdict never hard-deletes anything. The strongest applied
 *   effect is supersession (history kept, linked, reversible).
 * - A user_statement is never overruled by a model verdict alone. Such
 *   resolutions are recorded as 'needs_user' and stay in the review queue.
 * - Every applied resolution is a ledger event with model_assisted
 *   provenance and the assignment id.
 */

import { z } from 'zod';
import { getDb } from './db.js';
import { appendEvent } from './ledger.js';
import { capture, getMemoryById, listDisputedPairs, clearContradictionLinks, type Memory } from './memory.js';
import { loadConstitution } from './policy.js';
import { getVector, cosine } from './semantic.js';
import { newId, nowIso, parseDuration } from '../util/core.js';
import { getPrediction, resolvePrediction, listPredictions } from './cognition.js';

export type AssignmentKind = 'dispute' | 'merge_review' | 'low_confidence' | 'stale_candidate' | 'prediction_due';

export interface Assignment {
  id: string;
  kind: AssignmentKind;
  memoryIds: string[];
  instruction: string;
  status: 'open' | 'resolved' | 'invalid';
  issuedAt: string;
}

export interface AssignmentView {
  id: string;
  kind: AssignmentKind;
  instruction: string;
  memories: Array<{ id: string; content: string; source: string; confidence: number; status: string }>;
  prediction?: { id: string; claim: string; probability: number; due_at: string | null; made: string };
  respond_with: unknown;
}

/** Near-duplicate threshold for merge candidates (raw e5 cosine). */
const MERGE_COSINE = 0.92;
/**
 * Semantic conflict threshold for preference/identity/goal memories: high
 * similarity + different content on these types smells like a contradiction
 * the word-overlap heuristic missed — issued as a dispute for the model to
 * judge, replacing nothing.
 */
const CONFLICT_COSINE = 0.85;
/** Above this many stored vectors the O(n²) merge scan is skipped (logged, not silent). */
const MERGE_SCAN_CAP = 3000;
const CONFLICT_TYPES = new Set(['preference', 'identity', 'goal']);

// ─── Resolution schemas (what the model must answer with) ────────────

const RESOLUTION_SCHEMAS: Record<AssignmentKind, z.ZodTypeAny> = {
  dispute: z.object({
    verdict: z.enum(['contradiction', 'compatible', 'unclear']),
    current: z.string().optional().describe('If contradiction: id of the memory that is true today.'),
    reasoning: z.string().min(10),
  }),
  merge_review: z.object({
    action: z.enum(['merge', 'keep_separate']),
    merged_content: z.string().optional().describe('If merge: one memory that preserves all facts of both.'),
    reasoning: z.string().min(10),
  }),
  low_confidence: z.object({
    action: z.enum(['endorse', 'doubt', 'retire']),
    reasoning: z.string().min(10),
  }),
  stale_candidate: z.object({
    action: z.enum(['recommend_confirm', 'let_expire']),
    reasoning: z.string().min(10),
  }),
  prediction_due: z.object({
    outcome: z.enum(['true', 'false', 'void', 'still_open']),
    reasoning: z.string().min(10),
  }),
};

/** Human/model-readable answer shape, embedded in each assignment. */
function respondWith(kind: AssignmentKind): unknown {
  switch (kind) {
    case 'dispute':
      return { verdict: 'contradiction | compatible | unclear', current: '(memory id, only for contradiction)', reasoning: 'why' };
    case 'merge_review':
      return { action: 'merge | keep_separate', merged_content: '(only for merge)', reasoning: 'why' };
    case 'low_confidence':
      return { action: 'endorse | doubt | retire', reasoning: 'why' };
    case 'stale_candidate':
      return { action: 'recommend_confirm | let_expire', reasoning: 'why' };
    case 'prediction_due':
      return { outcome: 'true | false | void | still_open', reasoning: 'what actually happened, with evidence' };
  }
}

const INSTRUCTIONS: Record<AssignmentKind, string> = {
  dispute:
    'These memories are flagged as contradicting. Judge: real contradiction, or compatible statements? ' +
    'If contradiction and the content clearly shows which is true today, name it as current.',
  merge_review:
    'These memories are near-duplicates by embedding similarity. Decide: merge into one memory that keeps ' +
    'every fact (provide merged_content), or keep separate because they carry distinct information.',
  low_confidence:
    'This is an old, low-confidence inference. Based on everything in the current context: endorse it ' +
    '(still plausible), doubt it (probably wrong), or retire it (no longer relevant).',
  stale_candidate:
    'This candidate memory waits for confirmation and will expire soon. Recommend confirmation (worth ' +
    'keeping — the user should confirm) or let it expire.',
  prediction_due:
    'This prediction is past due. Judge from what you know now: did it come true, come false, become ' +
    'unanswerable (void), or is it genuinely still open? Your answer feeds the calibration record.',
};

// ─── Decision records (the detectors' memory of past verdicts) ───────

/** Outcomes that settle a subject for good — never re-issued. */
const TERMINAL_OUTCOMES = new Set([
  'kept_separate', // merge_review: distinct information, judged once
  'undisputed', // dispute: compatible — conflict link removed
  'superseded', // dispute: loser superseded (state change would hide it anyway)
  'merged', // merge_review: originals superseded
  'retired', // low_confidence: memory expired
  'expired', // stale_candidate: memory expired
  'needs_user', // model CANNOT decide this; re-asking the model is pointless — the pair stays in the user review queue
  'prediction_true',
  'prediction_false',
  'prediction_void',
]);

/** Cooldowns for non-terminal verdicts: the subject may return, later. */
const COOLDOWN_MS: Record<string, number> = {
  unclear: 30 * 86_400_000, // dispute judged undecidable — re-ask in a month
  doubted: 30 * 86_400_000, // confidence lowered but still in the detector window
  endorsed: 30 * 86_400_000, // confidence raised but possibly still <= threshold
  recommended: 30 * 86_400_000, // waiting for the user's soul_confirm
  still_open: 7 * 86_400_000, // prediction genuinely not judgeable yet
};

/** Sorted-id subject key: stable for pairs regardless of order. */
function subjectKeyFor(memoryIds: string[]): string {
  return [...memoryIds].sort().join('|');
}

function recordDecision(opts: {
  kind: AssignmentKind;
  subjectKey: string;
  subjectRevision: string | null;
  outcome: string;
  assignmentId: string;
  actor: string;
  reasoning: string | null;
}): void {
  const terminal = TERMINAL_OUTCOMES.has(opts.outcome) ? 1 : 0;
  const cooldown = terminal ? undefined : COOLDOWN_MS[opts.outcome];
  const nextReviewAt = cooldown ? new Date(Date.now() + cooldown).toISOString() : null;
  getDb()
    .prepare(
      `INSERT INTO workbench_decisions
         (id, kind, subject_key, subject_revision, outcome, terminal, next_review_at, assignment_id, actor, reasoning, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      newId('wbd'),
      opts.kind,
      opts.subjectKey,
      opts.subjectRevision,
      opts.outcome,
      terminal,
      nextReviewAt,
      opts.assignmentId,
      opts.actor,
      opts.reasoning,
      nowIso()
    );
}

/** True when the latest non-invalidated decision settles or snoozes the subject. */
function decisionBlocks(kind: AssignmentKind, subjectKey: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT terminal, next_review_at FROM workbench_decisions
       WHERE kind = ? AND subject_key = ? AND invalidated_at IS NULL
       ORDER BY created_at DESC, id DESC LIMIT 1`
    )
    .get(kind, subjectKey) as { terminal: number; next_review_at: string | null } | undefined;
  if (!row) return false;
  if (row.terminal === 1) return true;
  return row.next_review_at !== null && row.next_review_at > nowIso();
}

// ─── Issue assignments (deterministic detectors) ─────────────────────

export function computeAssignments(opts: { maxNew?: number } = {}): AssignmentView[] {
  const db = getDb();
  const maxNew = opts.maxNew ?? 10;
  const covered = new Set<string>(); // memory ids already inside an open assignment
  for (const a of listAssignments('open')) for (const id of a.memoryIds) covered.add(id);

  let issued = 0;
  const issue = (kind: AssignmentKind, memoryIds: string[]) => {
    if (issued >= maxNew) return;
    if (memoryIds.some((id) => covered.has(id))) return;
    if (decisionBlocks(kind, subjectKeyFor(memoryIds))) return; // already judged (terminal or cooling down)
    const id = newId('wb');
    db.prepare(
      `INSERT INTO workbench_assignments (id, kind, memory_ids, instruction, status, issued_at)
       VALUES (?, ?, ?, ?, 'open', ?)`
    ).run(id, kind, JSON.stringify(memoryIds), INSTRUCTIONS[kind], nowIso());
    appendEvent('workbench.issued', 'system', id, { kind, memory_ids: memoryIds }, {});
    for (const m of memoryIds) covered.add(m);
    issued++;
  };

  // 1. Unresolved disputes
  for (const pair of listDisputedPairs(10)) issue('dispute', [pair.a.id, pair.b.id]);

  // 2. Embedding scan (skipped when the semantic layer is off):
  //    high similarity on conflict-prone types -> dispute for the model to judge;
  //    very high similarity elsewhere -> merge candidate.
  for (const pair of nearDuplicatePairs(db)) issue(pair.kind, [pair.a, pair.b]);

  // 3. Old low-confidence inferences
  const staleInferences = db
    .prepare(
      `SELECT id FROM memories WHERE status = 'active' AND source_type = 'agent_inference'
       AND confidence <= 0.45 AND created_at < ? ORDER BY created_at ASC LIMIT 5`
    )
    .all(new Date(Date.now() - 14 * 86_400_000).toISOString()) as Array<{ id: string }>;
  for (const row of staleInferences) issue('low_confidence', [row.id]);

  // 4. Candidates close to expiry (past 60% of the retention window)
  const retentionMs = parseDuration(loadConstitution().retention.candidate) ?? 30 * 86_400_000;
  const cutoff = new Date(Date.now() - retentionMs * 0.6).toISOString();
  const staleCandidates = db
    .prepare(`SELECT id FROM memories WHERE status = 'candidate' AND created_at < ? LIMIT 5`)
    .all(cutoff) as Array<{ id: string }>;
  for (const row of staleCandidates) issue('stale_candidate', [row.id]);

  // 5. Predictions past their due date -> the model judges the outcome
  for (const p of listPredictions({ open: true, dueBefore: nowIso(), limit: 5 })) {
    issue('prediction_due', [p.id]);
  }

  return openAssignmentViews();
}

function nearDuplicatePairs(db: any): Array<{ kind: 'dispute' | 'merge_review'; a: string; b: string }> {
  const rows = db
    .prepare(
      `SELECT m.id, m.namespace, m.content_hash, m.type FROM memories m
       JOIN memory_vectors v ON v.id = m.id
       WHERE m.status IN ('active','confirmed')`
    )
    .all() as Array<{ id: string; namespace: string; content_hash: string; type: string }>;
  if (rows.length > MERGE_SCAN_CAP) {
    console.error(`[soul] merge scan skipped: ${rows.length} vectors > cap ${MERGE_SCAN_CAP}`);
    return [];
  }
  const pairs: Array<{ kind: 'dispute' | 'merge_review'; a: string; b: string }> = [];
  for (let i = 0; i < rows.length && pairs.length < 5; i++) {
    const vi = getVector(rows[i]!.id);
    if (!vi) continue;
    for (let j = i + 1; j < rows.length; j++) {
      if (rows[i]!.namespace !== rows[j]!.namespace) continue;
      if (rows[i]!.content_hash === rows[j]!.content_hash) continue; // exact dups are merged at capture
      const vj = getVector(rows[j]!.id);
      if (!vj || vj.length !== vi.length) continue;
      const sim = cosine(vi, vj);
      const conflictProne = CONFLICT_TYPES.has(rows[i]!.type) && rows[i]!.type === rows[j]!.type;
      if (conflictProne && sim >= CONFLICT_COSINE) {
        pairs.push({ kind: 'dispute', a: rows[i]!.id, b: rows[j]!.id });
        break;
      }
      if (sim >= MERGE_COSINE) {
        pairs.push({ kind: 'merge_review', a: rows[i]!.id, b: rows[j]!.id });
        break;
      }
    }
  }
  return pairs;
}

// ─── Read ────────────────────────────────────────────────────────────

export function listAssignments(status: 'open' | 'resolved' | 'invalid' = 'open', limit = 20): Assignment[] {
  const rows = getDb()
    .prepare(`SELECT * FROM workbench_assignments WHERE status = ? ORDER BY issued_at ASC LIMIT ?`)
    .all(status, limit) as any[];
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    memoryIds: JSON.parse(r.memory_ids),
    instruction: r.instruction,
    status: r.status,
    issuedAt: r.issued_at,
  }));
}

export function openAssignmentViews(limit = 20): AssignmentView[] {
  const views: AssignmentView[] = [];
  for (const a of listAssignments('open', limit)) {
    if (a.kind === 'prediction_due') {
      const p = getPrediction(a.memoryIds[0] ?? '');
      if (!p || p.resolvedAt) {
        markAssignment(a.id, 'invalid', { reason: 'prediction gone or already resolved' });
        continue;
      }
      views.push({
        id: a.id,
        kind: a.kind,
        instruction: a.instruction,
        memories: [],
        prediction: { id: p.id, claim: p.claim, probability: p.probability, due_at: p.dueAt, made: p.createdAt },
        respond_with: respondWith(a.kind),
      });
      continue;
    }
    const memories = a.memoryIds
      .map((id) => getMemoryById(id))
      .filter((m): m is Memory => m !== null)
      .map((m) => ({
        id: m.id,
        content: m.content,
        source: m.sourceType + (m.sourceRef ? `:${m.sourceRef}` : ''),
        confidence: m.confidence,
        status: m.status,
      }));
    if (memories.length !== a.memoryIds.length) {
      // referenced memory vanished (hard forget) -> assignment is void
      markAssignment(a.id, 'invalid', { reason: 'memory no longer exists' });
      continue;
    }
    views.push({ id: a.id, kind: a.kind, instruction: a.instruction, memories, respond_with: respondWith(a.kind) });
  }
  return views;
}

function markAssignment(id: string, status: string, resolution: unknown): void {
  getDb()
    .prepare(`UPDATE workbench_assignments SET status = ?, resolved_at = ?, resolution = ? WHERE id = ?`)
    .run(status, nowIso(), JSON.stringify(resolution), id);
}

// ─── Resolve (validate, guard, apply) ────────────────────────────────

export interface ResolveResult {
  applied: boolean;
  outcome: string;
  detail: string;
}

export function resolveAssignment(assignmentId: string, resolution: unknown, actor = 'agent'): ResolveResult {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM workbench_assignments WHERE id = ?`).get(assignmentId) as any;
  if (!row) return { applied: false, outcome: 'not_found', detail: `No assignment ${assignmentId}.` };
  if (row.status !== 'open') {
    return { applied: false, outcome: 'already_closed', detail: `Assignment is '${row.status}'.` };
  }

  const kind = row.kind as AssignmentKind;
  const parsed = RESOLUTION_SCHEMAS[kind].safeParse(resolution);
  if (!parsed.success) {
    return {
      applied: false,
      outcome: 'invalid_resolution',
      detail: `Resolution does not match the ${kind} schema: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    };
  }
  const reasoning: string | null = (parsed.data as any).reasoning ?? null;

  if (kind === 'prediction_due') {
    const predictionId: string = JSON.parse(row.memory_ids)[0];
    const prediction = getPrediction(predictionId);
    const outcome = (parsed.data as any).outcome as 'true' | 'false' | 'void' | 'still_open';
    let result: ResolveResult;
    // decision insert + state change + assignment close: one transaction
    const tx = db.transaction(() => {
      if (outcome === 'still_open') {
        result = { applied: true, outcome: 'still_open', detail: 'Noted; the prediction stays open and returns after a cooldown.' };
      } else {
        const resolved = resolvePrediction(predictionId, outcome, actor);
        result = resolved
          ? { applied: true, outcome: `prediction_${outcome}`, detail: `Prediction resolved as ${outcome}; the calibration record was updated.` }
          : { applied: false, outcome: 'invalid', detail: 'Prediction gone or already resolved.' };
      }
      markAssignment(assignmentId, result.applied ? 'resolved' : 'invalid', { ...(parsed.data as object), outcome: result.outcome });
      if (result.applied) {
        recordDecision({
          kind,
          subjectKey: predictionId,
          subjectRevision: prediction?.createdAt ?? null,
          outcome: result.outcome,
          assignmentId,
          actor,
          reasoning,
        });
      }
      appendEvent('workbench.resolved', 'system', assignmentId, { kind, resolution: parsed.data, outcome: result!.outcome, applied: result!.applied }, { actor });
    });
    tx();
    return result!;
  }

  const memoryIds: string[] = JSON.parse(row.memory_ids);
  const memories = memoryIds.map((id) => getMemoryById(id));
  if (memories.some((m) => m === null)) {
    markAssignment(assignmentId, 'invalid', { reason: 'memory no longer exists' });
    return { applied: false, outcome: 'invalid', detail: 'A referenced memory no longer exists.' };
  }

  // Everything downstream of the verdict — the memory-state change, the
  // assignment close, the decision record — commits atomically, or not at all.
  let result: ResolveResult;
  const tx = db.transaction(() => {
    result = applyResolution(kind, memories as Memory[], parsed.data, actor, assignmentId);
    const settles = result.applied || result.outcome === 'needs_user';
    if (settles) {
      markAssignment(assignmentId, 'resolved', { ...(parsed.data as object), outcome: result.outcome });
      recordDecision({
        kind,
        subjectKey: subjectKeyFor(memoryIds),
        subjectRevision: (memories as Memory[]).map((m) => m.contentHash).sort().join('|'),
        outcome: result.outcome,
        assignmentId,
        actor,
        reasoning,
      });
    }
    // a guard-rejected resolution (invalid_resolution, capture_failed) leaves
    // the assignment open: nothing was applied, so nothing may look answered
    appendEvent('workbench.resolved', 'system', assignmentId, {
      kind,
      resolution: parsed.data,
      outcome: result.outcome,
      applied: result.applied,
    }, { actor });
  });
  tx();
  return result!;
}

function applyResolution(
  kind: Exclude<AssignmentKind, 'prediction_due'>,
  memories: Memory[],
  resolution: any,
  actor: string,
  assignmentId: string
): ResolveResult {
  const db = getDb();
  const now = nowIso();

  switch (kind) {
    case 'dispute': {
      const [a, b] = memories as [Memory, Memory];
      if (resolution.verdict === 'compatible') {
        const tx = db.transaction(() => {
          for (const [self, other] of [[a, b], [b, a]] as const) {
            const remaining = self.contradicts.filter((id) => id !== other.id);
            const status = remaining.length > 0 ? 'disputed' : 'active';
            db.prepare(`UPDATE memories SET contradicts = ?, status = ?, updated_at = ? WHERE id = ?`)
              .run(JSON.stringify(remaining), status, now, self.id);
            appendEvent('memory.undisputed', 'memory', self.id, { compatible_with: other.id, via: assignmentId }, { actor });
          }
        });
        tx();
        return { applied: true, outcome: 'undisputed', detail: 'Both memories are active again; the conflict link was removed.' };
      }
      if (resolution.verdict === 'contradiction' && resolution.current) {
        const current = memories.find((m) => m.id === resolution.current);
        const loser = memories.find((m) => m.id !== resolution.current);
        if (!current || !loser) {
          return { applied: false, outcome: 'invalid_resolution', detail: `'current' must be one of: ${memories.map((m) => m.id).join(', ')}` };
        }
        if (loser.sourceType === 'user_statement') {
          return {
            applied: false,
            outcome: 'needs_user',
            detail:
              'The losing side is a user statement. A model verdict never overrules the user — ' +
              'the pair stays disputed and waits in the review queue (soul_review_queue / soul_confirm).',
          };
        }
        const tx = db.transaction(() => {
          clearContradictionLinks(loser.id, actor); // also frees third-party partners, not just this pair
          db.prepare(`UPDATE memories SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?`)
            .run(current.id, now, loser.id);
          appendEvent('memory.superseded', 'memory', loser.id, { superseded_by: current.id, via: assignmentId, model_assisted: true }, { actor });
        });
        tx();
        return { applied: true, outcome: 'superseded', detail: `${loser.id} superseded by ${current.id} (kept, linked, reversible).` };
      }
      return { applied: true, outcome: 'unclear', detail: 'Recorded as unclear; the pair stays disputed and returns after a cooldown.' };
    }

    case 'merge_review': {
      if (resolution.action === 'keep_separate') {
        return { applied: true, outcome: 'kept_separate', detail: 'Both memories stay as they are.' };
      }
      if (!resolution.merged_content || resolution.merged_content.trim().length < 10) {
        return { applied: false, outcome: 'invalid_resolution', detail: 'merge requires merged_content.' };
      }
      const [a, b] = memories as [Memory, Memory];
      const captured = capture({
        content: resolution.merged_content,
        type: a.type,
        category: a.category,
        tags: Array.from(new Set([...a.tags, ...b.tags])).slice(0, 8),
        importance: Math.max(a.importance, b.importance),
        confidence: Math.min(a.confidence, b.confidence),
        namespace: a.namespace,
        sourceType: 'model_assisted',
        sourceRef: `workbench:${assignmentId}`,
        actor,
      });
      if (!captured.memory || captured.outcome === 'rejected') {
        return { applied: false, outcome: 'capture_failed', detail: captured.reason };
      }
      const tx = db.transaction(() => {
        for (const m of [a, b]) {
          clearContradictionLinks(m.id, actor);
          db.prepare(`UPDATE memories SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?`)
            .run(captured.memory!.id, now, m.id);
          appendEvent('memory.superseded', 'memory', m.id, { superseded_by: captured.memory!.id, via: assignmentId, model_assisted: true }, { actor });
        }
      });
      tx();
      return { applied: true, outcome: 'merged', detail: `Merged into ${captured.memory.id}; originals kept as superseded.` };
    }

    case 'low_confidence': {
      const m = memories[0]!;
      if (resolution.action === 'endorse') {
        db.prepare(`UPDATE memories SET confidence = MIN(0.95, confidence + 0.1), updated_at = ? WHERE id = ?`).run(now, m.id);
        return { applied: true, outcome: 'endorsed', detail: `Confidence raised for ${m.id}.` };
      }
      if (resolution.action === 'doubt') {
        db.prepare(`UPDATE memories SET confidence = MAX(0.05, confidence - 0.15), updated_at = ? WHERE id = ?`).run(now, m.id);
        return { applied: true, outcome: 'doubted', detail: `Confidence lowered for ${m.id}.` };
      }
      // retire
      if (m.sourceType === 'user_statement') {
        return { applied: false, outcome: 'needs_user', detail: 'Retiring a user statement needs the user (soul_forget).' };
      }
      clearContradictionLinks(m.id, actor);
      db.prepare(`UPDATE memories SET status = 'expired', updated_at = ? WHERE id = ?`).run(now, m.id);
      appendEvent('memory.expired', 'memory', m.id, { reason: 'retired by model-assisted review', via: assignmentId }, { actor });
      return { applied: true, outcome: 'retired', detail: `${m.id} expired (tombstone kept).` };
    }

    case 'stale_candidate': {
      const m = memories[0]!;
      if (resolution.action === 'recommend_confirm') {
        db.prepare(`UPDATE memories SET importance = MIN(1.0, importance + 0.1), updated_at = ? WHERE id = ?`).run(now, m.id);
        return {
          applied: true,
          outcome: 'recommended',
          detail: `Confirmation recommended for ${m.id} — only the user can confirm (soul_confirm).`,
        };
      }
      if (m.sourceType === 'user_statement') {
        return { applied: false, outcome: 'needs_user', detail: 'Expiring a user statement needs the user.' };
      }
      clearContradictionLinks(m.id, actor);
      db.prepare(`UPDATE memories SET status = 'expired', updated_at = ? WHERE id = ?`).run(now, m.id);
      appendEvent('memory.expired', 'memory', m.id, { reason: 'model-assisted stale review', via: assignmentId }, { actor });
      return { applied: true, outcome: 'expired', detail: `${m.id} expired (tombstone kept).` };
    }
  }
}
