/**
 * Durable Run State Machine — Phase 2 Welle A, Kontextmodus ONLY.
 *
 * Design rules (DECISIONS F09 / F09r2, THREAT-MODEL TB6 + §5):
 * - The MCP server NEVER spawns anything. Context mode means: soul_run
 *   compiles a TaskContract, creates run + pending receipt + PENDING episode
 *   SYNCHRONOUSLY in one transaction, and hands the capsule back to the model
 *   in front of it. Execution happens in the caller's context.
 * - "Jeder Run hat ein Receipt" holds from run creation in both modes; only
 *   the closing path differs (soul_feedback vs. reaper timeout).
 * - The reaper is a LAZY SWEEP (reapExpired), invoked on every soul_run /
 *   soul_feedback call and at server construction — never a background
 *   thread/timer: an MCP stdio server has no safe background lifecycle.
 * - Honesty classes: a pending receipt is self_attested and context-mode
 *   feedback STAYS self_attested — an evidence_ref string is a claim, not a
 *   verification; it is carried in the receipt outcome for later audit but
 *   never raises honesty_class. deterministic_verified requires a validated
 *   VerifierResult@1 from a separate verifier instance; that path does not
 *   exist in 4.0 (claiming it would be Architektur-Performance). Absent
 *   feedback expires as expired_unconfirmed (missingness, never a success
 *   or failure verdict — Episode books it as such).
 */

import { getDb } from './db.js';
import { appendEvent } from './ledger.js';
import { newId, nowIso } from '../util/core.js';

// ─── Types ────────────────────────────────────────────────────────────

export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting_verification'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface RunBudget {
  max_tokens: number;
  max_wall_clock_s: number;
  max_cost_eur: number;
  max_attempts: number;
}

export interface TaskContract {
  contract: 'TaskContract@1';
  task_id: string;
  title?: string;
  goal: string;
  strategy: 'direct' | 'plan_execute_verify';
  acceptance_criteria: string[];
  budget: RunBudget;
  verification: { mode: 'deterministic' | 'model_graded' | 'none' };
  source: 'user' | 'freitext_compiled';
  idempotency_key: string;
  created_at: string;
}

export interface RunRow {
  run_id: string;
  idempotency_key: string;
  status: RunStatus;
  task_contract: string;
  budget: string;
  created_at: string;
  updated_at: string;
  fencing_token: string;
  lease_until: string | null;
  attempt_count: number;
}

interface ReceiptRow {
  receipt_id: string;
  run_id: string;
  status: 'pending' | 'closed';
  honesty_class: 'self_attested' | 'deterministic_verified' | 'model_graded';
  issued_by: 'coordinator' | 'reaper';
  created_at: string;
  closed_at: string | null;
  outcome: string | null;
}

/** Contract-level view, schema-valid against design/contracts/ReceiptV1.schema.json. */
export interface ReceiptV1View {
  contract: 'ReceiptV1';
  receipt_id: string;
  run_id: string;
  attempt: number;
  fencing_token: string;
  mode: 'worker' | 'context';
  status: 'pending' | 'succeeded' | 'failed' | 'cancelled' | 'crashed' | 'timeout' | 'expired_unconfirmed';
  honesty_class: 'self_attested' | 'deterministic_verified' | 'model_graded';
  actor: 'agent' | 'runner' | 'coordinator' | 'reaper';
  issued_by: 'coordinator' | 'reaper';
  tainted: boolean;
  outcome_summary?: string;
  created_at: string;
  closed_at?: string;
}

export type FeedbackOutcome = 'success' | 'failure' | 'mixed';

const DEFAULT_TTL_DAYS = 7;

/** Configurable receipt/lease TTL: SOUL_RECEIPT_TTL_DAYS (0 is honored). */
export function receiptTtlDays(): number {
  const raw = process.env.SOUL_RECEIPT_TTL_DAYS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_TTL_DAYS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TTL_DAYS;
}

// ─── TaskContract compilation (deterministic, no LLM in the write path) ──

const DEFAULT_BUDGET: RunBudget = {
  max_tokens: 200_000,
  // Context-mode wall clock is bounded by the receipt TTL (7 days), not by a
  // worker process lifetime — there is no worker in Welle A.
  max_wall_clock_s: 7 * 86_400,
  max_cost_eur: 0,
  max_attempts: 1,
};

export function compileTaskContract(
  task: string,
  opts: { idempotencyKey?: string; budget?: Partial<RunBudget> } = {}
): TaskContract {
  const goal = task.trim().slice(0, 4000);
  if (!goal) throw new Error('task must be a non-empty string');
  // Deterministic strategy heuristic: multi-line or long briefs get the
  // plan_execute_verify scaffold, one-liners run direct (Phase 2 knows
  // exactly these two strategies).
  const strategy: TaskContract['strategy'] =
    goal.length > 400 || goal.includes('\n') ? 'plan_execute_verify' : 'direct';
  const budget: RunBudget = {
    max_tokens: opts.budget?.max_tokens ?? DEFAULT_BUDGET.max_tokens,
    max_wall_clock_s: opts.budget?.max_wall_clock_s ?? DEFAULT_BUDGET.max_wall_clock_s,
    max_cost_eur: opts.budget?.max_cost_eur ?? DEFAULT_BUDGET.max_cost_eur,
    max_attempts: opts.budget?.max_attempts ?? DEFAULT_BUDGET.max_attempts,
  };
  return {
    contract: 'TaskContract@1',
    task_id: newId('task'),
    title: goal.split('\n')[0]!.slice(0, 200),
    goal,
    strategy,
    acceptance_criteria: [
      'Caller reports completion via soul_feedback({run_id, outcome}) with outcome success|failure|mixed.',
    ],
    budget,
    // Context mode has no separate verifier instance; claiming one would be
    // Architektur-Performance. Upgrades happen only via evidence at feedback.
    verification: { mode: 'none' },
    source: 'freitext_compiled',
    idempotency_key: opts.idempotencyKey ?? newId('idem'),
    created_at: nowIso(),
  };
}

// ─── Run creation (context mode) ─────────────────────────────────────

export interface StartContextRunResult {
  existing: boolean;
  run_id: string;
  status: RunStatus;
  task_contract: TaskContract;
  receipt_id: string;
  episode_id: string;
}

/**
 * Create run + pending receipt + PENDING episode atomically (one transaction).
 * Same idempotency key -> the existing run's capsule, no duplicate.
 */
export function startContextRun(input: {
  task: string;
  idempotencyKey?: string;
  budget?: Partial<RunBudget>;
  risk?: 'low' | 'high';
}): StartContextRunResult {
  const db = getDb();

  if (input.idempotencyKey) {
    const existing = db
      .prepare(`SELECT * FROM runs WHERE idempotency_key = ?`)
      .get(input.idempotencyKey) as RunRow | undefined;
    if (existing) {
      // Latest attempt's receipt/episode (retry can add attempts; for a
      // single-attempt run this is identical to the Welle-A behavior).
      const receipt = db
        .prepare(`SELECT receipt_id FROM receipts WHERE run_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
        .get(existing.run_id) as { receipt_id: string } | undefined;
      const episode = db
        .prepare(`SELECT episode_id FROM episodes WHERE run_id = ? ORDER BY recorded_at DESC, rowid DESC LIMIT 1`)
        .get(existing.run_id) as { episode_id: string } | undefined;
      return {
        existing: true,
        run_id: existing.run_id,
        status: existing.status,
        task_contract: JSON.parse(existing.task_contract) as TaskContract,
        receipt_id: receipt?.receipt_id ?? '',
        episode_id: episode?.episode_id ?? '',
      };
    }
  }

  const contract = compileTaskContract(input.task, {
    idempotencyKey: input.idempotencyKey,
    budget: input.budget,
  });
  const now = nowIso();
  const runId = newId('run');
  const receiptId = newId('rcpt');
  const episodeId = newId('ep');
  const fencingToken = newId('fence');
  const leaseUntil = new Date(Date.now() + receiptTtlDays() * 86_400_000).toISOString();

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO runs (run_id, idempotency_key, status, task_contract, budget, created_at, updated_at, fencing_token, lease_until, attempt_count)
       VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?, 1)`
    ).run(
      runId,
      contract.idempotency_key,
      JSON.stringify(contract),
      JSON.stringify(contract.budget),
      now,
      now,
      fencingToken,
      leaseUntil
    );
    // Budget guard at the first state transition (created -> running counts
    // as attempt 1): refuse impossible budgets instead of recording them.
    if (contract.budget.max_attempts < 1) {
      throw new Error('budget.max_attempts must be >= 1');
    }
    // Receipt SYNCHRONOUSLY at run creation: pending / self_attested /
    // issued_by coordinator (F09r2 — the invariant holds from creation on).
    // The outcome column carries the contract-level fields the narrow table
    // columns do not: {status, attempt, fencing_token, mode, actor, tainted}.
    db.prepare(
      `INSERT INTO receipts (receipt_id, run_id, status, honesty_class, issued_by, created_at, closed_at, outcome)
       VALUES (?, ?, 'pending', 'self_attested', 'coordinator', ?, NULL, ?)`
    ).run(
      receiptId,
      runId,
      now,
      JSON.stringify({
        status: 'pending',
        attempt: 1,
        fencing_token: fencingToken,
        mode: 'context',
        actor: 'agent',
        tainted: false,
      })
    );
    // Episode with PENDING outcome, acceptance unknown. eligibility=false:
    // executed.actor is unknown in context mode, so actor statistics must
    // not count this episode (Episode@1 eligibility semantics).
    db.prepare(
      `INSERT INTO episodes (episode_id, occurred_at, recorded_at, task_slice, recommendation_id, policy_version,
        offered, acceptance, executed, run_id, attempt_id, receipt_id, verifier_result_id, prediction, cost,
        outcome, outcome_source, outcome_observed_at, eligibility)
       VALUES (?, ?, ?, ?, NULL, NULL, NULL, 'unknown', ?, ?, ?, ?, NULL, NULL, ?, 'PENDING', NULL, NULL, 0)`
    ).run(
      episodeId,
      now,
      now,
      JSON.stringify({ kind: 'other', risk: input.risk ?? 'low' }),
      JSON.stringify({ actor: 'unknown', recipe_id: null, model_echo: null, context_echo: null }),
      runId,
      `${runId}.a1`,
      receiptId,
      JSON.stringify({ tokens_est: 0, latency_ms: 0, attempts: 1 })
    );
    appendEvent('run.created', 'run', runId, {
      idempotency_key: contract.idempotency_key,
      status: 'running',
      mode: 'context',
      fencing_token: fencingToken,
      lease_until: leaseUntil,
    }, { actor: 'agent' });
    appendEvent('receipt.issued', 'receipt', receiptId, {
      run_id: runId,
      status: 'pending',
      honesty_class: 'self_attested',
      issued_by: 'coordinator',
    }, { actor: 'system' });
    appendEvent('episode.recorded', 'episode', episodeId, {
      run_id: runId,
      outcome: 'PENDING',
    }, { actor: 'system' });
  });
  tx();

  return {
    existing: false,
    run_id: runId,
    status: 'running',
    task_contract: contract,
    receipt_id: receiptId,
    episode_id: episodeId,
  };
}

// ─── Closing via feedback ─────────────────────────────────────────────

export interface CloseRunResult {
  closed: boolean;
  already_closed?: boolean;
  error?: string;
  run_id?: string;
  run_status?: RunStatus;
  receipt_id?: string;
  receipt_status?: string;
  honesty_class?: string;
  episode_outcome?: string;
}

/**
 * soul_feedback with run_id closes the pending receipt and back-fills the
 * episode outcome bitemporally (outcome_observed_at = now).
 * - success -> run succeeded; failure/mixed -> run failed (mixed is booked
 *   fail-closed at run level, the episode keeps the honest 'mixed').
 * - honesty_class stays self_attested: feedback is the model reporting about
 *   itself. An evidence_ref is RECORDED (receipt outcome JSON + ledger) so a
 *   later auditor can check the claim, but a string cannot verify anything —
 *   deterministic_verified is only assignable once a validated
 *   VerifierResult@1 (separate verifier instance, TB2) exists, and that path
 *   is NOT built in 4.0.
 */
export function closeRunWithFeedback(input: {
  runId: string;
  outcome: FeedbackOutcome;
  evidenceRef?: string;
  summary?: string;
}): CloseRunResult {
  const db = getDb();
  const run = db.prepare(`SELECT * FROM runs WHERE run_id = ?`).get(input.runId) as RunRow | undefined;
  if (!run) return { closed: false, error: `Run ${input.runId} not found.` };

  // Feedback always addresses the CURRENT attempt's receipt (the latest one).
  // Older attempts' receipts are already closed (failed/cancelled) and must
  // never be re-opened or re-written by later feedback.
  const receipt = db
    .prepare(`SELECT * FROM receipts WHERE run_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    .get(input.runId) as ReceiptRow | undefined;
  if (!receipt) return { closed: false, error: `Run ${input.runId} has no receipt (invariant violation).` };
  if (receipt.status === 'closed') {
    return {
      closed: false,
      already_closed: true,
      run_id: run.run_id,
      run_status: run.status,
      receipt_id: receipt.receipt_id,
      receipt_status: (safeJson(receipt.outcome).status as string) ?? 'closed',
      honesty_class: receipt.honesty_class,
    };
  }

  const now = nowIso();
  const evidence = input.evidenceRef?.trim();
  // F02: an evidence_ref does NOT upgrade the honesty class. The reference is
  // carried in the outcome JSON (auditable claim), but the receipt stays
  // self_attested — deterministic_verified would require a validated
  // VerifierResult@1, which 4.0 does not produce.
  const honesty = 'self_attested';
  const receiptStatus = input.outcome === 'success' ? 'succeeded' : 'failed';
  const runStatus: RunStatus = input.outcome === 'success' ? 'succeeded' : 'failed';
  const detail = safeJson(receipt.outcome);

  const tx = db.transaction(() => {
    db.prepare(`UPDATE runs SET status = ?, updated_at = ? WHERE run_id = ?`).run(runStatus, now, run.run_id);
    db.prepare(
      `UPDATE receipts SET status = 'closed', honesty_class = ?, closed_at = ?, outcome = ? WHERE receipt_id = ?`
    ).run(
      honesty,
      now,
      JSON.stringify({
        ...detail,
        status: receiptStatus,
        feedback_outcome: input.outcome,
        ...(evidence ? { evidence_ref: evidence } : {}),
        ...(input.summary ? { outcome_summary: input.summary.slice(0, 2000) } : {}),
      }),
      receipt.receipt_id
    );
    // Bitemporal back-fill: outcome + when it became known. Feedback via a
    // tool call is the model reporting -> outcome_source self_attested
    // (a user verdict or verifier would come as its own object; claiming
    // 'user' here would mint authority the call does not carry).
    // Keyed by receipt_id, not run_id: after a retry the run may carry older,
    // already terminally closed episodes (a cancelled attempt's episode is
    // closed as cancelled_unobserved) — feedback must only close the current
    // attempt's still-PENDING episode.
    db.prepare(
      `UPDATE episodes SET outcome = ?, outcome_source = 'self_attested', outcome_observed_at = ? WHERE receipt_id = ? AND outcome = 'PENDING'`
    ).run(input.outcome, now, receipt.receipt_id);
    appendEvent('run.status_changed', 'run', run.run_id, {
      from: run.status,
      to: runStatus,
      via: 'soul_feedback',
    }, { actor: 'agent' });
    appendEvent('receipt.closed', 'receipt', receipt.receipt_id, {
      run_id: run.run_id,
      status: receiptStatus,
      honesty_class: honesty,
      feedback_outcome: input.outcome,
      ...(evidence ? { evidence_ref: evidence } : {}),
    }, { actor: 'agent' });
    appendEvent('episode.outcome_recorded', 'episode', null, {
      run_id: run.run_id,
      outcome: input.outcome,
      outcome_source: 'self_attested',
    }, { actor: 'agent' });
  });
  tx();

  return {
    closed: true,
    run_id: run.run_id,
    run_status: runStatus,
    receipt_id: receipt.receipt_id,
    receipt_status: receiptStatus,
    honesty_class: honesty,
    episode_outcome: input.outcome,
  };
}

// ─── Lifecycle: cancel / resume / retry (Phase 2 Welle B, F10) ────────
//
// Design decisions (documented for the Sol gate):
// - cancel: run -> cancelled, the pending receipt closes with contract
//   status 'cancelled' (schema-valid; honesty stays self_attested, issued_by
//   stays coordinator — an explicit call, not a reaper timeout). The EPISODE
//   closes TERMINALLY as 'cancelled_unobserved' with outcome_source
//   'cancelled' (Episode@1 F04): that is MISSINGNESS, not a verdict —
//   booking 'failure' would lie (cancel is not a judgment), booking
//   'expired_unconfirmed' would lie about the source (its allOf pins that to
//   the reaper timeout). outcome_observed_at is set bitemporally to the
//   cancel moment (when the missingness became terminal), eligibility stays
//   false — a never-observed outcome enters no statistic. A ledger event
//   records the decision. (Before F04 the episode stayed PENDING forever —
//   an eternally open row was indistinguishable from a live run.)
// - resume: idempotent re-delivery of the capsule for a running run with a
//   valid lease. No new run, no new receipt, no state transition — only a
//   run.resumed audit event. Expired lease -> honest error pointing at retry.
// - retry: a NEW attempt on the SAME run, only from failed/cancelled
//   (expired runs are booked failed by the reaper, so they are covered).
//   attempt_count+1, new fencing token (the old one is thereby invalidated —
//   a later commit-check can never accept it), new pending receipt, new
//   episode with its own attempt_id. budget.max_attempts is enforced;
//   exhaustion is refused with a ledger event and no state change.

export interface CancelRunResult {
  cancelled: boolean;
  error?: string;
  run_id?: string;
  run_status?: RunStatus;
  receipt_id?: string;
  receipt_status?: string;
}

export function cancelRun(runId: string): CancelRunResult {
  const db = getDb();
  const run = db.prepare(`SELECT * FROM runs WHERE run_id = ?`).get(runId) as RunRow | undefined;
  if (!run) return { cancelled: false, error: `Run ${runId} not found.` };
  if (!['queued', 'running'].includes(run.status)) {
    return {
      cancelled: false,
      error: `Run ${runId} is '${run.status}' — cancel is only valid from queued/running. No state was changed.`,
      run_id: runId,
      run_status: run.status,
    };
  }

  const receipt = db
    .prepare(`SELECT * FROM receipts WHERE run_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    .get(runId) as ReceiptRow | undefined;
  const episode = receipt
    ? (db.prepare(`SELECT episode_id FROM episodes WHERE receipt_id = ?`).get(receipt.receipt_id) as
        | { episode_id: string }
        | undefined)
    : undefined;
  const now = nowIso();

  const tx = db.transaction(() => {
    db.prepare(`UPDATE runs SET status = 'cancelled', updated_at = ? WHERE run_id = ?`).run(now, runId);
    if (receipt && receipt.status === 'pending') {
      const detail = safeJson(receipt.outcome);
      db.prepare(
        `UPDATE receipts SET status = 'closed', closed_at = ?, outcome = ? WHERE receipt_id = ?`
      ).run(now, JSON.stringify({ ...detail, status: 'cancelled' }), receipt.receipt_id);
      appendEvent('receipt.closed', 'receipt', receipt.receipt_id, {
        run_id: runId,
        status: 'cancelled',
        honesty_class: receipt.honesty_class,
        issued_by: receipt.issued_by,
      }, { actor: 'agent' });
    }
    appendEvent('run.status_changed', 'run', runId, {
      from: run.status,
      to: 'cancelled',
      via: 'cancel',
    }, { actor: 'agent' });
    if (episode) {
      // F04: the episode closes bitemporally as cancelled_unobserved —
      // a terminal MISSINGNESS state (source 'cancelled'), never a verdict.
      // eligibility stays false; outcome_observed_at records when the
      // missingness became terminal (the cancel moment).
      db.prepare(
        `UPDATE episodes SET outcome = 'cancelled_unobserved', outcome_source = 'cancelled', outcome_observed_at = ? WHERE episode_id = ? AND outcome = 'PENDING'`
      ).run(now, episode.episode_id);
      appendEvent('episode.outcome_recorded', 'episode', episode.episode_id, {
        run_id: runId,
        outcome: 'cancelled_unobserved',
        outcome_source: 'cancelled',
        note: 'cancelled — outcome never observed; terminal missingness, not a verdict; eligibility stays false',
      }, { actor: 'agent' });
    }
  });
  tx();

  return {
    cancelled: true,
    run_id: runId,
    run_status: 'cancelled',
    receipt_id: receipt?.receipt_id,
    receipt_status: receipt && receipt.status === 'pending' ? 'cancelled' : receipt ? 'closed' : undefined,
  };
}

export interface ResumeRunResult {
  resumed: boolean;
  error?: string;
  run_id?: string;
  status?: RunStatus;
  task_contract?: TaskContract;
  receipt_id?: string;
  episode_id?: string;
  attempt?: number;
}

export function resumeRun(runId: string): ResumeRunResult {
  const db = getDb();
  const run = db.prepare(`SELECT * FROM runs WHERE run_id = ?`).get(runId) as RunRow | undefined;
  if (!run) return { resumed: false, error: `Run ${runId} not found.` };
  if (run.status !== 'running') {
    const hint = ['failed', 'cancelled'].includes(run.status)
      ? ` Use action "retry" to start a new attempt.`
      : '';
    return {
      resumed: false,
      error: `Run ${runId} is '${run.status}' — resume only re-delivers the capsule of a running run.${hint}`,
      run_id: runId,
      status: run.status,
    };
  }
  if (run.lease_until && run.lease_until <= nowIso()) {
    return {
      resumed: false,
      error:
        `Run ${runId} has an expired lease (${run.lease_until}) — the reaper will book it failed. ` +
        `Use action "retry" to start a new attempt.`,
      run_id: runId,
      status: run.status,
    };
  }

  const receipt = db
    .prepare(`SELECT receipt_id FROM receipts WHERE run_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    .get(runId) as { receipt_id: string } | undefined;
  const episode = db
    .prepare(`SELECT episode_id FROM episodes WHERE run_id = ? ORDER BY recorded_at DESC, rowid DESC LIMIT 1`)
    .get(runId) as { episode_id: string } | undefined;

  // Not a state transition — an audit event only. Idempotent: repeated
  // resumes return the same capsule; each call leaves one audit trace.
  appendEvent('run.resumed', 'run', runId, {
    attempt: run.attempt_count,
    receipt_id: receipt?.receipt_id ?? null,
  }, { actor: 'agent' });

  return {
    resumed: true,
    run_id: runId,
    status: run.status,
    task_contract: JSON.parse(run.task_contract) as TaskContract,
    receipt_id: receipt?.receipt_id,
    episode_id: episode?.episode_id,
    attempt: run.attempt_count,
  };
}

/** Internal sentinel: the retry compare-and-swap matched 0 rows (F03). */
class RetryRaceLost extends Error {
  constructor() {
    super('retry compare-and-swap lost — run state changed concurrently');
  }
}

export interface RetryRunResult {
  retried: boolean;
  refused?: boolean;
  error?: string;
  run_id?: string;
  status?: RunStatus;
  task_contract?: TaskContract;
  receipt_id?: string;
  episode_id?: string;
  attempt?: number;
}

export function retryRun(runId: string): RetryRunResult {
  const db = getDb();
  const run = db.prepare(`SELECT * FROM runs WHERE run_id = ?`).get(runId) as RunRow | undefined;
  if (!run) return { retried: false, error: `Run ${runId} not found.` };
  if (!['failed', 'cancelled'].includes(run.status)) {
    return {
      retried: false,
      error:
        `Run ${runId} is '${run.status}' — retry is only valid for failed/cancelled/expired runs ` +
        `(expired runs are booked failed by the reaper). No state was changed.`,
      run_id: runId,
      status: run.status,
    };
  }

  const budget = JSON.parse(run.budget) as RunBudget;
  const attempt = run.attempt_count + 1;
  if (attempt > budget.max_attempts) {
    appendEvent('run.retry_refused', 'run', runId, {
      attempt_count: run.attempt_count,
      max_attempts: budget.max_attempts,
      reason: 'max_attempts_exhausted',
    }, { actor: 'agent' });
    return {
      retried: false,
      refused: true,
      error:
        `Run ${runId}: budget.max_attempts (${budget.max_attempts}) exhausted — ` +
        `attempt ${run.attempt_count} was the last. No new attempt was created.`,
      run_id: runId,
      status: run.status,
      attempt: run.attempt_count,
    };
  }

  const contract = JSON.parse(run.task_contract) as TaskContract;
  const now = nowIso();
  const receiptId = newId('rcpt');
  const episodeId = newId('ep');
  const fencingToken = newId('fence');
  const leaseUntil = new Date(Date.now() + receiptTtlDays() * 86_400_000).toISOString();
  // Keep the original task slice (risk classification does not change by retrying).
  const prevSlice = db
    .prepare(`SELECT task_slice FROM episodes WHERE run_id = ? ORDER BY recorded_at ASC, rowid ASC LIMIT 1`)
    .get(runId) as { task_slice: string } | undefined;
  const taskSlice = prevSlice?.task_slice ?? JSON.stringify({ kind: 'other', risk: 'low' });

  // F03 Retry-Race: the pre-checks above read run state OUTSIDE a
  // transaction — a concurrent retry (second process on the same DB, or a
  // second call racing the first) could transition the run between that read
  // and this write. Therefore: BEGIN IMMEDIATE (write lock up front, no
  // deferred-upgrade deadlock) + compare-and-swap UPDATE whose WHERE pins the
  // EXPECTED status AND attempt_count AND fencing_token. If the run moved in
  // the meantime, changes !== 1 -> the whole transaction rolls back and the
  // call is refused WITHOUT side effects (no receipt, no episode, no event).
  //
  // Defense-in-depth (Migration v12, db.ts createV12Additions): a partial
  // UNIQUE index on episodes(run_id, attempt_id) and a UNIQUE expression
  // index `receipts(run_id, json_extract(outcome,'$.attempt'))` — receipts
  // carry `attempt` only inside the outcome JSON — back this CAS at the
  // storage layer: even a buggy writer or a second process cannot book two
  // episodes/receipts for the same attempt.
  const tx = db.transaction(() => {
    const cas = db
      .prepare(
        `UPDATE runs SET status = 'running', updated_at = ?, fencing_token = ?, lease_until = ?, attempt_count = ?
         WHERE run_id = ? AND status = ? AND attempt_count = ? AND fencing_token = ?`
      )
      .run(now, fencingToken, leaseUntil, attempt, runId, run.status, run.attempt_count, run.fencing_token);
    if (cas.changes !== 1) throw new RetryRaceLost();
    db.prepare(
      `INSERT INTO receipts (receipt_id, run_id, status, honesty_class, issued_by, created_at, closed_at, outcome)
       VALUES (?, ?, 'pending', 'self_attested', 'coordinator', ?, NULL, ?)`
    ).run(
      receiptId,
      runId,
      now,
      JSON.stringify({
        status: 'pending',
        attempt,
        fencing_token: fencingToken,
        mode: 'context',
        actor: 'agent',
        tainted: false,
      })
    );
    db.prepare(
      `INSERT INTO episodes (episode_id, occurred_at, recorded_at, task_slice, recommendation_id, policy_version,
        offered, acceptance, executed, run_id, attempt_id, receipt_id, verifier_result_id, prediction, cost,
        outcome, outcome_source, outcome_observed_at, eligibility)
       VALUES (?, ?, ?, ?, NULL, NULL, NULL, 'unknown', ?, ?, ?, ?, NULL, NULL, ?, 'PENDING', NULL, NULL, 0)`
    ).run(
      episodeId,
      now,
      now,
      taskSlice,
      JSON.stringify({ actor: 'unknown', recipe_id: null, model_echo: null, context_echo: null }),
      runId,
      `${runId}.a${attempt}`,
      receiptId,
      JSON.stringify({ tokens_est: 0, latency_ms: 0, attempts: attempt })
    );
    appendEvent('run.status_changed', 'run', runId, {
      from: run.status,
      to: 'running',
      via: 'retry',
      attempt,
      fencing_token: fencingToken,
      lease_until: leaseUntil,
    }, { actor: 'agent' });
    appendEvent('receipt.issued', 'receipt', receiptId, {
      run_id: runId,
      status: 'pending',
      honesty_class: 'self_attested',
      issued_by: 'coordinator',
      attempt,
    }, { actor: 'system' });
    appendEvent('episode.recorded', 'episode', episodeId, {
      run_id: runId,
      outcome: 'PENDING',
      attempt,
    }, { actor: 'system' });
  });
  try {
    // BEGIN IMMEDIATE: take the write lock before reading anything inside
    // the transaction — two racing retries serialize here, the loser's CAS
    // matches 0 rows.
    tx.immediate();
  } catch (e) {
    if (e instanceof RetryRaceLost) {
      const current = db.prepare(`SELECT status, attempt_count FROM runs WHERE run_id = ?`).get(runId) as
        | { status: RunStatus; attempt_count: number }
        | undefined;
      return {
        retried: false,
        refused: true,
        error:
          `Run ${runId}: retry lost a race — the run state changed concurrently ` +
          `(now '${current?.status ?? 'unknown'}', attempt ${current?.attempt_count ?? '?'}). No state was changed by this call.`,
        run_id: runId,
        status: current?.status,
        attempt: current?.attempt_count,
      };
    }
    throw e;
  }

  return {
    retried: true,
    run_id: runId,
    status: 'running',
    task_contract: contract,
    receipt_id: receiptId,
    episode_id: episodeId,
    attempt,
  };
}

// ─── Reaper (lazy sweep — NEVER a background thread) ─────────────────

export interface ReapResult {
  receipts_expired: number;
  runs_failed: number;
}

/**
 * Lazy sweep, called on every soul_run / soul_feedback call and at server
 * construction:
 * - pending receipts older than the TTL close as expired_unconfirmed
 *   (issued_by reaper, honesty stays self_attested — silence never upgrades);
 *   their episode outcome is back-filled as expired_unconfirmed (missingness,
 *   not a verdict) and their run is marked failed (process state).
 * - orphaned open runs whose lease expired fail with a ledger event.
 */
export function reapExpired(): ReapResult {
  const db = getDb();
  const now = nowIso();
  const cutoff = new Date(Date.now() - receiptTtlDays() * 86_400_000).toISOString();
  let receiptsExpired = 0;
  let runsFailed = 0;

  const tx = db.transaction(() => {
    const stale = db
      .prepare(`SELECT * FROM receipts WHERE status = 'pending' AND created_at <= ?`)
      .all(cutoff) as ReceiptRow[];
    for (const r of stale) {
      const detail = safeJson(r.outcome);
      db.prepare(
        `UPDATE receipts SET status = 'closed', issued_by = 'reaper', honesty_class = 'self_attested', closed_at = ?, outcome = ? WHERE receipt_id = ?`
      ).run(now, JSON.stringify({ ...detail, status: 'expired_unconfirmed' }), r.receipt_id);
      db.prepare(
        `UPDATE episodes SET outcome = 'expired_unconfirmed', outcome_source = 'expired_unconfirmed', outcome_observed_at = ? WHERE receipt_id = ? AND outcome = 'PENDING'`
      ).run(now, r.receipt_id);
      const run = db.prepare(`SELECT status FROM runs WHERE run_id = ?`).get(r.run_id) as { status: RunStatus } | undefined;
      if (run && ['queued', 'running', 'waiting_verification'].includes(run.status)) {
        db.prepare(`UPDATE runs SET status = 'failed', updated_at = ? WHERE run_id = ?`).run(now, r.run_id);
        appendEvent('run.status_changed', 'run', r.run_id, {
          from: run.status,
          to: 'failed',
          via: 'reaper',
          reason: 'receipt_ttl_expired',
        }, { actor: 'system' });
        runsFailed++;
      }
      appendEvent('receipt.closed', 'receipt', r.receipt_id, {
        run_id: r.run_id,
        status: 'expired_unconfirmed',
        issued_by: 'reaper',
        note: 'missingness, not a verdict',
      }, { actor: 'system' });
      receiptsExpired++;
    }

    // Orphaned open runs past their lease whose receipt is somehow not
    // pending anymore (defense in depth; in context mode the sweep above
    // normally covers them).
    const orphans = db
      .prepare(
        `SELECT run_id, status FROM runs
         WHERE status IN ('queued','running','waiting_verification')
           AND lease_until IS NOT NULL AND lease_until <= ?`
      )
      .all(now) as Array<{ run_id: string; status: RunStatus }>;
    for (const o of orphans) {
      db.prepare(`UPDATE runs SET status = 'failed', updated_at = ? WHERE run_id = ?`).run(now, o.run_id);
      appendEvent('run.status_changed', 'run', o.run_id, {
        from: o.status,
        to: 'failed',
        via: 'reaper',
        reason: 'lease_expired',
      }, { actor: 'system' });
      runsFailed++;
    }
  });
  tx();

  return { receipts_expired: receiptsExpired, runs_failed: runsFailed };
}

// ─── Contract views (schema-valid objects for tests/export) ──────────

export function getReceiptView(receiptId: string): ReceiptV1View | null {
  const db = getDb();
  const r = db.prepare(`SELECT * FROM receipts WHERE receipt_id = ?`).get(receiptId) as ReceiptRow | undefined;
  if (!r) return null;
  const detail = safeJson(r.outcome);
  const view: ReceiptV1View = {
    contract: 'ReceiptV1',
    receipt_id: r.receipt_id,
    run_id: r.run_id,
    attempt: (detail.attempt as number) ?? 1,
    fencing_token: (detail.fencing_token as string) ?? 'unknown',
    mode: ((detail.mode as string) ?? 'context') as ReceiptV1View['mode'],
    status: ((detail.status as string) ?? (r.status === 'pending' ? 'pending' : 'failed')) as ReceiptV1View['status'],
    honesty_class: r.honesty_class,
    actor: ((detail.actor as string) ?? 'agent') as ReceiptV1View['actor'],
    issued_by: r.issued_by,
    tainted: Boolean(detail.tainted ?? false),
    created_at: r.created_at,
  };
  if (typeof detail.outcome_summary === 'string') view.outcome_summary = detail.outcome_summary;
  if (r.closed_at) view.closed_at = r.closed_at;
  return view;
}

export function getEpisodeView(episodeId: string): Record<string, unknown> | null {
  const db = getDb();
  const e = db.prepare(`SELECT * FROM episodes WHERE episode_id = ?`).get(episodeId) as
    | Record<string, any>
    | undefined;
  if (!e) return null;
  const view: Record<string, unknown> = {
    contract: 'Episode@1',
    episode_id: e.episode_id,
    occurred_at: e.occurred_at,
    recorded_at: e.recorded_at,
    task_slice: JSON.parse(e.task_slice),
    recommendation_id: e.recommendation_id,
    policy_version: e.policy_version,
    offered: e.offered ? JSON.parse(e.offered) : null,
    acceptance: e.acceptance,
    executed: JSON.parse(e.executed),
    run_id: e.run_id,
    attempt_id: e.attempt_id,
    receipt_id: e.receipt_id,
    verifier_result_id: e.verifier_result_id,
    cost: JSON.parse(e.cost),
    outcome: e.outcome,
    outcome_observed_at: e.outcome_observed_at,
    eligibility: Boolean(e.eligibility),
  };
  if (e.domain_raw) view.domain_raw = JSON.parse(e.domain_raw);
  if (e.prediction) view.prediction = JSON.parse(e.prediction);
  if (e.outcome_source) view.outcome_source = e.outcome_source;
  return view;
}

export function getRun(runId: string): RunRow | null {
  const db = getDb();
  return (db.prepare(`SELECT * FROM runs WHERE run_id = ?`).get(runId) as RunRow | undefined) ?? null;
}

function safeJson(s: string | null): Record<string, unknown> {
  if (!s) return {};
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}
