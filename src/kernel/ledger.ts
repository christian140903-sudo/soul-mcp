/**
 * Event ledger: append-only record of everything Soul does.
 *
 * Two time axes per event (bitemporal):
 * - recorded_at: when Soul learned/did it (always set)
 * - valid_from / valid_until: when the fact was true in the world (optional)
 */

import { getDb } from './db.js';
import { nowIso } from '../util/core.js';

export type EventType =
  | 'memory.captured'
  | 'memory.promoted'
  | 'memory.quarantined'
  | 'memory.rejected'
  | 'memory.confirmed'
  | 'memory.corrected'
  | 'memory.merged'
  | 'memory.disputed'
  | 'memory.superseded'
  | 'memory.expired'
  | 'memory.deleted'
  | 'memory.recalled'
  | 'memory.migrated'
  | 'identity.updated'
  | 'goal.created'
  | 'goal.updated'
  | 'goal.completed'
  | 'context.compiled'
  | 'session.reflected'
  | 'data.exported'
  | 'data.imported'
  | 'import.memory_skipped'
  | 'import.provenance_downgraded'
  | 'import.section_skipped'
  | 'system.backup'
  | 'system.semantic'
  | 'memory.undisputed'
  | 'workbench.issued'
  | 'workbench.resolved'
  | 'prediction.made'
  | 'prediction.resolved'
  | 'deliberation.opened'
  | 'deliberation.committed'
  | 'memory.verified'
  | 'session.started'
  | 'session.ended'
  | 'memory.consolidated';

export interface SoulEvent {
  seq: number;
  eventType: EventType;
  entityType: string;
  entityId: string | null;
  payload: Record<string, unknown>;
  actor: string;
  recordedAt: string;
  validFrom: string | null;
  validUntil: string | null;
}

export interface AppendOptions {
  actor?: string;
  validFrom?: string;
  validUntil?: string;
}

export function appendEvent(
  eventType: EventType,
  entityType: string,
  entityId: string | null,
  payload: Record<string, unknown> = {},
  opts: AppendOptions = {}
): number {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO events (event_type, entity_type, entity_id, payload, actor, recorded_at, valid_from, valid_until)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      eventType,
      entityType,
      entityId,
      JSON.stringify(payload),
      opts.actor || 'system',
      nowIso(),
      opts.validFrom || null,
      opts.validUntil || null
    );
  return Number(result.lastInsertRowid);
}

export interface TimelineQuery {
  entityId?: string;
  eventType?: string;
  since?: string;
  until?: string;
  limit?: number;
}

export function queryEvents(q: TimelineQuery = {}): SoulEvent[] {
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.entityId) {
    where.push('entity_id = ?');
    params.push(q.entityId);
  }
  if (q.eventType) {
    where.push('event_type = ?');
    params.push(q.eventType);
  }
  if (q.since) {
    where.push('recorded_at >= ?');
    params.push(q.since);
  }
  if (q.until) {
    where.push('recorded_at <= ?');
    params.push(q.until);
  }
  const sql = `
    SELECT * FROM events
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY seq DESC LIMIT ?`;
  params.push(Math.min(q.limit ?? 50, 500));
  const rows = db.prepare(sql).all(...params) as any[];
  return rows.map(rowToEvent);
}

/**
 * Cognitive time travel: which memories did Soul consider active at `asOf`?
 * Derived from the ledger: captured/promoted before asOf, and not
 * superseded/deleted/expired by an event recorded before asOf.
 */
export function memoriesAsOf(asOf: string, limit = 100): Array<{ id: string; content: string }> {
  const db = getDb();
  const rows = db
    .prepare(
      `
    SELECT DISTINCT e.entity_id AS id
    FROM events e
    WHERE e.entity_type = 'memory'
      AND e.event_type IN ('memory.captured','memory.promoted','memory.migrated','memory.confirmed')
      AND e.recorded_at <= ?
      AND e.entity_id NOT IN (
        SELECT entity_id FROM events
        WHERE entity_type = 'memory'
          AND event_type IN ('memory.deleted','memory.superseded','memory.expired','memory.rejected','memory.quarantined')
          AND recorded_at <= ?
          AND entity_id IS NOT NULL
      )
    LIMIT ?`
    )
    .all(asOf, asOf, limit) as Array<{ id: string }>;

  const getContent = db.prepare(`SELECT content FROM memories WHERE id = ?`);
  const getCaptured = db.prepare(
    `SELECT payload FROM events WHERE entity_id = ? AND event_type IN ('memory.captured','memory.migrated') ORDER BY seq ASC LIMIT 1`
  );
  return rows.map((r) => {
    const current = getContent.get(r.id) as { content: string } | undefined;
    if (current) return { id: r.id, content: current.content };
    // memory was later hard-deleted from state; recover content from the capture event
    const ev = getCaptured.get(r.id) as { payload: string } | undefined;
    const payload = ev ? safeJson(ev.payload) : {};
    return { id: r.id, content: (payload.content as string) || '[content no longer available]' };
  });
}

function rowToEvent(row: any): SoulEvent {
  return {
    seq: row.seq,
    eventType: row.event_type,
    entityType: row.entity_type,
    entityId: row.entity_id,
    payload: safeJson(row.payload),
    actor: row.actor,
    recordedAt: row.recorded_at,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
  };
}

function safeJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
