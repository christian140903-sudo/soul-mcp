/**
 * Goals and commitments. A commitment is a goal with kind='commitment' and
 * usually a due date — the distinction matters because commitments are
 * promises to someone, not just intentions.
 */

import { getDb } from './db.js';
import { appendEvent } from './ledger.js';
import { newId, nowIso } from '../util/core.js';

export type GoalKind = 'goal' | 'commitment' | 'milestone';
export type GoalStatus = 'active' | 'completed' | 'blocked' | 'abandoned';

export interface Goal {
  id: string;
  title: string;
  description: string;
  kind: GoalKind;
  status: GoalStatus;
  priority: number;
  progress: number;
  dueAt: string | null;
  parentId: string | null;
  namespace: string;
  createdAt: string;
  updatedAt: string;
}

export function createGoal(input: {
  title: string;
  description?: string;
  kind?: GoalKind;
  priority?: number;
  dueAt?: string;
  parentId?: string;
  namespace?: string;
  actor?: string;
}): Goal {
  const db = getDb();
  const id = newId('goal');
  const now = nowIso();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO goals (id, title, description, kind, status, priority, progress, due_at, parent_id, namespace, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, 0, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.title,
      input.description || '',
      input.kind || 'goal',
      input.priority ?? 3,
      input.dueAt || null,
      input.parentId || null,
      input.namespace || 'default',
      now,
      now
    );
    appendEvent('goal.created', 'goal', id, { title: input.title, kind: input.kind || 'goal', due_at: input.dueAt }, { actor: input.actor || 'user' });
  });
  tx();
  return getGoal(id)!;
}

export function updateGoal(
  id: string,
  updates: { status?: GoalStatus; progress?: number; title?: string; description?: string; priority?: number; dueAt?: string },
  actor = 'user'
): Goal | null {
  const db = getDb();
  const existing = getGoal(id);
  if (!existing) return null;
  const now = nowIso();
  const status = updates.status ?? existing.status;
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE goals SET title = ?, description = ?, status = ?, priority = ?, progress = ?, due_at = ?, updated_at = ? WHERE id = ?`
    ).run(
      updates.title ?? existing.title,
      updates.description ?? existing.description,
      status,
      updates.priority ?? existing.priority,
      Math.max(0, Math.min(1, updates.progress ?? existing.progress)),
      updates.dueAt ?? existing.dueAt,
      now,
      id
    );
    appendEvent(status === 'completed' ? 'goal.completed' : 'goal.updated', 'goal', id, { ...updates }, { actor });
  });
  tx();
  return getGoal(id);
}

export function getGoal(id: string): Goal | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM goals WHERE id = ?`).get(id) as any;
  return row ? rowToGoal(row) : null;
}

export function listGoals(opts: { status?: GoalStatus[]; namespace?: string; limit?: number } = {}): Goal[] {
  const db = getDb();
  const statuses = opts.status ?? ['active', 'blocked'];
  const where: string[] = [`status IN (${statuses.map(() => '?').join(',')})`];
  const params: unknown[] = [...statuses];
  if (opts.namespace) {
    where.push('namespace = ?');
    params.push(opts.namespace);
  }
  params.push(opts.limit ?? 20);
  const rows = db
    .prepare(
      `SELECT * FROM goals WHERE ${where.join(' AND ')}
       ORDER BY CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at ASC, priority ASC LIMIT ?`
    )
    .all(...params) as any[];
  return rows.map(rowToGoal);
}

/** Commitments whose due date has passed but are still active. */
export function overdueCommitments(namespace?: string): Goal[] {
  const db = getDb();
  const params: unknown[] = [nowIso()];
  let sql = `SELECT * FROM goals WHERE status = 'active' AND due_at IS NOT NULL AND due_at < ?`;
  if (namespace) {
    sql += ` AND namespace = ?`;
    params.push(namespace);
  }
  sql += ` ORDER BY due_at ASC LIMIT 20`;
  return (db.prepare(sql).all(...params) as any[]).map(rowToGoal);
}

function rowToGoal(row: any): Goal {
  return {
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
  };
}
