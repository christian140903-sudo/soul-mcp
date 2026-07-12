/**
 * Hybrid retrieval: FTS5 candidates -> deterministic re-ranking.
 *
 * The score is a documented, inspectable formula (recall results carry their
 * component scores), not a black box:
 *
 *   score = fts * (0.45)          lexical relevance (normalized bm25)
 *         + confidence * 0.20     how much Soul trusts the memory
 *         + importance * 0.15     how much it matters
 *         + recency * 0.10        logarithmic decay over age
 *         + usage * 0.10          log-scaled useful/access feedback
 *
 * Quarantined, rejected, deleted, expired and superseded memories are never
 * returned by default. Disputed memories ARE returned, flagged, so the caller
 * sees the conflict instead of one arbitrary side of it.
 */

import { getDb } from './db.js';
import { loadConstitution } from './policy.js';
import { rowToMemory, type Memory } from './memory.js';
import { appendEvent } from './ledger.js';
import { nowIso } from '../util/core.js';

export interface RecallOptions {
  limit?: number;
  category?: string;
  type?: string;
  namespace?: string;
  includeStatus?: string[];
  /** don't log a memory.recalled event or bump access counts (used by doctor/tests) */
  silent?: boolean;
  actor?: string;
}

export interface ScoredMemory extends Memory {
  score: number;
  scoreParts: {
    fts: number;
    confidence: number;
    importance: number;
    recency: number;
    usage: number;
  };
  ageInDays: number;
  disputed: boolean;
}

export function recall(query: string, opts: RecallOptions = {}): ScoredMemory[] {
  const db = getDb();
  const constitution = loadConstitution();
  const limit = Math.min(opts.limit ?? 10, 50);
  const statuses = opts.includeStatus ?? constitution.recall.include_status;

  const where: string[] = [`m.status IN (${statuses.map(() => '?').join(',')})`];
  const params: unknown[] = [...statuses];
  if (opts.category) { where.push('m.category = ?'); params.push(opts.category); }
  if (opts.type) { where.push('m.type = ?'); params.push(opts.type); }
  if (opts.namespace) { where.push('m.namespace = ?'); params.push(opts.namespace); }

  let rows: any[];
  const ftsQuery = sanitizeFtsQuery(query);
  try {
    rows = db
      .prepare(
        `SELECT m.*, bm25(memories_fts) AS bm25_rank
         FROM memories_fts fts
         JOIN memories m ON m.rowid = fts.rowid
         WHERE memories_fts MATCH ? AND ${where.join(' AND ')}
         ORDER BY bm25_rank LIMIT ?`
      )
      .all(ftsQuery, ...params, limit * 4);
  } catch {
    rows = [];
  }
  if (rows.length === 0) {
    // LIKE fallback for queries FTS can't parse or that match nothing exactly
    rows = db
      .prepare(
        `SELECT m.*, 0 AS bm25_rank FROM memories m
         WHERE m.content LIKE ? AND ${where.join(' AND ')}
         ORDER BY m.importance DESC LIMIT ?`
      )
      .all(`%${query.replace(/[%_]/g, ' ')}%`, ...params, limit * 4);
  }

  const now = Date.now();
  const scored: ScoredMemory[] = rows.map((row) => {
    const m = rowToMemory(row);
    const ageInDays = Math.max(0, (now - new Date(m.createdAt).getTime()) / 86_400_000);
    // bm25 is negative-better in fts5; normalize to 0..1
    const rawBm25 = Math.abs(row.bm25_rank || 0);
    const fts = rawBm25 > 0 ? Math.min(1, rawBm25 / 10) : 0.3;
    const recency = 1 / (1 + Math.log1p(ageInDays / 30));
    const usage = Math.min(1, (Math.log1p(m.usefulCount) * 0.5 + Math.log1p(m.accessCount) * 0.2) / 2);
    const scoreParts = {
      fts: round3(fts * 0.45),
      confidence: round3(m.confidence * 0.2),
      importance: round3(m.importance * 0.15),
      recency: round3(recency * 0.1),
      usage: round3(usage * 0.1),
    };
    const score = round3(
      scoreParts.fts + scoreParts.confidence + scoreParts.importance + scoreParts.recency + scoreParts.usage
    );
    return { ...m, score, scoreParts, ageInDays: Math.round(ageInDays * 10) / 10, disputed: m.status === 'disputed' };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, limit);

  if (!opts.silent && top.length > 0) {
    const db2 = getDb();
    const bump = db2.prepare(
      `UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?`
    );
    const tx = db2.transaction(() => {
      const ts = nowIso();
      for (const r of top) bump.run(ts, r.id);
      appendEvent('memory.recalled', 'system', null, {
        query,
        returned: top.map((r) => r.id),
      }, { actor: opts.actor || 'agent' });
    });
    tx();
  }

  return top;
}

export function sanitizeFtsQuery(query: string): string {
  const cleaned = query.replace(/['"*(){}[\]^~\\:]/g, ' ').trim();
  const words = cleaned.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return '""';
  return words.map((w) => `"${w}"`).join(' OR ');
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
