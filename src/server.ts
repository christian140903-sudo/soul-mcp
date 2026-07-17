/**
 * Soul MCP Server — tools, resources and prompts.
 *
 * Design rules:
 * - stdout belongs to the MCP protocol; anything human goes to stderr.
 * - Every tool answers with structured JSON and a short plain message.
 * - Tools never bypass the kernel: policy, ledger and pipeline always apply.
 */

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  capture,
  confirmMemory,
  correctMemory,
  forgetMemory,
  markUseful,
  applyMemoryFeedback,
  getMemoryById,
  listMemories,
  listDisputedPairs,
  type MemoryType,
  type SourceType,
  type Volatility,
} from './kernel/memory.js';
import { recall } from './kernel/retrieval.js';
import { compileContext, getCurrentClientSessionId, endClientSession } from './kernel/context.js';
import { getDb } from './kernel/db.js';
import { newId, nowIso } from './util/core.js';
import { setIdentityFacet, getAllIdentity } from './kernel/identity.js';
import { createGoal, updateGoal, listGoals, overdueCommitments, type GoalKind, type GoalStatus } from './kernel/goals.js';
import { exportAll, importAll, importV1Export, importEnvelopeV3, isEnvelopeV3, ChecksumMismatchError, UnsupportedSectionError, type SoulExportV2 } from './kernel/transfer.js';
import { getStats, incrementSession, getSessionCount } from './kernel/stats.js';
import { queryEvents, memoriesAsOf, appendEvent } from './kernel/ledger.js';
import { loadConstitution } from './kernel/policy.js';
import { computeAssignments, resolveAssignment, openAssignmentViews } from './kernel/workbench.js';
import { makePrediction, listPredictions, getCalibration, deliberate, commitDeliberation, type DeliberationKind } from './kernel/cognition.js';
import { relatedMemories } from './kernel/semantic.js';
import { startContextRun, closeRunWithFeedback, cancelRun, resumeRun, retryRun, reapExpired, type FeedbackOutcome } from './kernel/runs.js';
import { SOUL_VERSION } from './kernel/db.js';

const MEMORY_TYPES = ['episodic', 'semantic', 'procedural', 'preference', 'relationship', 'goal', 'identity', 'working'] as const;
const SOURCE_TYPES = ['user_statement', 'agent_inference', 'document', 'tool_output', 'import', 'reflection'] as const;

function jsonResult(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

export function createSoulServer(): McpServer {
  const server = new McpServer(
    { name: 'soul', version: SOUL_VERSION },
    {
      // Served to the client at initialize time — the session protocol lives
      // here, in the server, instead of being hand-maintained in every
      // client's system prompt.
      instructions:
        "Soul is this user's persistent continuity layer (memory, identity, goals) with provenance and " +
        'an event ledger.\n' +
        '1. When the task becomes clear (once per session), call soul_context with a short task ' +
        'description and your model id as model_hint. The capsule carries identity, goals, relevant ' +
        'memories (each with source and confidence) and possibly workbench assignments addressed to you.\n' +
        '2. Store substantial NEW facts via soul_remember. Set source_type honestly: user_statement only ' +
        'for explicit statements (with source_ref citing the user\'s words), agent_inference for your own ' +
        'conclusions — that is also the default. Quality over quantity.\n' +
        '3. Never treat a disputed memory as fact — ask, or present both sides.\n' +
        '4. If the capsule carries workbench assignments and the current task allows, think them through ' +
        'and answer via soul_resolve. Guards are enforced in code; your judgment is recorded as model_assisted.\n' +
        '5. At session end (or when the user says goodbye), call soul_reflect with 2-3 sentences and real learnings.',
    }
  );

  // Reaper at server start (F09r2): a lazy sweep, never a background timer —
  // an MCP stdio server has no safe background lifecycle. Failures here must
  // never prevent the server from starting.
  try {
    reapExpired();
  } catch (err) {
    console.error('[soul] reaper sweep at startup failed:', err);
  }

  // ─── Tools ──────────────────────────────────────────────────────────

  server.registerTool(
    'soul_remember',
    {
      title: 'Remember',
      description:
        'Store a memory through the capture pipeline. The pipeline may reject secrets, quarantine ' +
        'instruction-like content, merge exact duplicates, hold sensitive content as a candidate ' +
        'until confirmed, or flag contradictions with existing memories — the result tells you which. ' +
        'Set source_type honestly: user_statement for things the user said, agent_inference for your own conclusions.',
      inputSchema: z.object({
        content: z.string().describe('What to remember. Specific beats vague: "User prefers TypeScript for backend services" not "likes TS".'),
        type: z.enum(MEMORY_TYPES).optional().describe('Memory type. Inferred from content if omitted.'),
        category: z.string().optional().describe('Category (preference, decision, learning, problem, solution, project, personal, technical, plan, health, financial, general). Auto-detected if omitted.'),
        tags: z.array(z.string()).optional(),
        importance: z.number().min(0).max(1).optional(),
        source_type: z.enum(SOURCE_TYPES).optional().describe(
          'Where this knowledge comes from. Defaults to agent_inference — the honest default for a tool ' +
          'call. user_statement additionally requires source_ref pointing at the user\'s words (quote or ' +
          'message reference); without it the write is stored as agent_inference.'
        ),
        source_ref: z.string().optional().describe('Reference to the source (file, url, message id).'),
        namespace: z.string().optional().describe('Scope, e.g. a project name. Defaults to "default".'),
        valid_from: z.string().optional().describe('ISO date when the fact became true in the world (bitemporal).'),
        valid_until: z.string().optional().describe('ISO date when the fact stops being true.'),
        volatility: z.enum(['stable', 'periodic', 'volatile']).optional().describe(
          'How fast this fact goes stale. periodic (~180d) / volatile (~30d) facts get a review window ' +
          'and return via the workbench (stale_fact) when verification is due. Default stable.'
        ),
        verification_ref: z.string().optional().describe('Source backing the fact\'s freshness (url, doc, message ref).'),
      }),
    },
    async (input) => {
      // Provenance guard: a tool call is the model writing, so the honest
      // default is agent_inference. user_statement is only accepted with a
      // source_ref citing the user's words — otherwise it is downgraded, and
      // the response says so instead of silently minting user authority.
      let sourceType: SourceType = (input.source_type as SourceType | undefined) ?? 'agent_inference';
      let provenanceNote = '';
      if (sourceType === 'user_statement' && !input.source_ref?.trim()) {
        sourceType = 'agent_inference';
        provenanceNote =
          ' [provenance] Stored as agent_inference: user_statement requires source_ref citing the ' +
          'user\'s words (quote or message reference).';
      }
      const result = capture({
        content: input.content,
        type: input.type as MemoryType | undefined,
        category: input.category,
        tags: input.tags,
        importance: input.importance,
        sourceType,
        sourceRef: input.source_ref,
        namespace: input.namespace,
        validFrom: input.valid_from,
        validUntil: input.valid_until,
        volatility: input.volatility as Volatility | undefined,
        verificationRef: input.verification_ref,
        actor: 'agent',
      });
      return jsonResult({
        outcome: result.outcome,
        id: result.memory?.id ?? null,
        status: result.memory?.status ?? null,
        source_type: result.memory?.sourceType ?? null,
        conflicts: result.conflicts,
        message: result.reason + provenanceNote,
      });
    }
  );

  server.registerTool(
    'soul_recall',
    {
      title: 'Recall',
      description:
        'Search memories. Results carry their score breakdown (lexical match, confidence, importance, ' +
        'recency, usage) and provenance. Disputed memories are returned with a flag — never treat one ' +
        'side of an open conflict as fact. Quarantined and deleted memories are never returned.',
      inputSchema: z.object({
        query: z.string().describe('Topic, keyword or question.'),
        limit: z.number().min(1).max(50).optional(),
        category: z.string().optional(),
        type: z.enum(MEMORY_TYPES).optional(),
        namespace: z.string().optional(),
      }),
    },
    async ({ query, limit, category, type, namespace }) => {
      const results = await recall(query, { limit: limit ?? 10, category, type, namespace, actor: 'agent' });
      if (results.length === 0) {
        return jsonResult({ found: 0, message: `No memories found for "${query}".` });
      }
      return jsonResult({
        found: results.length,
        memories: results.map((r, i) => ({
          rank: i + 1,
          id: r.id,
          content: r.content,
          type: r.type,
          category: r.category,
          status: r.status,
          disputed: r.disputed,
          contradicts: r.contradicts,
          confidence: r.confidence,
          source: r.sourceType + (r.sourceRef ? `:${r.sourceRef}` : ''),
          score: r.score,
          score_parts: r.scoreParts,
          age_days: r.ageInDays,
        })),
      });
    }
  );

  server.registerTool(
    'soul_context',
    {
      title: 'Compile Context',
      description:
        'Compile a token-budgeted context capsule for a task: identity, active goals, relevant memories ' +
        '(each with a reason and provenance) and known conflicts. Private-sensitivity memories are excluded ' +
        'by constitution. A receipt of what was included/excluded is written to the ledger. ' +
        'Use this at the start of a task instead of many recalls.',
      inputSchema: z.object({
        task: z.string().describe('What you are about to do. The capsule is optimized for this.'),
        token_budget: z.number().min(200).max(20000).optional().describe('Capsule size budget (default 1800 estimated tokens).'),
        namespace: z.string().optional(),
        model_hint: z.string().optional().describe(
          'Your model id/name (e.g. "claude-fable-5"). Soul tailors the capsule to the model: capable ' +
          'models receive open workbench assignments to think through, fast models receive none.'
        ),
      }),
    },
    async ({ task, token_budget, namespace, model_hint }) => {
      const capsule = await compileContext(task, {
        tokenBudget: token_budget,
        namespace,
        actor: 'agent',
        modelHint: model_hint, // model dimension: only an explicit hint
        clientName: server.server.getClientVersion()?.name, // client dimension, kept separate
      });
      return jsonResult(capsule);
    }
  );

  server.registerTool(
    'soul_workbench',
    {
      title: 'Workbench',
      description:
        'Soul\'s think-assignments for you (the Denkpartner protocol): unresolved conflicts, near-duplicate ' +
        'merge candidates, old low-confidence inferences and expiring candidates — computed deterministically, ' +
        'each with the exact answer shape. Work them through when the current task allows, then answer with ' +
        'soul_resolve. Your judgment is applied under policy guards and recorded with model_assisted provenance.',
      inputSchema: z.object({
        limit: z.number().min(1).max(20).optional().describe('Max open assignments to return (default 10).'),
      }),
    },
    async ({ limit }) => {
      const assignments = computeAssignments({ maxNew: limit ?? 10 }).slice(0, limit ?? 10);
      return jsonResult({
        open: assignments.length,
        assignments,
        message:
          assignments.length === 0
            ? 'Nothing needs judgment right now.'
            : `${assignments.length} assignment(s). Answer each via soul_resolve({assignment_id, resolution}).`,
      });
    }
  );

  server.registerTool(
    'soul_resolve',
    {
      title: 'Resolve Assignment',
      description:
        'Answer a workbench assignment. The resolution is validated against the assignment\'s schema and ' +
        'applied under guards enforced in code: nothing is hard-deleted, supersession keeps history, and a ' +
        'user statement is never overruled by a model verdict alone (outcome: needs_user).',
      inputSchema: z.object({
        assignment_id: z.string(),
        resolution: z.record(z.unknown()).describe('The answer, matching the assignment\'s respond_with shape.'),
      }),
    },
    async ({ assignment_id, resolution }) => {
      const result = resolveAssignment(assignment_id, resolution, 'agent');
      return jsonResult(result);
    }
  );

  server.registerTool(
    'soul_predict',
    {
      title: 'Register Prediction',
      description:
        'Register a testable claim with a probability. Due predictions return through the workbench for ' +
        'resolution; from resolved ones Soul computes your actual calibration (hit rate per confidence band, ' +
        'Brier score) and feeds it back into future context capsules. Badly missed predictions automatically ' +
        'become learning memories. Use whenever you state a confident, checkable claim.',
      inputSchema: z.object({
        claim: z.string().describe('The falsifiable claim, specific enough to judge later.'),
        probability: z.number().min(0.01).max(0.99).describe('Your honest probability that it is true.'),
        due_at: z.string().optional().describe('ISO date when the claim becomes judgeable.'),
        domain: z.string().optional().describe('Domain of the claim (code, planning, research, people …) — enables per-domain calibration.'),
        decision_id: z.string().optional().describe('Deliberation/decision this prediction belongs to.'),
        namespace: z.string().optional(),
      }),
    },
    async ({ claim, probability, due_at, domain, decision_id, namespace }) => {
      const p = makePrediction({
        claim,
        probability,
        dueAt: due_at,
        domain,
        decisionId: decision_id,
        namespace,
        clientSessionId: getCurrentClientSessionId() ?? undefined,
        modelHint: server.server.getClientVersion()?.name,
      });
      return jsonResult({ id: p.id, claim: p.claim, probability: p.probability, due_at: p.dueAt, message: 'Registered. It will return via the workbench when due.' });
    }
  );

  server.registerTool(
    'soul_commit_deliberation',
    {
      title: 'Commit Deliberation',
      description:
        'Close a deliberation opened by soul_deliberate: record the verdict, your confidence, and the ' +
        'assumptions it rests on. An uncommitted deliberation is an open thought — without the commit, ' +
        'the ledger never learns what was actually decided.',
      inputSchema: z.object({
        deliberation_id: z.string(),
        verdict: z.string().describe('The decision/diagnosis/design choice, in one or two sentences.'),
        confidence: z.number().min(0).max(1),
        assumptions: z.array(z.string()).optional(),
        prediction_ids: z.array(z.string()).optional().describe('Predictions registered from this deliberation.'),
      }),
    },
    async ({ deliberation_id, verdict, confidence, assumptions, prediction_ids }) => {
      const result = commitDeliberation({
        deliberationId: deliberation_id,
        verdict,
        confidence,
        assumptions,
        predictionIds: prediction_ids,
      });
      return jsonResult(result);
    }
  );

  server.registerTool(
    'soul_run',
    {
      title: 'Run (context mode)',
      description:
        'Compile a free-text task into a TaskContract@1 and open a durable run in CONTEXT mode: the server ' +
        'never spawns anything — YOU execute the task in this conversation. Run, a pending receipt ' +
        '(self_attested) and a PENDING episode are created synchronously in one transaction; the capsule ' +
        'tells you how to close them. Same idempotency_key returns the same run (no duplicate). ' +
        'When done, call soul_feedback({run_id, outcome: success|failure|mixed}); pass evidence_ref ' +
        '(e.g. a test command + exit code) as an auditable reference carried in the receipt — it does ' +
        'NOT change the honesty_class (stays self_attested; deterministic_verified requires a validated ' +
        'VerifierResult@1, which 4.0 does not produce). Without ' +
        'feedback the reaper closes the receipt after SOUL_RECEIPT_TTL_DAYS (default 7) as ' +
        'expired_unconfirmed — missingness, not a verdict. ' +
        'Lifecycle actions (all take run_id): action "cancel" cancels a queued/running run and closes ' +
        'its pending receipt as cancelled (the episode stays PENDING — no outcome was ever observed); ' +
        '"resume" idempotently re-delivers the capsule of a running run with a valid lease; ' +
        '"retry" starts a NEW attempt on a failed/cancelled/expired run (new fencing token, new pending ' +
        'receipt, new episode) and respects budget.max_attempts. Default action is "submit".',
      inputSchema: z.object({
        task: z.string().min(1).optional().describe('The task in free text — required for action "submit" (the default). Compiled deterministically into a TaskContract@1 (source: freitext_compiled).'),
        idempotency_key: z.string().min(1).max(128).optional().describe('Same key -> same run returned, never a duplicate. Generated if omitted. Submit only.'),
        budget: z
          .object({
            max_tokens: z.number().int().min(1).optional(),
            max_wall_clock_s: z.number().int().min(1).optional(),
            max_cost_eur: z.number().min(0).optional(),
            max_attempts: z.number().int().min(1).optional(),
          })
          .optional()
          .describe('Budget overrides; sensible context-mode defaults otherwise. No run without a budget. Submit only.'),
        risk: z.enum(['low', 'high']).optional().describe('high = irreversible / externally visible. Recorded in the episode task slice. Default low. Submit only.'),
        action: z
          .enum(['submit', 'cancel', 'resume', 'retry'])
          .optional()
          .describe('Lifecycle action. Default "submit" (open a new run from task). cancel/resume/retry require run_id.'),
        run_id: z.string().optional().describe('The run to cancel/resume/retry. Required for those actions, ignored for submit.'),
      }),
    },
    async ({ task, idempotency_key, budget, risk, action, run_id }) => {
      reapExpired(); // lazy sweep — the reaper runs on every run/feedback call
      const act = action ?? 'submit';

      if (act !== 'submit') {
        if (!run_id) {
          return { ...jsonResult({ error: `run_id is required for action "${act}".` }), isError: true };
        }
        if (act === 'cancel') {
          const r = cancelRun(run_id);
          if (!r.cancelled) return { ...jsonResult(r), isError: true };
          return jsonResult({
            ...r,
            mode: 'context',
            hinweis:
              'Run cancelled: the pending receipt closed as cancelled; the episode stays PENDING ' +
              '(no outcome was ever observed — missingness, not a verdict). Use action "retry" for a new attempt.',
          });
        }
        if (act === 'resume') {
          const r = resumeRun(run_id);
          if (!r.resumed) return { ...jsonResult(r), isError: true };
          return jsonResult({
            ...r,
            mode: 'context',
            existing: true,
            hinweis:
              `Same run, same receipt — nothing new was created. Execute the task in this context, then close it: ` +
              `soul_feedback({run_id: "${r.run_id}", outcome: "success"|"failure"|"mixed"}).`,
          });
        }
        // act === 'retry'
        const r = retryRun(run_id);
        if (!r.retried) return { ...jsonResult(r), isError: true };
        return jsonResult({
          ...r,
          mode: 'context',
          existing: false,
          hinweis:
            `New attempt ${r.attempt} on the same run (new fencing token, new pending receipt, new episode). ` +
            `Execute the task now, then close it: soul_feedback({run_id: "${r.run_id}", outcome: "success"|"failure"|"mixed"}).`,
        });
      }

      if (!task) {
        return { ...jsonResult({ error: 'task is required for action "submit".' }), isError: true };
      }
      const result = startContextRun({ task, idempotencyKey: idempotency_key, budget, risk });
      return jsonResult({
        run_id: result.run_id,
        status: result.status,
        mode: 'context',
        existing: result.existing,
        task_contract: result.task_contract,
        receipt_id: result.receipt_id,
        episode_id: result.episode_id,
        hinweis:
          `Execute the task now, in this context. Then close the run: soul_feedback({run_id: "${result.run_id}", ` +
          'outcome: "success"|"failure"|"mixed"}). Add evidence_ref with a verifiable reference (test run, ' +
          'exit code, diff) — it is carried in the receipt as an auditable reference; the receipt stays ' +
          'self_attested (deterministic_verified requires a validated VerifierResult@1, not built in 4.0). ' +
          'Unclosed runs expire as expired_unconfirmed.',
      });
    }
  );

  server.registerTool(
    'soul_feedback',
    {
      title: 'Capsule Feedback',
      description:
        'Close the retrieval feedback loop: report which memories from a context capsule you actually ' +
        'used and which were unhelpful. Unmentioned memories stay unknown — they are NOT marked ' +
        'unhelpful. Feeds ranking (usage weight) and the retrieval measurement base. ' +
        'Additionally closes a soul_run when run_id is set: outcome (success|failure|mixed) closes the ' +
        'pending receipt and back-fills the episode outcome bitemporally; evidence_ref is carried in the ' +
        'receipt as an auditable reference and does NOT change the honesty_class — the receipt stays ' +
        'self_attested (deterministic_verified requires a validated VerifierResult@1, which 4.0 does not ' +
        'produce).',
      inputSchema: z.object({
        context_id: z.string().optional().describe('The context_id from the soul_context capsule.'),
        used_ids: z.array(z.string()).optional().describe('Memory ids that genuinely informed your work.'),
        unhelpful_ids: z.array(z.string()).optional().describe('Memory ids that were noise for this task.'),
        run_id: z.string().optional().describe('A soul_run id to close with this feedback.'),
        outcome: z.enum(['success', 'failure', 'mixed']).optional().describe('Run outcome — required when run_id is set.'),
        evidence_ref: z.string().optional().describe('Verifiable evidence reference (test command + exit code, diff, artifact path). Carried in the receipt as an auditable reference; does NOT change the honesty_class (stays self_attested).'),
        summary: z.string().optional().describe('Short outcome summary for the receipt.'),
      }),
    },
    async ({ context_id, used_ids, unhelpful_ids, run_id, outcome, evidence_ref, summary }) => {
      if (run_id) reapExpired(); // lazy sweep on the run-closing path
      if (!context_id && !run_id) {
        return { ...jsonResult({ error: 'Provide context_id (capsule feedback) and/or run_id (run closure).' }), isError: true };
      }
      // Run closure path (additive — calls without run_id behave exactly as before).
      let runResult = null;
      if (run_id) {
        if (!outcome) {
          return { ...jsonResult({ error: 'outcome (success|failure|mixed) is required when run_id is set.' }), isError: true };
        }
        runResult = closeRunWithFeedback({ runId: run_id, outcome: outcome as FeedbackOutcome, evidenceRef: evidence_ref, summary });
      }
      if (!context_id) {
        return jsonResult({
          run: runResult,
          message: runResult?.closed
            ? `Run ${run_id} closed: receipt ${runResult.receipt_status} (${runResult.honesty_class}), episode outcome ${runResult.episode_outcome}.`
            : runResult?.already_closed
              ? `Run ${run_id}: receipt was already closed (${runResult.receipt_status}).`
              : runResult?.error ?? 'No feedback applied.',
        });
      }
      const result = applyMemoryFeedback(context_id, used_ids ?? [], unhelpful_ids ?? []);
      return jsonResult({
        ...result,
        ...(runResult ? { run: runResult } : {}),
        message:
          `Feedback recorded (${result.used} used, ${result.unhelpful} unhelpful` +
          (result.ignored > 0
            ? `; ${result.ignored} ignored — not delivered in this capsule or already rated).`
            : ').'),
      });
    }
  );

  server.registerTool(
    'soul_deliberate',
    {
      title: 'Deliberate',
      description:
        'Get a structured thinking scaffold for a hard problem: decomposition, counter-hypothesis, evidence ' +
        'checks — plus the user\'s own validated procedures from memory and your calibration record. ' +
        'Deterministic structure, not magic: the lift comes from working the steps and from recalled experience. ' +
        'Use for decisions, diagnoses, designs, estimates and claim-checks that deserve more than a reflex.',
      inputSchema: z.object({
        problem: z.string().describe('The problem, in one or two sentences.'),
        kind: z.enum(['decision', 'diagnosis', 'design', 'estimate', 'check']).optional().describe('Scaffold type. Inferred from the problem if omitted.'),
        namespace: z.string().optional(),
      }),
    },
    async ({ problem, kind, namespace }) => {
      const d = await deliberate(problem, kind as DeliberationKind | undefined, namespace);
      return jsonResult(d);
    }
  );

  server.registerTool(
    'soul_confirm',
    {
      title: 'Confirm Memory',
      description:
        'Confirm a candidate or disputed memory as true (user-verified). Confirmation raises confidence ' +
        'and upgrades status. Use after the user explicitly validates the content. Pass user_evidence ' +
        '(the user\'s confirming words) so the ledger can book this as a user action — without it the ' +
        'confirmation is applied but recorded as the agent\'s.',
      inputSchema: z.object({
        id: z.string().describe('Memory id.'),
        user_evidence: z.string().optional().describe('Quote or reference of the user\'s explicit confirmation.'),
      }),
    },
    async ({ id, user_evidence }) => {
      const memory = confirmMemory(id, { userEvidence: user_evidence });
      return jsonResult(
        memory
          ? {
              confirmed: true,
              id,
              status: memory.status,
              confidence: memory.confidence,
              booked_as: user_evidence ? 'user' : 'agent',
            }
          : { confirmed: false, message: `Memory ${id} not found.` }
      );
    }
  );

  server.registerTool(
    'soul_correct',
    {
      title: 'Correct Memory',
      description:
        'Correct a memory. The old version is kept as superseded (with the link), a new version replaces it. ' +
        'History is never silently overwritten. Pass user_evidence (the user\'s correcting words) so the ' +
        'correction carries user authority — without it, it is stored as your inference.',
      inputSchema: z.object({
        id: z.string().describe('Memory id to correct.'),
        content: z.string().describe('The corrected content.'),
        user_evidence: z.string().optional().describe('Quote or reference of the user\'s correction.'),
      }),
    },
    async ({ id, content, user_evidence }) => {
      const result = correctMemory(id, content, { userEvidence: user_evidence });
      return jsonResult({
        outcome: result.outcome,
        new_id: result.memory?.id ?? null,
        source_type: result.memory?.sourceType ?? null,
        supersedes: id,
        message:
          result.reason +
          (!user_evidence?.trim() && result.memory
            ? ' [provenance] Stored as agent_inference: pass user_evidence to book a user correction.'
            : ''),
      });
    }
  );

  server.registerTool(
    'soul_forget',
    {
      title: 'Forget',
      description:
        'Forget a memory. Default is a soft delete: content stays out of every recall and context, but the ' +
        'tombstone remains auditable. hard=true removes the row entirely (the ledger keeps only the deletion ' +
        'event). Pass user_evidence (the user\'s words asking for this) to book the deletion as a user ' +
        'action — without it the ledger records the agent.',
      inputSchema: z.object({
        id: z.string(),
        hard: z.boolean().optional().describe('true = remove row entirely. Default false.'),
        user_evidence: z.string().optional().describe('Quote or reference of the user\'s deletion request.'),
      }),
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async ({ id, hard, user_evidence }) => {
      const ok = forgetMemory(id, { hard, userEvidence: user_evidence });
      return jsonResult({
        forgotten: ok,
        id,
        mode: hard ? 'hard' : 'soft',
        booked_as: user_evidence?.trim() ? 'user' : 'agent',
        message: ok ? `Memory ${id} forgotten (${hard ? 'hard' : 'soft'}).` : `Memory ${id} not found.`,
      });
    }
  );

  server.registerTool(
    'soul_mark_useful',
    {
      title: 'Mark Useful',
      description: 'Feedback loop: useful memories rank higher in future recalls, unhelpful ones lose importance.',
      inputSchema: z.object({ id: z.string(), useful: z.boolean() }),
    },
    async ({ id, useful }) => {
      const ok = markUseful(id, useful);
      return jsonResult({ updated: ok, id, useful });
    }
  );

  server.registerTool(
    'soul_identity',
    {
      title: 'Set Identity Facet',
      description:
        'Set or update an identity facet (name, preferred_language, role, timezone …). Facets carry ' +
        'confidence, evidence count and a status separating agent inference from user confirmation. ' +
        'confirmed=true additionally requires user_evidence (the user\'s words) — without it the facet ' +
        'is stored as an observation, not a confirmation.',
      inputSchema: z.object({
        aspect: z.string(),
        value: z.string(),
        confidence: z.number().min(0).max(1).optional(),
        confirmed: z.boolean().optional().describe('true only for explicit user statements — requires user_evidence.'),
        user_evidence: z.string().optional().describe('Quote or reference of the user\'s explicit statement.'),
        namespace: z.string().optional(),
      }),
    },
    async ({ aspect, value, confidence, confirmed, user_evidence, namespace }) => {
      const facet = setIdentityFacet(aspect, value, {
        confidence,
        confirmed,
        userEvidence: user_evidence,
        namespace,
      });
      const downgraded = confirmed === true && !user_evidence?.trim();
      return jsonResult({
        identity: facet,
        message:
          `${facet.aspect} = "${facet.value}" (${Math.round(facet.confidence * 100)}%, ${facet.status}, ${facet.evidence} evidence)` +
          (downgraded
            ? ' [provenance] Stored as observed/agent_inference: confirmed=true requires user_evidence citing the user\'s words.'
            : ''),
      });
    }
  );

  server.registerTool(
    'soul_about_me',
    {
      title: 'About Me',
      description:
        'Everything Soul knows about the user: identity facets (with confidence and status), active goals, ' +
        'preferences and open conflicts. Answers "what do you know about me?" honestly — inferences are ' +
        'labeled as inferences.',
      inputSchema: z.object({ namespace: z.string().optional() }),
    },
    async ({ namespace }) => {
      const identity = getAllIdentity(namespace);
      const stats = getStats();
      const goals = listGoals({ status: ['active', 'blocked'], namespace, limit: 10 });
      const preferences = await recall('preference prefers likes style', { limit: 8, type: 'preference', namespace, silent: true });
      const conflicts = listDisputedPairs(5);
      return jsonResult({
        sessions_together: getSessionCount(),
        identity: identity.map((f) => ({
          aspect: f.aspect,
          value: f.value,
          confidence: f.confidence,
          status: f.status,
        })),
        active_goals: goals.map((g) => ({ title: g.title, kind: g.kind, due_at: g.dueAt, progress: g.progress })),
        preferences: preferences.map((p) => ({ content: p.content, status: p.status, disputed: p.disputed })),
        open_conflicts: conflicts.map((c) => ({ a: c.a.content, b: c.b.content })),
        memory_totals: stats.byStatus,
        message:
          identity.length > 0
            ? `${identity.length} identity facets, ${goals.length} active goals, ${conflicts.length} unresolved conflicts.`
            : `We're just getting started — no identity facets yet.`,
      });
    }
  );

  server.registerTool(
    'soul_goal',
    {
      title: 'Goals & Commitments',
      description:
        'Manage goals and commitments. A commitment is a promise (usually with a due date) — Soul tracks it ' +
        'separately from mere intentions. action=list also reports overdue commitments. Pass user_evidence ' +
        '(the user\'s words) when the user stated the goal/change — without it the ledger books the agent.',
      inputSchema: z.object({
        action: z.enum(['create', 'update', 'complete', 'list']),
        id: z.string().optional().describe('Goal id (for update/complete).'),
        title: z.string().optional(),
        description: z.string().optional(),
        kind: z.enum(['goal', 'commitment', 'milestone']).optional(),
        status: z.enum(['active', 'completed', 'blocked', 'abandoned']).optional(),
        progress: z.number().min(0).max(1).optional(),
        priority: z.number().min(1).max(5).optional(),
        due_at: z.string().optional().describe('ISO date.'),
        user_evidence: z.string().optional().describe('Quote or reference of the user\'s words behind this change.'),
        namespace: z.string().optional(),
      }),
    },
    async (input) => {
      switch (input.action) {
        case 'create': {
          if (!input.title) return jsonResult({ error: 'title is required for create' });
          const goal = createGoal({
            title: input.title,
            description: input.description,
            kind: input.kind as GoalKind | undefined,
            priority: input.priority,
            dueAt: input.due_at,
            namespace: input.namespace,
            userEvidence: input.user_evidence,
          });
          return jsonResult({ created: goal, booked_as: input.user_evidence?.trim() ? 'user' : 'agent' });
        }
        case 'update':
        case 'complete': {
          if (!input.id) return jsonResult({ error: 'id is required' });
          const goal = updateGoal(input.id, {
            status: input.action === 'complete' ? 'completed' : (input.status as GoalStatus | undefined),
            progress: input.action === 'complete' ? 1 : input.progress,
            title: input.title,
            description: input.description,
            priority: input.priority,
            dueAt: input.due_at,
          }, input.user_evidence);
          return jsonResult(goal ? { updated: goal, booked_as: input.user_evidence?.trim() ? 'user' : 'agent' } : { error: `Goal ${input.id} not found.` });
        }
        case 'list': {
          const goals = listGoals({
            status: input.status ? [input.status as GoalStatus] : ['active', 'blocked'],
            namespace: input.namespace,
          });
          const overdue = overdueCommitments(input.namespace);
          return jsonResult({
            goals,
            overdue_commitments: overdue.map((g) => ({ id: g.id, title: g.title, due_at: g.dueAt })),
          });
        }
      }
    }
  );

  server.registerTool(
    'soul_timeline',
    {
      title: 'Timeline & Time Travel',
      description:
        'Query the event ledger. Without as_of: recent events (optionally filtered by entity_id or event_type). ' +
        'With as_of (ISO date): cognitive time travel — which memories did Soul consider active at that time, ' +
        'derived from the ledger, not reconstructed by guesswork.',
      inputSchema: z.object({
        entity_id: z.string().optional(),
        event_type: z.string().optional(),
        since: z.string().optional(),
        until: z.string().optional(),
        as_of: z.string().optional().describe('ISO date for time travel.'),
        limit: z.number().min(1).max(200).optional(),
      }),
    },
    async ({ entity_id, event_type, since, until, as_of, limit }) => {
      if (as_of) {
        const memories = memoriesAsOf(as_of, limit ?? 100);
        return jsonResult({ as_of, active_memories_then: memories.length, memories });
      }
      const events = queryEvents({ entityId: entity_id, eventType: event_type, since, until, limit });
      return jsonResult({ events });
    }
  );

  server.registerTool(
    'soul_reflect',
    {
      title: 'Reflect',
      description:
        'End-of-session reflection: the session summary goes into its own session_reflections table ' +
        '(it is a diary entry, not a fact — it no longer dilutes integrity metrics); only genuinely ' +
        'reusable learnings become reflection-sourced memories. Optionally close the retrieval feedback ' +
        'loop via memory_feedback. Increments the session counter and ends the client session.',
      inputSchema: z.object({
        summary: z.string().optional(),
        learnings: z.array(z.string()).optional(),
        identity_updates: z.array(z.object({ aspect: z.string(), value: z.string() })).optional(),
        memory_feedback: z
          .object({
            context_id: z.string(),
            used_ids: z.array(z.string()).optional(),
            unhelpful_ids: z.array(z.string()).optional(),
          })
          .optional()
          .describe('Which capsule memories were actually used/unhelpful this session.'),
      }),
    },
    async ({ summary, learnings, identity_updates, memory_feedback }) => {
      const sessionNumber = incrementSession();
      const stored: string[] = [];
      if (summary) {
        // diary entry, not a memory: session_reflections (v3.1, S6 fix) —
        // insert + ledger event atomically, so the summary stays visible on
        // the timeline (soul_timeline) even though it left the memories table
        const db = getDb();
        const srefId = newId('sref');
        const writeReflection = db.transaction(() => {
          db.prepare(
            `INSERT INTO session_reflections (id, session_number, summary, learnings_count, client_session_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).run(srefId, sessionNumber, summary, (learnings ?? []).length, getCurrentClientSessionId(), nowIso());
          appendEvent('session.reflected', 'system', srefId, {
            session_number: sessionNumber,
            summary,
            learnings_count: (learnings ?? []).length,
          }, { actor: 'agent' });
        });
        writeReflection();
      }
      for (const learning of learnings ?? []) {
        const r = capture({ content: learning, category: 'learning', importance: 0.6, sourceType: 'reflection' });
        if (r.memory) stored.push(r.memory.id);
      }
      const facets = (identity_updates ?? []).map((u) =>
        setIdentityFacet(u.aspect, u.value, { sourceType: 'reflection' })
      );
      const feedback = memory_feedback
        ? applyMemoryFeedback(memory_feedback.context_id, memory_feedback.used_ids ?? [], memory_feedback.unhelpful_ids ?? [])
        : null;
      endClientSession();
      const stats = getStats();
      return jsonResult({
        session: sessionNumber,
        summary_stored: !!summary,
        learnings_stored: stored.length,
        ...(feedback ? { feedback } : {}),
        identity_updates: facets.map((f) => ({ aspect: f.aspect, value: f.value, confidence: f.confidence })),
        soul_status: { memories: stats.totalMemories, integrity: stats.integrity },
      });
    }
  );

  server.registerTool(
    'soul_status',
    {
      title: 'Status',
      description:
        'Soul health dashboard: memory counts by status/type, event count, and the knowledge-integrity ' +
        'report (confirmed share, disputed count, stale share, provenance coverage).',
      inputSchema: z.object({}),
    },
    async () => {
      const stats = getStats();
      return jsonResult({ version: SOUL_VERSION, sessions: getSessionCount(), ...stats });
    }
  );

  server.registerTool(
    'soul_review_queue',
    {
      title: 'Review Queue',
      description:
        'The memory inbox: candidates awaiting confirmation, quarantined content awaiting inspection, and ' +
        'disputed pairs awaiting resolution. Resolve with soul_confirm / soul_forget / soul_correct.',
      inputSchema: z.object({ limit: z.number().min(1).max(50).optional() }),
    },
    async ({ limit }) => {
      const candidates = listMemories({ status: ['candidate'], limit: limit ?? 20 });
      const quarantined = listMemories({ status: ['quarantined'], limit: limit ?? 20 });
      const disputed = listDisputedPairs(limit ?? 10);
      return jsonResult({
        candidates: candidates.map((m) => ({ id: m.id, content: m.content, category: m.category, created_at: m.createdAt })),
        quarantined: quarantined.map((m) => ({ id: m.id, content: m.content, reason: 'matched injection patterns' })),
        disputed_pairs: disputed.map((p) => ({
          a: { id: p.a.id, content: p.a.content },
          b: { id: p.b.id, content: p.b.content },
        })),
      });
    }
  );

  server.registerTool(
    'soul_export',
    {
      title: 'Export (Soul Passport)',
      description:
        'Export everything — memories (all statuses), identity, goals, the full event ledger and meta — as a ' +
        'checksummed soul-passport JSON. restore(export(soul)) == soul.',
      inputSchema: z.object({
        include_events: z.boolean().optional().describe('Include the event ledger (default true).'),
      }),
    },
    async ({ include_events }) => {
      const data = exportAll({ includeEvents: include_events !== false });
      return jsonResult(data);
    }
  );

  server.registerTool(
    'soul_import',
    {
      title: 'Import',
      description:
        'Import a soul-passport export (v2) or a legacy v1 export. v2 imports are idempotent — re-importing ' +
        'the same file changes nothing. A checksum mismatch refuses the import (the file was altered after ' +
        'export). Live memories are screened on import: secrets are dropped, injection-like content is ' +
        'quarantined, and user_statement provenance without a source_ref is downgraded to import.',
      inputSchema: z.object({ data: z.string().describe('The JSON string from soul_export.') }),
    },
    async ({ data }) => {
      // Availability guard (threat model TB3): refuse oversized payloads
      // before JSON.parse touches them — a passport is bounded data, not a
      // bulk channel. 50 MB is ~100x a large real soul.
      const MAX_IMPORT_BYTES = Number(process.env.SOUL_MAX_IMPORT_BYTES) || 50 * 1024 * 1024;
      if (Buffer.byteLength(data, 'utf8') > MAX_IMPORT_BYTES) {
        return {
          ...jsonResult({
            success: false,
            error: `Import exceeds ${MAX_IMPORT_BYTES} bytes — refused before parsing.`,
            reason: 'too_large',
          }),
          isError: true,
        };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return { ...jsonResult({ success: false, error: 'Not valid JSON.' }), isError: true };
      }
      try {
        const obj = parsed as Record<string, unknown>;
        // Forward-compat (3.2.0): a PassportEnvelope@3 is read through the
        // sectioned reader; its verified 'core' section runs the same 2.0.0
        // import path. exportAll still writes 2.0.0 (F01).
        if (isEnvelopeV3(obj)) {
          const result = importEnvelopeV3(obj);
          return jsonResult({ success: true, format: 'envelope-v3', ...result });
        }
        if (obj.format === 'soul-passport') {
          const result = importAll(obj as unknown as SoulExportV2);
          return jsonResult({ success: true, format: 'v2', ...result });
        }
        if (obj.version === '1.0.0' && Array.isArray(obj.memories)) {
          const result = importV1Export(obj as any);
          return jsonResult({ success: true, format: 'v1-legacy', ...result });
        }
        return { ...jsonResult({ success: false, error: 'Unrecognized export format.' }), isError: true };
      } catch (err) {
        const reason = err instanceof ChecksumMismatchError
          ? 'checksum_mismatch'
          : err instanceof UnsupportedSectionError
            ? 'unsupported_required_section'
            : undefined;
        return {
          ...jsonResult({
            success: false,
            error: String(err instanceof Error ? err.message : err),
            ...(reason ? { reason } : {}),
          }),
          isError: true,
        };
      }
    }
  );

  // ─── Resources ──────────────────────────────────────────────────────

  const staticResource = (name: string, uri: string, description: string, fetch: () => unknown) => {
    server.registerResource(
      name,
      uri,
      { description, mimeType: 'application/json' },
      async () => ({
        contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(fetch(), null, 2) }],
      })
    );
  };

  staticResource('identity', 'soul://identity', 'Identity facets with confidence and status', () =>
    getAllIdentity()
  );
  staticResource('status', 'soul://status', 'Soul health and knowledge integrity', () => getStats());
  staticResource('goals', 'soul://goals', 'Active goals and commitments', () => ({
    goals: listGoals({}),
    overdue: overdueCommitments(),
  }));
  staticResource('constitution', 'soul://constitution', 'The active constitution (policy rules)', () =>
    loadConstitution()
  );
  staticResource('conflicts', 'soul://conflicts', 'Unresolved disputed memory pairs', () =>
    listDisputedPairs(20).map((p) => ({ a: p.a, b: p.b }))
  );
  staticResource('timeline', 'soul://timeline', 'The 50 most recent ledger events', () =>
    queryEvents({ limit: 50 })
  );
  staticResource('workbench', 'soul://workbench', 'Open think-assignments (Denkpartner protocol)', () =>
    openAssignmentViews()
  );
  staticResource('calibration', 'soul://calibration', 'The model\'s prediction calibration record', () => ({
    calibration: getCalibration(),
    open_predictions: listPredictions({ open: true, limit: 20 }),
  }));

  server.registerResource(
    'memory',
    new ResourceTemplate('soul://memory/{id}', { list: undefined }),
    { description: 'A single memory with full provenance', mimeType: 'application/json' },
    async (uri, { id }) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(
            {
              memory: getMemoryById(String(id)),
              related: relatedMemories(String(id), 5), // live embedding neighbors; [] when semantic is off
              history: queryEvents({ entityId: String(id), limit: 50 }),
            },
            null,
            2
          ),
        },
      ],
    })
  );

  // ─── Prompts ────────────────────────────────────────────────────────

  server.registerPrompt(
    'soul-session-start',
    { description: 'Load the right context at the start of a session' },
    async () => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text:
              'Start this session with continuity: call soul_context with a short description of what we are ' +
              'about to work on. Check soul_goal action=list for overdue commitments and mention them if any. ' +
              'Do not dump everything — the capsule is the context.',
          },
        },
      ],
    })
  );

  server.registerPrompt(
    'soul-daily-review',
    { description: 'Review candidates, conflicts and overdue commitments' },
    async () => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text:
              'Run a Soul review: call soul_review_queue. For each candidate, ask me confirm/correct/forget. ' +
              'For each disputed pair, show both sides and ask which is right (or whether both hold in different ' +
              'contexts — then correct them to be context-specific). For quarantined items, show them and ask ' +
              'whether to delete. Finish with soul_goal action=list to surface overdue commitments.',
          },
        },
      ],
    })
  );

  server.registerPrompt(
    'soul-session-end',
    { description: 'Reflect and consolidate before ending a session' },
    async () => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text:
              'Close the session: call soul_reflect with a 2-3 sentence summary and the key learnings ' +
              '(only genuinely new ones — no filler). Update identity facets only for things I explicitly stated.',
          },
        },
      ],
    })
  );

  return server;
}
