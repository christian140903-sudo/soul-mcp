/**
 * Context compiler: assemble the smallest useful context capsule for a task,
 * inside a token budget, with a reason attached to every included item
 * (proof-carrying context) and a receipt in the ledger.
 *
 * Token counts are chars/4 estimates and are labeled as estimates in the
 * capsule itself.
 */

import { recall, type ScoredMemory } from './retrieval.js';
import { getAllIdentity } from './identity.js';
import { listGoals } from './goals.js';
import { listDisputedPairs } from './memory.js';
import { loadConstitution } from './policy.js';
import { appendEvent } from './ledger.js';
import { estimateTokens } from '../util/core.js';

export interface CapsuleItem {
  id: string;
  content: string;
  reason: string;
  confidence: number;
  source: string;
  disputed?: boolean;
}

export interface ContextCapsule {
  task: string;
  token_budget: number;
  token_estimate: number;
  token_note: 'token counts are chars/4 estimates, not a tokenizer';
  identity: Array<{ aspect: string; value: string; confidence: number }>;
  active_goals: Array<{ id: string; title: string; status: string; due_at: string | null }>;
  relevant_memories: CapsuleItem[];
  known_conflicts: Array<{ a: string; b: string; note: string }>;
  excluded: { by_sensitivity: number; by_budget: number };
}

export interface CompileOptions {
  tokenBudget?: number;
  namespace?: string;
  maxMemories?: number;
  actor?: string;
}

export function compileContext(task: string, opts: CompileOptions = {}): ContextCapsule {
  const constitution = loadConstitution();
  const budget = Math.max(200, Math.min(opts.tokenBudget ?? 1800, 20000));
  const excludedSensitivity = new Set(constitution.recall.exclude_sensitivity_from_context);

  // 1. Identity: highest-confidence facets, always cheap
  const identity = getAllIdentity(opts.namespace)
    .filter((f) => f.confidence >= 0.3)
    .slice(0, 8)
    .map((f) => ({ aspect: f.aspect, value: f.value, confidence: round2(f.confidence) }));

  // 2. Active goals
  const goals = listGoals({ status: ['active', 'blocked'], namespace: opts.namespace, limit: 5 })
    .map((g) => ({ id: g.id, title: g.title, status: g.status, due_at: g.dueAt }));

  // 3. Task-relevant memories (over-fetch, then budget-trim)
  const fetched = recall(task, {
    limit: opts.maxMemories ?? 25,
    namespace: opts.namespace,
    actor: opts.actor || 'context-compiler',
  });

  let excludedBySensitivity = 0;
  const eligible: ScoredMemory[] = [];
  for (const m of fetched) {
    if (excludedSensitivity.has(m.sensitivity as never)) {
      excludedBySensitivity++;
      continue;
    }
    eligible.push(m);
  }

  // 4. Budget trim: identity + goals are counted first, memories fill the rest
  const fixedCost =
    estimateTokens(JSON.stringify(identity)) + estimateTokens(JSON.stringify(goals)) + 100;
  let remaining = budget - fixedCost;
  const included: CapsuleItem[] = [];
  let excludedByBudget = 0;
  for (const m of eligible) {
    const cost = estimateTokens(m.content) + 30;
    if (remaining - cost < 0) {
      excludedByBudget++;
      continue;
    }
    remaining -= cost;
    included.push({
      id: m.id,
      content: m.content,
      reason: describeReason(m),
      confidence: round2(m.confidence),
      source: m.sourceType + (m.sourceRef ? `:${m.sourceRef}` : ''),
      ...(m.disputed ? { disputed: true } : {}),
    });
  }

  // 5. Conflicts that involve included memories (the caller must see them)
  const includedIds = new Set(included.map((i) => i.id));
  const conflicts = listDisputedPairs(10)
    .filter((p) => includedIds.has(p.a.id) || includedIds.has(p.b.id))
    .map((p) => ({
      a: p.a.id,
      b: p.b.id,
      note: `"${truncate(p.a.content, 80)}" vs "${truncate(p.b.content, 80)}" — unresolved, do not treat either as fact`,
    }));

  const capsule: ContextCapsule = {
    task,
    token_budget: budget,
    token_estimate: budget - remaining,
    token_note: 'token counts are chars/4 estimates, not a tokenizer',
    identity,
    active_goals: goals,
    relevant_memories: included,
    known_conflicts: conflicts,
    excluded: { by_sensitivity: excludedBySensitivity, by_budget: excludedByBudget },
  };

  // 6. Receipt in the ledger: what was used, what was withheld, and why
  appendEvent('context.compiled', 'system', null, {
    task,
    included: included.map((i) => i.id),
    excluded_by_sensitivity: excludedBySensitivity,
    excluded_by_budget: excludedByBudget,
    token_estimate: capsule.token_estimate,
  }, { actor: opts.actor || 'context-compiler' });

  return capsule;
}

function describeReason(m: ScoredMemory): string {
  const dominant = Object.entries(m.scoreParts).sort((a, b) => b[1] - a[1])[0]![0];
  const names: Record<string, string> = {
    fts: 'matches the task keywords',
    confidence: 'high-trust memory',
    importance: 'marked important',
    recency: 'recent',
    usage: 'proven useful before',
  };
  return `${names[dominant] || 'relevant'} (score ${m.score}, ${m.status})`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
