/**
 * Memory model + capture pipeline.
 *
 * Nothing is written directly: every mutation goes through the capture
 * pipeline (policy check -> secret/injection screening -> dedup -> conflict
 * check -> status decision) and every outcome is recorded in the ledger.
 *
 * The conflict check is a word-overlap heuristic on preference/identity/goal
 * memories — deterministic and cheap, not semantic understanding. It flags
 * pairs as 'disputed' instead of silently overwriting either one.
 */

import { getDb } from './db.js';
import { appendEvent } from './ledger.js';
import {
  storeRuleFor,
  detectSecret,
  detectInjection,
  classifySensitiveCategory,
} from './policy.js';
import { newId, contentHash, canonicalize, nowIso } from '../util/core.js';

export type MemoryType =
  | 'episodic'
  | 'semantic'
  | 'procedural'
  | 'preference'
  | 'relationship'
  | 'goal'
  | 'identity'
  | 'working';

export type MemoryStatus =
  | 'candidate'
  | 'active'
  | 'confirmed'
  | 'disputed'
  | 'superseded'
  | 'expired'
  | 'deleted'
  | 'quarantined'
  | 'rejected';

export type SourceType =
  | 'user_statement'
  | 'agent_inference'
  | 'document'
  | 'tool_output'
  | 'import'
  | 'migration'
  | 'reflection';

export interface Memory {
  id: string;
  content: string;
  contentHash: string;
  type: MemoryType;
  category: string;
  tags: string[];
  importance: number;
  confidence: number;
  sensitivity: string;
  status: MemoryStatus;
  namespace: string;
  sourceType: SourceType;
  sourceRef: string | null;
  validFrom: string | null;
  validUntil: string | null;
  supersedes: string | null;
  supersededBy: string | null;
  contradicts: string[];
  accessCount: number;
  usefulCount: number;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string | null;
  version: number;
}

export interface CaptureInput {
  content: string;
  type?: MemoryType;
  category?: string;
  tags?: string[];
  importance?: number;
  confidence?: number;
  sensitivity?: string;
  namespace?: string;
  sourceType?: SourceType;
  sourceRef?: string;
  validFrom?: string;
  validUntil?: string;
  actor?: string;
}

export interface CaptureResult {
  outcome: 'stored' | 'candidate' | 'merged' | 'quarantined' | 'rejected';
  memory: Memory | null;
  reason: string;
  conflicts: string[];
}

// ─── Capture pipeline ────────────────────────────────────────────────

export function capture(input: CaptureInput): CaptureResult {
  const db = getDb();
  const actor = input.actor || 'agent';
  const content = input.content.trim();
  if (!content) {
    return { outcome: 'rejected', memory: null, reason: 'empty content', conflicts: [] };
  }

  // 1. Secrets are never stored. Only a redacted event remains.
  const secretKind = detectSecret(content);
  if (secretKind) {
    appendEvent('memory.rejected', 'memory', null, {
      reason: `secret detected (${secretKind})`,
      content_redacted: true,
    }, { actor });
    return {
      outcome: 'rejected',
      memory: null,
      reason: `Content contains a ${secretKind} and was not stored. Secrets are never persisted (constitution: store.secrets = never).`,
      conflicts: [],
    };
  }

  // 2. Injection-looking content is stored but quarantined: it exists,
  //    it is inspectable, but it will never be recalled into context.
  const injected = detectInjection(content);

  // 3. Category + sensitivity
  const sensitiveCategory = classifySensitiveCategory(content);
  const category = input.category || sensitiveCategory || autoCategorize(content);
  const sensitivity = input.sensitivity || (sensitiveCategory ? 'private' : 'personal');
  const rule = storeRuleFor(category);

  if (rule === 'never') {
    appendEvent('memory.rejected', 'memory', null, { reason: `constitution: store.${category} = never` }, { actor });
    return {
      outcome: 'rejected',
      memory: null,
      reason: `Constitution forbids storing '${category}' content (store.${category} = never).`,
      conflicts: [],
    };
  }

  // 4. Exact duplicate (same canonical content in the same namespace) -> merge
  const namespace = input.namespace || 'default';
  const hash = contentHash(content);
  const dup = db
    .prepare(
      `SELECT id FROM memories WHERE content_hash = ? AND namespace = ?
       AND status IN ('candidate','active','confirmed','disputed') LIMIT 1`
    )
    .get(hash, namespace) as { id: string } | undefined;

  if (dup) {
    const now = nowIso();
    db.prepare(
      `UPDATE memories SET useful_count = useful_count + 1,
         importance = MIN(1.0, importance + 0.05),
         confidence = MIN(1.0, confidence + 0.05),
         updated_at = ? WHERE id = ?`
    ).run(now, dup.id);
    appendEvent('memory.merged', 'memory', dup.id, { reason: 'exact duplicate re-captured' }, { actor });
    return {
      outcome: 'merged',
      memory: getMemoryById(dup.id),
      reason: `Duplicate of ${dup.id}; its importance and confidence were reinforced instead of storing a copy.`,
      conflicts: [],
    };
  }

  // 5. Insert
  const type = input.type || typeFromCategory(category);
  const status: MemoryStatus = injected
    ? 'quarantined'
    : rule === 'confirm'
      ? 'candidate'
      : 'active';

  const id = newId('mem');
  const now = nowIso();
  const memory: Memory = {
    id,
    content,
    contentHash: hash,
    type,
    category,
    tags: input.tags || autoTags(content),
    importance: clamp01(input.importance ?? estimateImportance(content)),
    confidence: clamp01(input.confidence ?? defaultConfidence(input.sourceType || 'user_statement')),
    sensitivity,
    status,
    namespace,
    sourceType: input.sourceType || 'user_statement',
    sourceRef: input.sourceRef || null,
    validFrom: input.validFrom || null,
    validUntil: input.validUntil || null,
    supersedes: null,
    supersededBy: null,
    contradicts: [],
    accessCount: 0,
    usefulCount: 0,
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: null,
    version: 1,
  };

  const tx = db.transaction(() => {
    insertMemoryRow(memory);
    appendEvent('memory.captured', 'memory', id, {
      content,
      type,
      category,
      status,
      source_type: memory.sourceType,
    }, { actor, validFrom: input.validFrom, validUntil: input.validUntil });

    if (status === 'quarantined') {
      appendEvent('memory.quarantined', 'memory', id, {
        reason: 'content matches stored-instruction/injection patterns',
      }, { actor });
    }
  });
  tx();

  // 6. Conflict check (after insert so both sides can be linked)
  let conflicts: string[] = [];
  if (status === 'active' && ['preference', 'identity', 'goal'].includes(type)) {
    conflicts = detectConflicts(memory);
  }

  const stored = getMemoryById(id)!;
  return {
    outcome: status === 'quarantined' ? 'quarantined' : status === 'candidate' ? 'candidate' : 'stored',
    memory: stored,
    reason:
      status === 'quarantined'
        ? 'Stored in quarantine: the content looks like an instruction aimed at future contexts. It will not be recalled until reviewed.'
        : status === 'candidate'
          ? `Stored as candidate: the constitution requires confirmation for '${category}' content. Confirm it with soul_confirm.`
          : conflicts.length
            ? `Stored, but it may contradict ${conflicts.join(', ')} — both sides are now marked 'disputed' instead of overwriting either.`
            : 'Stored.',
    conflicts,
  };
}

/**
 * Word-overlap conflict heuristic: an active memory of the same type that
 * shares most significant words but differs in content is a potential
 * contradiction. Both are marked 'disputed' and linked; nothing is deleted.
 */
function detectConflicts(memory: Memory): string[] {
  const db = getDb();
  const words = significantWords(memory.content);
  if (words.length < 2) return [];

  const candidates = db
    .prepare(
      `SELECT id, content FROM memories
       WHERE type = ? AND namespace = ? AND id != ?
       AND status IN ('active','confirmed','disputed')
       LIMIT 200`
    )
    .all(memory.type, memory.namespace, memory.id) as Array<{ id: string; content: string }>;

  const conflicts: string[] = [];
  for (const c of candidates) {
    const otherWords = significantWords(c.content);
    if (otherWords.length < 2) continue;
    const overlap = words.filter((w) => otherWords.includes(w)).length;
    const jaccard = overlap / new Set([...words, ...otherWords]).size;
    if (jaccard >= 0.4 && canonicalize(c.content) !== canonicalize(memory.content)) {
      conflicts.push(c.id);
    }
  }

  if (conflicts.length) {
    const now = nowIso();
    const tx = db.transaction(() => {
      for (const otherId of conflicts) {
        linkContradiction(memory.id, otherId, now);
        appendEvent('memory.disputed', 'memory', memory.id, { contradicts: otherId }, {});
      }
    });
    tx();
  }
  return conflicts;
}

function linkContradiction(aId: string, bId: string, now: string): void {
  const db = getDb();
  for (const [selfId, otherId] of [[aId, bId], [bId, aId]] as const) {
    const row = db.prepare(`SELECT contradicts FROM memories WHERE id = ?`).get(selfId) as
      | { contradicts: string }
      | undefined;
    if (!row) continue;
    const list: string[] = safeParseArray(row.contradicts);
    if (!list.includes(otherId)) list.push(otherId);
    db.prepare(
      `UPDATE memories SET contradicts = ?, status = 'disputed', updated_at = ? WHERE id = ?`
    ).run(JSON.stringify(list), now, selfId);
  }
}

// ─── Lifecycle operations ────────────────────────────────────────────

export function confirmMemory(id: string, actor = 'user'): Memory | null {
  const db = getDb();
  const mem = getMemoryById(id);
  if (!mem) return null;
  const now = nowIso();
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE memories SET status = 'confirmed', confidence = MIN(1.0, confidence + 0.2), updated_at = ? WHERE id = ?`
    ).run(now, id);
    appendEvent('memory.confirmed', 'memory', id, { previous_status: mem.status }, { actor });
  });
  tx();
  return getMemoryById(id);
}

/**
 * Correction = supersession, never in-place mutation of content.
 * The old memory stays (status 'superseded'), a new version replaces it,
 * and the ledger records the link.
 */
export function correctMemory(id: string, newContent: string, actor = 'user'): CaptureResult {
  const db = getDb();
  const old = getMemoryById(id);
  if (!old) {
    return { outcome: 'rejected', memory: null, reason: `Memory ${id} not found.`, conflicts: [] };
  }
  const result = capture({
    content: newContent,
    type: old.type,
    category: old.category,
    tags: old.tags,
    importance: old.importance,
    confidence: Math.min(1.0, old.confidence + 0.1),
    sensitivity: old.sensitivity,
    namespace: old.namespace,
    sourceType: 'user_statement',
    sourceRef: `correction_of:${id}`,
    actor,
  });
  if (result.memory && result.outcome !== 'rejected') {
    const now = nowIso();
    const tx = db.transaction(() => {
      db.prepare(
        `UPDATE memories SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?`
      ).run(result.memory!.id, now, id);
      db.prepare(`UPDATE memories SET supersedes = ? WHERE id = ?`).run(id, result.memory!.id);
      appendEvent('memory.superseded', 'memory', id, { superseded_by: result.memory!.id }, { actor });
      appendEvent('memory.corrected', 'memory', result.memory!.id, { supersedes: id }, { actor });
    });
    tx();
    result.memory = getMemoryById(result.memory.id);
  }
  return result;
}

/** Soft delete by default (state + ledger keep the tombstone); hard removes the row. */
export function forgetMemory(id: string, opts: { hard?: boolean; actor?: string } = {}): boolean {
  const db = getDb();
  const mem = getMemoryById(id);
  if (!mem) return false;
  const actor = opts.actor || 'user';
  const tx = db.transaction(() => {
    if (opts.hard) {
      db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
      appendEvent('memory.deleted', 'memory', id, { hard: true, content_removed: true }, { actor });
    } else {
      db.prepare(`UPDATE memories SET status = 'deleted', updated_at = ? WHERE id = ?`).run(nowIso(), id);
      appendEvent('memory.deleted', 'memory', id, { hard: false }, { actor });
    }
  });
  tx();
  return true;
}

export function markUseful(id: string, useful: boolean): boolean {
  const db = getDb();
  const result = useful
    ? db.prepare(
        `UPDATE memories SET useful_count = useful_count + 1, updated_at = ? WHERE id = ?`
      ).run(nowIso(), id)
    : db.prepare(
        `UPDATE memories SET importance = MAX(0, importance - 0.05), updated_at = ? WHERE id = ?`
      ).run(nowIso(), id);
  return result.changes > 0;
}

/** Expire candidates that waited longer than the constitution's retention window. */
export function expireStaleCandidates(maxAgeMs: number): number {
  const db = getDb();
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const stale = db
    .prepare(`SELECT id FROM memories WHERE status = 'candidate' AND created_at < ?`)
    .all(cutoff) as Array<{ id: string }>;
  const tx = db.transaction(() => {
    for (const row of stale) {
      db.prepare(`UPDATE memories SET status = 'expired', updated_at = ? WHERE id = ?`).run(nowIso(), row.id);
      appendEvent('memory.expired', 'memory', row.id, { reason: 'candidate confirmation window elapsed' }, {});
    }
  });
  tx();
  return stale.length;
}

// ─── Reads ───────────────────────────────────────────────────────────

export function getMemoryById(id: string): Memory | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id) as any;
  return row ? rowToMemory(row) : null;
}

export function listMemories(opts: {
  status?: string[];
  namespace?: string;
  category?: string;
  limit?: number;
  offset?: number;
} = {}): Memory[] {
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];
  const statuses = opts.status ?? ['active', 'confirmed', 'disputed', 'candidate'];
  where.push(`status IN (${statuses.map(() => '?').join(',')})`);
  params.push(...statuses);
  if (opts.namespace) {
    where.push('namespace = ?');
    params.push(opts.namespace);
  }
  if (opts.category) {
    where.push('category = ?');
    params.push(opts.category);
  }
  params.push(opts.limit ?? 100, opts.offset ?? 0);
  const rows = db
    .prepare(
      `SELECT * FROM memories WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    )
    .all(...params) as any[];
  return rows.map(rowToMemory);
}

export function countByStatus(): Record<string, number> {
  const db = getDb();
  const rows = db
    .prepare(`SELECT status, COUNT(*) as c FROM memories GROUP BY status`)
    .all() as Array<{ status: string; c: number }>;
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = r.c;
  return out;
}

export function listDisputedPairs(limit = 20): Array<{ a: Memory; b: Memory }> {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM memories WHERE status = 'disputed' ORDER BY updated_at DESC LIMIT ?`)
    .all(limit * 2) as any[];
  const seen = new Set<string>();
  const pairs: Array<{ a: Memory; b: Memory }> = [];
  for (const row of rows) {
    const a = rowToMemory(row);
    for (const otherId of a.contradicts) {
      const key = [a.id, otherId].sort().join('|');
      if (seen.has(key)) continue;
      const b = getMemoryById(otherId);
      if (b) {
        seen.add(key);
        pairs.push({ a, b });
        if (pairs.length >= limit) return pairs;
      }
    }
  }
  return pairs;
}

// ─── Internals ───────────────────────────────────────────────────────

function insertMemoryRow(m: Memory): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO memories (
      id, content, content_hash, type, category, tags, importance, confidence,
      sensitivity, status, namespace, source_type, source_ref, valid_from, valid_until,
      supersedes, superseded_by, contradicts, access_count, useful_count,
      created_at, updated_at, last_accessed_at, version
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    m.id, m.content, m.contentHash, m.type, m.category, JSON.stringify(m.tags),
    m.importance, m.confidence, m.sensitivity, m.status, m.namespace, m.sourceType,
    m.sourceRef, m.validFrom, m.validUntil, m.supersedes, m.supersededBy,
    JSON.stringify(m.contradicts), m.accessCount, m.usefulCount,
    m.createdAt, m.updatedAt, m.lastAccessedAt, m.version
  );
}

export function rowToMemory(row: any): Memory {
  return {
    id: row.id,
    content: row.content,
    contentHash: row.content_hash,
    type: row.type,
    category: row.category,
    tags: safeParseArray(row.tags),
    importance: row.importance,
    confidence: row.confidence,
    sensitivity: row.sensitivity,
    status: row.status,
    namespace: row.namespace,
    sourceType: row.source_type,
    sourceRef: row.source_ref,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    supersedes: row.supersedes,
    supersededBy: row.superseded_by,
    contradicts: safeParseArray(row.contradicts),
    accessCount: row.access_count,
    usefulCount: row.useful_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastAccessedAt: row.last_accessed_at,
    version: row.version,
  };
}

function safeParseArray(s: string): string[] {
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** Agent inferences start lower than explicit user statements. */
function defaultConfidence(sourceType: SourceType): number {
  switch (sourceType) {
    case 'user_statement': return 0.8;
    case 'document': return 0.7;
    case 'tool_output': return 0.7;
    case 'import': return 0.6;
    case 'migration': return 0.6;
    case 'reflection': return 0.5;
    case 'agent_inference': return 0.4;
  }
}

const STOPWORDS = new Set([
  'the','a','an','is','are','was','were','be','to','of','and','or','in','on','for','with','that','this',
  'i','my','me','user','prefers','prefer','likes','like','uses','use','using',
  'der','die','das','ein','eine','ist','sind','und','oder','für','mit','ich','mein','nutzer',
]);

function significantWords(content: string): string[] {
  return Array.from(
    new Set(
      canonicalize(content)
        .split(/[^a-zA-Z0-9äöüß.+#-]+/)
        .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    )
  );
}

function typeFromCategory(category: string): MemoryType {
  const map: Record<string, MemoryType> = {
    preference: 'preference',
    decision: 'episodic',
    learning: 'semantic',
    problem: 'episodic',
    solution: 'procedural',
    project: 'semantic',
    personal: 'identity',
    technical: 'semantic',
    plan: 'goal',
    relationship: 'relationship',
    health: 'identity',
    financial: 'identity',
  };
  return map[category] || 'semantic';
}

function autoCategorize(content: string): string {
  const lower = content.toLowerCase();
  const patterns: Array<[RegExp, string]> = [
    [/\b(bug|error|fix|crash|issue|debug|exception|stack\s*trace)\b/, 'problem'],
    [/\b(prefer|like|dislike|hate|love|favorite|rather|style|lieber|bevorzug)\w*\b/, 'preference'],
    [/\b(decided|chose|picked|went\s+with|switched\s+to|entschieden)\b/, 'decision'],
    [/\b(learned|realized|discovered|understood|figured\s+out|til|insight|gelernt)\b/, 'learning'],
    [/\b(todo|plan|will|going\s+to|next|upcoming|schedule|deadline|bis\s+freitag|zusage)\b/, 'plan'],
    [/\b(project|working\s+on|building|developing|creating|app|website|projekt)\b/, 'project'],
    [/\b(name|email|phone|birthday|location|job|role|company|geburtstag)\b/, 'personal'],
    [/\b(function|class|api|database|server|deploy|git|npm|code)\b/, 'technical'],
    [/\b(solved|solution|workaround|approach|method|technique|pattern|lösung)\b/, 'solution'],
  ];
  for (const [pattern, category] of patterns) {
    if (pattern.test(lower)) return category;
  }
  return 'general';
}

function autoTags(content: string): string[] {
  const tags = new Set<string>();
  const lower = content.toLowerCase();
  const techTerms = [
    'javascript','typescript','python','rust','go','java','c++','ruby','php','swift',
    'react','vue','angular','svelte','next.js','nuxt','express','fastapi','django',
    'node.js','deno','bun','docker','kubernetes','aws','gcp','azure',
    'postgresql','mysql','mongodb','redis','sqlite','prisma','drizzle',
    'tailwind','css','html','graphql','rest','grpc',
    'claude','gpt','openai','anthropic','gemini','llm','mcp',
    'git','github','gitlab','npm','yarn','pnpm','obsidian',
  ];
  for (const term of techTerms) {
    if (lower.includes(term)) tags.add(term);
  }
  return Array.from(tags).slice(0, 5);
}

function estimateImportance(content: string): number {
  let score = 0.5;
  const lower = content.toLowerCase();
  if (/\b(important|critical|crucial|key|essential|must|always|never|wichtig|entscheidend)\b/.test(lower)) score += 0.15;
  if (/\b(decided|chose|will\s+use|switched\s+to|entschieden)\b/.test(lower)) score += 0.1;
  if (/\b(learned|realized|discovered|insight|gelernt)\b/.test(lower)) score += 0.1;
  if (/\b(name|identity|who\s+i\s+am|my\s+name)\b/.test(lower)) score += 0.2;
  if (/\b(maybe|perhaps|might|could|sometimes|vielleicht)\b/.test(lower)) score -= 0.05;
  if (content.length < 20) score -= 0.1;
  if (content.length > 500) score += 0.05;
  return clamp01(Math.max(0.1, score));
}
