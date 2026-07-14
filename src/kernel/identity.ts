/**
 * Identity facets: stable aspects of the user, per namespace,
 * with confidence, evidence count and a status that separates
 * "the agent inferred this" from "the user confirmed this".
 */

import { getDb } from './db.js';
import { appendEvent } from './ledger.js';
import { nowIso } from '../util/core.js';

export interface IdentityFacet {
  aspect: string;
  namespace: string;
  value: string;
  confidence: number;
  evidence: number;
  status: 'observed' | 'confirmed';
  sourceType: string;
  firstSeen: string;
  lastUpdated: string;
}

export function setIdentityFacet(
  aspect: string,
  value: string,
  opts: {
    confidence?: number;
    namespace?: string;
    sourceType?: string;
    confirmed?: boolean;
    actor?: string;
    /** The user's confirming words. Required for confirmed=true to take effect. */
    userEvidence?: string;
  } = {}
): IdentityFacet {
  const db = getDb();
  const namespace = opts.namespace || 'default';
  const now = nowIso();

  // Provenance guard, enforced in the kernel (not just the tool layer): a
  // facet becomes user-confirmed only with real evidence of the user's words
  // (whitespace does not count), and the actor 'user' exists only together
  // with that evidence — no caller can override either direction.
  const evidence = opts.userEvidence?.trim() || undefined;
  const confirmed = opts.confirmed === true && !!evidence;
  const downgraded = opts.confirmed === true && !evidence;
  if (confirmed) {
    opts = { ...opts, userEvidence: evidence, sourceType: opts.sourceType || 'user_statement', actor: 'user' };
  } else {
    const safeActor = opts.actor && opts.actor !== 'user' ? opts.actor : 'agent';
    opts = downgraded
      ? { ...opts, userEvidence: undefined, sourceType: 'agent_inference', actor: safeActor }
      : { ...opts, userEvidence: undefined, actor: safeActor };
  }
  opts = { ...opts, confirmed };
  const existing = db
    .prepare(`SELECT * FROM identity WHERE aspect = ? AND namespace = ?`)
    .get(aspect, namespace) as any;

  const tx = db.transaction(() => {
    if (existing) {
      const valueChanged = existing.value !== value;
      const confidence =
        opts.confidence ?? (valueChanged ? Math.max(0.3, existing.confidence - 0.1) : Math.min(1.0, existing.confidence + 0.05));
      // An earlier confirmation covers only the value the user confirmed:
      // a CHANGED value without fresh evidence drops back to 'observed'.
      // An unchanged value keeps whatever status it had.
      const status = opts.confirmed ? 'confirmed' : valueChanged ? 'observed' : existing.status;
      db.prepare(
        `UPDATE identity SET value = ?, confidence = ?, evidence = evidence + 1,
         status = ?, source_type = ?, last_updated = ?
         WHERE aspect = ? AND namespace = ?`
      ).run(
        value,
        confidence,
        status,
        opts.sourceType || existing.source_type,
        now,
        aspect,
        namespace
      );
      appendEvent('identity.updated', 'identity', `${namespace}:${aspect}`, {
        value,
        previous_value: valueChanged ? existing.value : undefined,
        confidence,
        ...(opts.userEvidence && confirmed ? { user_evidence: opts.userEvidence } : {}),
      }, { actor: opts.actor || 'agent' });
    } else {
      db.prepare(
        `INSERT INTO identity (aspect, namespace, value, confidence, evidence, status, source_type, first_seen, last_updated)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`
      ).run(
        aspect,
        namespace,
        value,
        opts.confidence ?? 0.3,
        opts.confirmed ? 'confirmed' : 'observed',
        opts.sourceType || 'agent_inference',
        now,
        now
      );
      appendEvent('identity.updated', 'identity', `${namespace}:${aspect}`, {
        value,
        new: true,
        ...(opts.userEvidence && confirmed ? { user_evidence: opts.userEvidence } : {}),
      }, { actor: opts.actor || 'agent' });
    }
  });
  tx();

  return getIdentityFacet(aspect, namespace)!;
}

export function getIdentityFacet(aspect: string, namespace = 'default'): IdentityFacet | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM identity WHERE aspect = ? AND namespace = ?`)
    .get(aspect, namespace) as any;
  return row ? rowToFacet(row) : null;
}

export function getAllIdentity(namespace?: string): IdentityFacet[] {
  const db = getDb();
  const rows = namespace
    ? (db.prepare(`SELECT * FROM identity WHERE namespace = ? ORDER BY confidence DESC, evidence DESC`).all(namespace) as any[])
    : (db.prepare(`SELECT * FROM identity ORDER BY confidence DESC, evidence DESC`).all() as any[]);
  return rows.map(rowToFacet);
}

function rowToFacet(row: any): IdentityFacet {
  return {
    aspect: row.aspect,
    namespace: row.namespace,
    value: row.value,
    confidence: row.confidence,
    evidence: row.evidence,
    status: row.status,
    sourceType: row.source_type,
    firstSeen: row.first_seen,
    lastUpdated: row.last_updated,
  };
}
