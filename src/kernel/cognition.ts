/**
 * The cognition layer: mechanisms that make the model in front of Soul work
 * measurably better — independent of which model that is.
 *
 * Honest scope, stated plainly: an MCP server cannot raise a model's raw
 * capability. What it CAN do, and what this module does:
 *
 * 1. PREDICTION LEDGER + CALIBRATION. The model registers testable claims
 *    with probabilities (soul_predict). Due predictions come back through
 *    the workbench for resolution. From resolved predictions Soul computes
 *    the model's actual calibration (hit rate per confidence bucket, Brier
 *    score) and feeds it back into every context capsule. That is genuine
 *    self-knowledge no base model has about itself, accumulated across
 *    sessions and models.
 *
 * 2. DELIBERATION SCAFFOLDS. soul_deliberate returns a structured thinking
 *    frame for the problem at hand — decomposition, counter-hypothesis
 *    (CoVe), evidence requirements, decision + confidence — enriched with
 *    the user's own validated procedures (procedural memories) and the
 *    calibration record. Scaffold + recalled experience is where the lift
 *    comes from; the scaffold itself is deterministic text, not magic.
 */

import { getDb } from './db.js';
import { appendEvent } from './ledger.js';
import { recall } from './retrieval.js';
import { capture } from './memory.js';
import { newId, nowIso } from '../util/core.js';

// ─── Prediction ledger ───────────────────────────────────────────────

export interface Prediction {
  id: string;
  claim: string;
  probability: number;
  dueAt: string | null;
  namespace: string;
  modelHint: string | null;
  createdAt: string;
  resolvedAt: string | null;
  outcome: 'true' | 'false' | 'void' | null;
}

export function makePrediction(input: {
  claim: string;
  probability: number;
  dueAt?: string;
  namespace?: string;
  modelHint?: string;
  actor?: string;
}): Prediction {
  const db = getDb();
  const id = newId('pred');
  const now = nowIso();
  const probability = Math.max(0.01, Math.min(0.99, input.probability));
  db.prepare(
    `INSERT INTO predictions (id, claim, probability, due_at, namespace, model_hint, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, input.claim.trim(), probability, input.dueAt ?? null, input.namespace ?? 'default', input.modelHint ?? null, now);
  appendEvent('prediction.made', 'system', id, { claim: input.claim, probability, due_at: input.dueAt ?? null }, { actor: input.actor || 'agent' });
  return getPrediction(id)!;
}

export function resolvePrediction(id: string, outcome: 'true' | 'false' | 'void', actor = 'agent'): Prediction | null {
  const db = getDb();
  const p = getPrediction(id);
  if (!p || p.resolvedAt) return null;
  db.prepare(`UPDATE predictions SET resolved_at = ?, outcome = ? WHERE id = ?`).run(nowIso(), outcome, id);
  appendEvent('prediction.resolved', 'system', id, { outcome, probability: p.probability }, { actor });

  // Surprise capture (ported from anima-kernel's consolidation): a badly
  // missed prediction is the most valuable learning signal there is, so it
  // becomes a memory on its own — automatically, with honest provenance.
  if (outcome !== 'void') {
    const hit = outcome === 'true' ? 1 : 0;
    const surprise = Math.abs(p.probability - hit);
    if (surprise >= 0.5) {
      capture({
        content: `Prediction missed: claimed "${p.claim}" with ${Math.round(p.probability * 100)}% — outcome was ${outcome}. Recalibrate reasoning in this area.`,
        category: 'learning',
        type: 'episodic',
        importance: Math.min(0.9, 0.5 + surprise * 0.4),
        sourceType: 'model_assisted',
        sourceRef: `prediction:${id}`,
        actor,
      });
    }
  }
  return getPrediction(id);
}

export function getPrediction(id: string): Prediction | null {
  const row = getDb().prepare(`SELECT * FROM predictions WHERE id = ?`).get(id) as any;
  return row ? rowToPrediction(row) : null;
}

export function listPredictions(opts: { open?: boolean; dueBefore?: string; limit?: number } = {}): Prediction[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.open) where.push('resolved_at IS NULL');
  if (opts.dueBefore) { where.push('due_at IS NOT NULL AND due_at < ?'); params.push(opts.dueBefore); }
  const rows = getDb()
    .prepare(
      `SELECT * FROM predictions ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(...params, opts.limit ?? 50) as any[];
  return rows.map(rowToPrediction);
}

function rowToPrediction(row: any): Prediction {
  return {
    id: row.id,
    claim: row.claim,
    probability: row.probability,
    dueAt: row.due_at,
    namespace: row.namespace,
    modelHint: row.model_hint,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    outcome: row.outcome,
  };
}

// ─── Calibration ─────────────────────────────────────────────────────

export interface Calibration {
  resolved: number;
  brier: number | null;
  buckets: Array<{ range: string; n: number; predicted: number; actual: number }>;
  /** one-line feedback for a briefing, null while the sample is too small */
  note: string | null;
}

export function getCalibration(): Calibration {
  const rows = getDb()
    .prepare(`SELECT probability, outcome FROM predictions WHERE resolved_at IS NOT NULL AND outcome IN ('true','false')`)
    .all() as Array<{ probability: number; outcome: string }>;

  if (rows.length === 0) return { resolved: 0, brier: null, buckets: [], note: null };

  let brierSum = 0;
  const bucketDefs = [
    [0, 0.55], [0.55, 0.7], [0.7, 0.85], [0.85, 1.01],
  ] as const;
  const buckets = bucketDefs.map(([lo, hi]) => ({ lo, hi, n: 0, pSum: 0, hits: 0 }));

  for (const r of rows) {
    const hit = r.outcome === 'true' ? 1 : 0;
    brierSum += (r.probability - hit) ** 2;
    const b = buckets.find((x) => r.probability >= x.lo && r.probability < x.hi);
    if (b) { b.n++; b.pSum += r.probability; b.hits += hit; }
  }

  const outBuckets = buckets
    .filter((b) => b.n > 0)
    .map((b) => ({
      range: `${Math.round(b.lo * 100)}–${Math.round(Math.min(b.hi, 1) * 100)}%`,
      n: b.n,
      predicted: round2(b.pSum / b.n),
      actual: round2(b.hits / b.n),
    }));

  const brier = round3(brierSum / rows.length);
  let note: string | null = null;
  if (rows.length >= 5) {
    const worst = [...outBuckets].sort((a, b) => Math.abs(b.actual - b.predicted) - Math.abs(a.actual - a.predicted))[0];
    const drift = worst && Math.abs(worst.actual - worst.predicted) >= 0.15
      ? ` Largest gap: in the ${worst.range} band you predicted ~${Math.round(worst.predicted * 100)}% but hit ${Math.round(worst.actual * 100)}% (n=${worst.n}).`
      : '';
    note = `Calibration over ${rows.length} resolved predictions: Brier ${brier} (0 = perfect, 0.25 = coin flip).${drift}`;
  }
  return { resolved: rows.length, brier, buckets: outBuckets, note };
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
function round3(n: number): number { return Math.round(n * 1000) / 1000; }

// ─── Deliberation scaffolds ──────────────────────────────────────────

export type DeliberationKind = 'decision' | 'diagnosis' | 'design' | 'estimate' | 'check';

const SCAFFOLDS: Record<DeliberationKind, string[]> = {
  decision: [
    'State the decision in one sentence, and what happens if you decide nothing.',
    'List the real options (including the boring one you are tempted to skip).',
    'For your preferred option, argue the OPPOSITE: what would make it wrong? (counter-hypothesis)',
    'Name the single piece of evidence that would settle it. Can you get it cheaply? Get it first.',
    'Decide. State confidence as a probability — and register it with soul_predict if it is testable.',
  ],
  diagnosis: [
    'Describe the symptom precisely: what is observed vs. what was expected.',
    'List 3 candidate causes, most boring first. The boring cause is usually the cause.',
    'For the leading candidate: what observation would REFUTE it? Check that, not what confirms it.',
    'Reproduce or isolate before fixing. A fix without a reproduced cause is a guess.',
    'After the fix: state what you now believe and how confident you are; store the lesson with soul_remember.',
  ],
  design: [
    'Write the one-sentence goal and the hard constraints (budget, compatibility, deadline).',
    'Sketch the simplest design that could possibly work. Only then add what it provably lacks.',
    'Attack your design: which component fails first under load / edge cases / a hostile user?',
    'Name what you are deliberately NOT building, so scope creep has to announce itself.',
    'List the assumptions the design rests on; register the riskiest as a prediction (soul_predict).',
  ],
  estimate: [
    'Decompose the quantity into parts you can bound (Fermi style).',
    'Give a range, not a point: 80% confidence interval, lower and upper.',
    'Check the range against your calibration record below — widen it if your record says you are overconfident.',
    'Find one reference point from memory or the world and anchor against it.',
    'Register the estimate with soul_predict so future-you learns from it.',
  ],
  check: [
    'Restate the claim being checked, in falsifiable form.',
    'Separate what you KNOW (with source) from what you INFER. Label each.',
    'Actively search for disconfirming evidence — one honest search, not a confirming one.',
    'Verdict: supported / refuted / undecidable-with-current-evidence. No middle mush.',
    'Store the verdict with provenance (soul_remember, source_type honestly set).',
  ],
};

export interface Deliberation {
  kind: DeliberationKind;
  problem: string;
  scaffold: string[];
  calibration: string | null;
  validated_procedures: Array<{ id: string; content: string; confidence: number }>;
  note: string;
}

export async function deliberate(problem: string, kind?: DeliberationKind, namespace?: string): Promise<Deliberation> {
  const k: DeliberationKind = kind ?? inferKind(problem);
  const procedures = (
    await recall(problem, { type: 'procedural', limit: 3, namespace, silent: true })
  ).map((m) => ({ id: m.id, content: m.content, confidence: m.confidence }));
  const calibration = getCalibration().note;

  appendEvent('deliberation.opened', 'system', null, { problem, kind: k }, { actor: 'agent' });

  return {
    kind: k,
    problem,
    scaffold: SCAFFOLDS[k],
    calibration,
    validated_procedures: procedures,
    note:
      'This scaffold is deterministic structure plus your own validated procedures — work the steps in your reasoning, ' +
      'do not paste them back. Steps that produce testable claims should end in soul_predict.',
  };
}

function inferKind(problem: string): DeliberationKind {
  const p = problem.toLowerCase();
  if (/\b(bug|error|fail|broken|crash|warum|why|funktioniert nicht)\b/.test(p)) return 'diagnosis';
  if (/\b(design|architect|entwurf|structure|api|schema|aufbau)\b/.test(p)) return 'design';
  if (/\b(how (much|many|long)|wie (viel|lange)|estimate|schätz|kosten|dauer)\b/.test(p)) return 'estimate';
  if (/\b(stimmt|is it true|verify|check|prüf|claim|behauptung)\b/.test(p)) return 'check';
  return 'decision';
}
