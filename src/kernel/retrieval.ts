/**
 * Hybrid retrieval: FTS5 + optional semantic candidates -> deterministic
 * re-ranking.
 *
 * The score is a documented, inspectable formula (recall results carry their
 * component scores), not a black box. Two weight sets exist:
 *
 * lexical-only (semantic layer off or unavailable):
 *   score = fts * 0.45           lexical relevance (normalized bm25)
 *         + confidence * 0.20    how much Soul trusts the memory
 *         + importance * 0.15    how much it matters
 *         + recency * 0.10       logarithmic decay over age
 *         + usage * 0.10         log-scaled useful/access feedback
 *
 * hybrid (semantic layer on — `soul-mcp semantic on`):
 *   score = fts * 0.30
 *         + semantic * 0.30      calibrated embedding similarity
 *         + confidence * 0.15
 *         + importance * 0.10
 *         + recency * 0.10
 *         + usage * 0.05
 *
 * Candidates are the union of FTS matches and embedding neighbors, so a
 * paraphrase with zero keyword overlap can still be found. Memories without
 * a stored vector score semantic=0 until the backfill sweep reaches them.
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
import { embedQuery, semanticCandidates, getVector, cosine, calibrateSimilarity } from './semantic.js';

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
    semantic: number;
    confidence: number;
    importance: number;
    recency: number;
    usage: number;
  };
  ageInDays: number;
  disputed: boolean;
}

const WEIGHTS_LEXICAL = { fts: 0.45, semantic: 0, confidence: 0.2, importance: 0.15, recency: 0.1, usage: 0.1 };
const WEIGHTS_HYBRID = { fts: 0.3, semantic: 0.3, confidence: 0.15, importance: 0.1, recency: 0.1, usage: 0.05 };

export async function recall(query: string, opts: RecallOptions = {}): Promise<ScoredMemory[]> {
  const db = getDb();
  const constitution = loadConstitution();
  const limit = Math.min(opts.limit ?? 10, 50);
  const statuses = opts.includeStatus ?? constitution.recall.include_status;

  const where: string[] = [`m.status IN (${statuses.map(() => '?').join(',')})`];
  const params: unknown[] = [...statuses];
  if (opts.category) { where.push('m.category = ?'); params.push(opts.category); }
  if (opts.type) { where.push('m.type = ?'); params.push(opts.type); }
  if (opts.namespace) { where.push('m.namespace = ?'); params.push(opts.namespace); }

  // Semantic neighbors (null query vector = layer off/unavailable -> pure lexical)
  const queryVec = await embedQuery(query);

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

  // Union in embedding neighbors that FTS didn't surface
  if (queryVec) {
    const seen = new Set(rows.map((r) => r.id as string));
    const neighborIds = semanticCandidates(queryVec, limit * 4)
      .map((c) => c.id)
      .filter((id) => !seen.has(id));
    if (neighborIds.length > 0) {
      const semRows = db
        .prepare(
          `SELECT m.*, NULL AS bm25_rank FROM memories m
           WHERE m.id IN (${neighborIds.map(() => '?').join(',')}) AND ${where.join(' AND ')}`
        )
        .all(...neighborIds, ...params);
      rows = rows.concat(semRows);
    }
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

  const weights = queryVec ? WEIGHTS_HYBRID : WEIGHTS_LEXICAL;
  const now = Date.now();

  // Raw cosines per candidate, first pass. e5 similarities are compressed —
  // on a single-topic corpus everything lands within a few hundredths of each
  // other and the absolute calibration alone barely discriminates. So the
  // component blends the absolute band rescale with a min–max normalization
  // WITHIN this candidate set (only when the set is big enough and actually
  // has spread). Deterministic, documented, visible in scoreParts.
  const rawSims = new Map<string, number>();
  if (queryVec) {
    for (const row of rows) {
      const vec = getVector(row.id);
      if (vec && vec.length === queryVec.length) rawSims.set(row.id, cosine(queryVec, vec));
    }
  }
  const simValues = [...rawSims.values()];
  const simMin = Math.min(...simValues);
  const simMax = Math.max(...simValues);
  const useRelative = simValues.length >= 3 && simMax - simMin >= 0.03;
  const semanticComponent = (id: string): number => {
    const cos = rawSims.get(id);
    if (cos === undefined) return 0;
    const absolute = calibrateSimilarity(cos);
    if (!useRelative) return absolute;
    const relative = (cos - simMin) / (simMax - simMin);
    return 0.5 * absolute + 0.5 * relative;
  };

  const scored: ScoredMemory[] = rows.map((row) => {
    const m = rowToMemory(row);
    const ageInDays = Math.max(0, (now - new Date(m.createdAt).getTime()) / 86_400_000);
    // bm25 is negative-better in fts5; normalize to 0..1.
    // NULL bm25_rank = semantic-only candidate (no keyword match) -> fts 0;
    // 0 = LIKE fallback row -> neutral 0.3, as in v2.
    const fts =
      row.bm25_rank === null
        ? 0
        : Math.abs(row.bm25_rank) > 0
          ? Math.min(1, Math.abs(row.bm25_rank) / 10)
          : 0.3;
    const semantic = semanticComponent(m.id);
    const recency = 1 / (1 + Math.log1p(ageInDays / 30));
    const usage = Math.min(1, (Math.log1p(m.usefulCount) * 0.5 + Math.log1p(m.accessCount) * 0.2) / 2);
    const scoreParts = {
      fts: round3(fts * weights.fts),
      semantic: round3(semantic * weights.semantic),
      confidence: round3(m.confidence * weights.confidence),
      importance: round3(m.importance * weights.importance),
      recency: round3(recency * weights.recency),
      usage: round3(usage * weights.usage),
    };
    const score = round3(
      scoreParts.fts + scoreParts.semantic + scoreParts.confidence +
      scoreParts.importance + scoreParts.recency + scoreParts.usage
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
        mode: queryVec ? 'hybrid' : 'lexical',
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
