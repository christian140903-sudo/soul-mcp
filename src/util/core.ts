/**
 * Small deterministic utilities shared across the kernel.
 * No external dependencies, no hidden magic.
 */

import { createHash, randomBytes } from 'crypto';

/** Monotonic-ish sortable id: <prefix>_<millis-base36><4 random bytes hex> */
export function newId(prefix: string): string {
  const t = Date.now().toString(36).padStart(9, '0');
  const r = randomBytes(4).toString('hex');
  return `${prefix}_${t}${r}`;
}

/** SHA-256 hex of the canonicalized content. Used for dedup and import idempotency. */
export function contentHash(content: string): string {
  return createHash('sha256').update(canonicalize(content)).digest('hex');
}

/** Lowercase, collapse whitespace, strip trailing punctuation — enough for exact-dup detection. */
export function canonicalize(content: string): string {
  return content.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '');
}

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Rough token estimate (chars/4). This is an estimate, not a tokenizer —
 * the context compiler uses it for budgeting, and says so in its receipts.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Parse a duration like "24h", "30d", "15m" into milliseconds. Returns null if invalid. */
export function parseDuration(s: string): number | null {
  const m = /^(\d+)\s*(m|h|d)$/.exec(s.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  const unit = m[2]!;
  const factor = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return n * factor;
}
