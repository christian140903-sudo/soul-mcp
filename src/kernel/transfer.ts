/**
 * Export / import ("Soul Passport", local file edition).
 *
 * Guarantees:
 * - export -> import into an empty Soul reproduces memories, identity, goals
 *   and the event ledger with timestamps and counters intact,
 * - import is idempotent: re-importing the same file changes nothing
 *   (matched by memory id, goal id and identity aspect),
 * - a checksum over the payload detects truncated/corrupted files.
 */

import { createHash } from 'crypto';
import { getDb } from './db.js';
import { appendEvent } from './ledger.js';
import { rowToMemory, capture, type Memory } from './memory.js';
import { getAllIdentity, setIdentityFacet, type IdentityFacet } from './identity.js';
import { type Goal } from './goals.js';
import { nowIso } from '../util/core.js';

export interface SoulExportV2 {
  format: 'soul-passport';
  version: '2.0.0';
  exportedAt: string;
  checksum: string;
  memories: Memory[];
  identity: IdentityFacet[];
  goals: Goal[];
  events: Array<Record<string, unknown>>;
  meta: Record<string, string>;
}

export function exportAll(opts: { includeEvents?: boolean } = {}): SoulExportV2 {
  const db = getDb();
  const memories = (db.prepare(`SELECT * FROM memories ORDER BY created_at ASC`).all() as any[]).map(rowToMemory);
  const identity = getAllIdentity();
  const goals = (db.prepare(`SELECT * FROM goals ORDER BY created_at ASC`).all() as any[]).map((row) => ({
    id: row.id,
    title: row.title,
    description: row.description,
    kind: row.kind,
    status: row.status,
    priority: row.priority,
    progress: row.progress,
    dueAt: row.due_at,
    parentId: row.parent_id,
    namespace: row.namespace,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
  const events = opts.includeEvents === false
    ? []
    : (db.prepare(`SELECT * FROM events ORDER BY seq ASC`).all() as any[]);
  const metaRows = db.prepare(`SELECT key, value FROM meta`).all() as Array<{ key: string; value: string }>;
  const meta: Record<string, string> = {};
  for (const r of metaRows) meta[r.key] = r.value;

  const body = { memories, identity, goals, events, meta };
  const checksum = createHash('sha256').update(JSON.stringify(body)).digest('hex');

  appendEvent('data.exported', 'system', null, {
    memories: memories.length,
    identity: identity.length,
    goals: goals.length,
    events: events.length,
  });

  return {
    format: 'soul-passport',
    version: '2.0.0',
    exportedAt: nowIso(),
    checksum,
    ...body,
  };
}

export interface ImportResult {
  memories: { imported: number; skipped: number };
  identity: { imported: number; skipped: number };
  goals: { imported: number; skipped: number };
  events: { imported: number; skipped: number };
  checksumValid: boolean;
}

export function importAll(data: SoulExportV2): ImportResult {
  const db = getDb();
  if (data.format !== 'soul-passport') {
    throw new Error(`Unknown export format: ${(data as any).format ?? 'missing'}. Expected 'soul-passport'.`);
  }
  const body = {
    memories: data.memories ?? [],
    identity: data.identity ?? [],
    goals: data.goals ?? [],
    events: data.events ?? [],
    meta: data.meta ?? {},
  };
  const checksumValid =
    data.checksum === createHash('sha256').update(JSON.stringify(body)).digest('hex');

  const result: ImportResult = {
    memories: { imported: 0, skipped: 0 },
    identity: { imported: 0, skipped: 0 },
    goals: { imported: 0, skipped: 0 },
    events: { imported: 0, skipped: 0 },
    checksumValid,
  };

  const memExists = db.prepare(`SELECT 1 FROM memories WHERE id = ?`);
  const insertMem = db.prepare(
    `INSERT INTO memories (
      id, content, content_hash, type, category, tags, importance, confidence,
      sensitivity, status, namespace, source_type, source_ref, valid_from, valid_until,
      supersedes, superseded_by, contradicts, access_count, useful_count,
      created_at, updated_at, last_accessed_at, version
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const identityExists = db.prepare(`SELECT 1 FROM identity WHERE aspect = ? AND namespace = ?`);
  const insertIdentity = db.prepare(
    `INSERT INTO identity (aspect, namespace, value, confidence, evidence, status, source_type, first_seen, last_updated)
     VALUES (?,?,?,?,?,?,?,?,?)`
  );
  const goalExists = db.prepare(`SELECT 1 FROM goals WHERE id = ?`);
  const insertGoal = db.prepare(
    `INSERT INTO goals (id, title, description, kind, status, priority, progress, due_at, parent_id, namespace, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  // events are matched by (recorded_at, event_type, entity_id) — sequence
  // numbers are local to each database and not portable
  const eventExists = db.prepare(
    `SELECT 1 FROM events WHERE recorded_at = ? AND event_type = ? AND (entity_id = ? OR (entity_id IS NULL AND ? IS NULL))`
  );
  const insertEvent = db.prepare(
    `INSERT INTO events (event_type, entity_type, entity_id, payload, actor, recorded_at, valid_from, valid_until)
     VALUES (?,?,?,?,?,?,?,?)`
  );

  const tx = db.transaction(() => {
    for (const m of body.memories) {
      if (memExists.get(m.id)) {
        result.memories.skipped++;
        continue;
      }
      insertMem.run(
        m.id, m.content, m.contentHash, m.type, m.category, JSON.stringify(m.tags ?? []),
        m.importance, m.confidence, m.sensitivity, m.status, m.namespace, m.sourceType,
        m.sourceRef, m.validFrom, m.validUntil, m.supersedes, m.supersededBy,
        JSON.stringify(m.contradicts ?? []), m.accessCount, m.usefulCount,
        m.createdAt, m.updatedAt, m.lastAccessedAt, m.version
      );
      result.memories.imported++;
    }
    for (const f of body.identity) {
      if (identityExists.get(f.aspect, f.namespace ?? 'default')) {
        result.identity.skipped++;
        continue;
      }
      insertIdentity.run(
        f.aspect, f.namespace ?? 'default', f.value, f.confidence, f.evidence,
        f.status ?? 'observed', f.sourceType ?? 'import', f.firstSeen, f.lastUpdated
      );
      result.identity.imported++;
    }
    for (const g of body.goals) {
      if (goalExists.get(g.id)) {
        result.goals.skipped++;
        continue;
      }
      insertGoal.run(
        g.id, g.title, g.description, g.kind, g.status, g.priority, g.progress,
        g.dueAt, g.parentId, g.namespace, g.createdAt, g.updatedAt
      );
      result.goals.imported++;
    }
    for (const e of body.events) {
      const entityId = (e.entity_id as string | null) ?? null;
      if (eventExists.get(e.recorded_at, e.event_type, entityId, entityId)) {
        result.events.skipped++;
        continue;
      }
      insertEvent.run(
        e.event_type, e.entity_type, entityId, e.payload ?? '{}', e.actor ?? 'import',
        e.recorded_at, e.valid_from ?? null, e.valid_until ?? null
      );
      result.events.imported++;
    }
  });
  tx();

  appendEvent('data.imported', 'system', null, {
    ...result,
    checksum_valid: checksumValid,
  });

  return result;
}

/** v1 export files (from soul-mcp 1.x soul_export) can still be imported. */
export function importV1Export(data: {
  version: string;
  memories: Array<{ content: string; category: string; tags: string[]; importance: number; createdAt?: string }>;
  identity: Array<{ aspect: string; value: string; confidence: number }>;
}): { imported: number; skipped: number } {
  let imported = 0;
  let skipped = 0;
  for (const m of data.memories ?? []) {
    const r = capture({
      content: m.content,
      category: m.category,
      tags: m.tags,
      importance: m.importance,
      sourceType: 'import',
      sourceRef: 'v1-export',
    });
    if (r.outcome === 'stored' || r.outcome === 'candidate') imported++;
    else skipped++;
  }
  for (const f of data.identity ?? []) {
    setIdentityFacet(f.aspect, f.value, { confidence: f.confidence, sourceType: 'import' });
  }
  return { imported, skipped };
}
