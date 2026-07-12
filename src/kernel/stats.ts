/**
 * Statistics + the Knowledge Integrity report: not "how much does Soul know"
 * but "how healthy is what it knows" — confirmed share, disputed count,
 * stale share, provenance coverage. All directly computed, no invented score.
 */

import { getDb } from './db.js';
import { countByStatus } from './memory.js';

export interface SoulStats {
  totalMemories: number;
  byStatus: Record<string, number>;
  byType: Record<string, number>;
  byCategory: Record<string, number>;
  totalEvents: number;
  totalGoals: number;
  identityFacets: number;
  totalAccesses: number;
  totalUseful: number;
  oldestMemory: string | null;
  newestMemory: string | null;
  integrity: {
    confirmed_share: number;
    disputed_count: number;
    quarantined_count: number;
    candidates_waiting: number;
    stale_share_180d: number;
    provenance_coverage: number;
    note: string;
  };
}

export function getStats(): SoulStats {
  const db = getDb();
  const one = <T>(sql: string): T => (db.prepare(sql).get() as any) as T;

  const byStatus = countByStatus();
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
  const liveStatuses = ['active', 'confirmed', 'disputed'];
  const live = liveStatuses.reduce((a, s) => a + (byStatus[s] || 0), 0);

  const byType: Record<string, number> = {};
  for (const r of db.prepare(`SELECT type, COUNT(*) c FROM memories GROUP BY type`).all() as any[]) {
    byType[r.type] = r.c;
  }
  const byCategory: Record<string, number> = {};
  for (const r of db.prepare(`SELECT category, COUNT(*) c FROM memories GROUP BY category`).all() as any[]) {
    byCategory[r.category] = r.c;
  }

  const staleCutoff = new Date(Date.now() - 180 * 86_400_000).toISOString();
  const staleLive = (db.prepare(
    `SELECT COUNT(*) c FROM memories WHERE status IN ('active','confirmed','disputed')
     AND updated_at < ? AND (last_accessed_at IS NULL OR last_accessed_at < ?)`
  ).get(staleCutoff, staleCutoff) as { c: number }).c;

  const withProvenance = (one<{ c: number }>(
    `SELECT COUNT(*) c FROM memories WHERE source_type IS NOT NULL AND source_type != ''`
  )).c;

  return {
    totalMemories: total,
    byStatus,
    byType,
    byCategory,
    totalEvents: (one<{ c: number }>(`SELECT COUNT(*) c FROM events`)).c,
    totalGoals: (one<{ c: number }>(`SELECT COUNT(*) c FROM goals`)).c,
    identityFacets: (one<{ c: number }>(`SELECT COUNT(*) c FROM identity`)).c,
    totalAccesses: (one<{ s: number | null }>(`SELECT SUM(access_count) s FROM memories`)).s || 0,
    totalUseful: (one<{ s: number | null }>(`SELECT SUM(useful_count) s FROM memories`)).s || 0,
    oldestMemory: (one<{ m: string | null }>(`SELECT MIN(created_at) m FROM memories`)).m,
    newestMemory: (one<{ m: string | null }>(`SELECT MAX(created_at) m FROM memories`)).m,
    integrity: {
      confirmed_share: live > 0 ? round2((byStatus['confirmed'] || 0) / live) : 0,
      disputed_count: byStatus['disputed'] || 0,
      quarantined_count: byStatus['quarantined'] || 0,
      candidates_waiting: byStatus['candidate'] || 0,
      stale_share_180d: live > 0 ? round2(staleLive / live) : 0,
      provenance_coverage: total > 0 ? round2(withProvenance / total) : 1,
      note: 'directly computed ratios, not a composite score',
    },
  };
}

export function incrementSession(): number {
  const db = getDb();
  const current = (db.prepare(`SELECT value FROM meta WHERE key = 'total_sessions'`).get() as any)?.value || '0';
  const next = parseInt(current, 10) + 1;
  db.prepare(
    `INSERT INTO meta (key, value, updated_at) VALUES ('total_sessions', ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(String(next));
  return next;
}

export function getSessionCount(): number {
  const db = getDb();
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'total_sessions'`).get() as any;
  return parseInt(row?.value || '0', 10);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
