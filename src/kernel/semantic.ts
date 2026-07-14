/**
 * Optional semantic layer: local embeddings so recall can match paraphrases,
 * not just keywords.
 *
 * Constraints this module enforces, deliberately:
 * - @huggingface/transformers is ~380 MB installed, so it is NEVER a
 *   dependency of soul-mcp. `soul-mcp semantic on` installs it into
 *   ~/.soul/semantic/ (its own npm prefix) and this module resolves it from
 *   there at runtime. Without it, everything degrades to FTS5 — no errors,
 *   no nagging.
 * - Vectors are Float32 BLOBs in SQLite, compared brute-force in JS. At
 *   personal-memory scale (thousands of rows) that is single-digit
 *   milliseconds and needs no native vector extension.
 * - The model is multilingual (e5-small): memories and queries can mix
 *   languages. e5 requires "query:"/"passage:" prefixes; they are added here.
 * - e5 cosine similarities live in a compressed band (~0.6–0.9 in practice);
 *   calibrateSimilarity() maps that band to 0..1 so the score component is
 *   comparable to the other score parts. The mapping is a documented affine
 *   rescale, not a learned reranker.
 */

import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import { join } from 'path';
import { existsSync } from 'fs';
import { getDb, getSoulDir } from './db.js';
import { nowIso } from '../util/core.js';

export const EMBEDDING_MODEL = 'Xenova/multilingual-e5-small';
export const EMBEDDING_DIM = 384;
/** Below this cosine, e5-small neighbors are noise and are not candidates. */
export const MIN_CANDIDATE_COSINE = 0.7;

export type EmbedFn = (texts: string[]) => Promise<Float32Array[]>;

let embedderPromise: Promise<EmbedFn | null> | null = null;
let loadFailure: string | null = null;
let testEmbedder: EmbedFn | null = null;

/** Tests inject a deterministic embedder here; null restores real loading. */
export function _setEmbedderForTests(fn: EmbedFn | null): void {
  testEmbedder = fn;
  embedderPromise = null;
  loadFailure = null;
  invalidateVectorCache();
}

export function semanticDir(): string {
  return join(getSoulDir(), 'semantic');
}

// ─── Configuration (meta.semantic = 'on' | 'off') ────────────────────

export function isSemanticConfigured(): boolean {
  if (testEmbedder) return true;
  const row = getDb().prepare(`SELECT value FROM meta WHERE key = 'semantic'`).get() as
    | { value: string }
    | undefined;
  return row?.value === 'on';
}

export function setSemanticConfigured(on: boolean): void {
  getDb()
    .prepare(
      `INSERT INTO meta (key, value, updated_at) VALUES ('semantic', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(on ? 'on' : 'off', nowIso());
  embedderPromise = null;
  loadFailure = null;
}

// ─── Embedder loading ────────────────────────────────────────────────

async function loadTransformers(): Promise<any | null> {
  const localPkg = join(semanticDir(), 'node_modules', '@huggingface', 'transformers', 'package.json');
  // variable specifier so tsc doesn't require the module to be installed
  const specifier = '@huggingface/transformers';
  try {
    if (existsSync(localPkg)) {
      const req = createRequire(localPkg);
      const entry = req.resolve(specifier);
      return await import(pathToFileURL(entry).href);
    }
    return await import(specifier);
  } catch (error) {
    loadFailure = String(error instanceof Error ? error.message : error).split('\n')[0] ?? 'load failed';
    return null;
  }
}

function getEmbedder(): Promise<EmbedFn | null> {
  if (testEmbedder) return Promise.resolve(testEmbedder);
  if (!embedderPromise) {
    embedderPromise = (async () => {
      if (!isSemanticConfigured()) return null;
      const transformers = await loadTransformers();
      if (!transformers) return null;
      try {
        const extractor = await transformers.pipeline('feature-extraction', EMBEDDING_MODEL, {
          dtype: 'q8',
        });
        return async (texts: string[]) => {
          const out = await extractor(texts, { pooling: 'mean', normalize: true });
          const [n, dim] = out.dims as [number, number];
          const data = out.data as Float32Array;
          const vecs: Float32Array[] = [];
          for (let i = 0; i < n; i++) {
            vecs.push(data.slice(i * dim, (i + 1) * dim));
          }
          return vecs;
        };
      } catch (error) {
        loadFailure = String(error instanceof Error ? error.message : error).split('\n')[0] ?? 'pipeline failed';
        return null;
      }
    })();
  }
  return embedderPromise;
}

/** Embed a recall/context query. Returns null when the semantic layer is off or unavailable. */
export async function embedQuery(text: string): Promise<Float32Array | null> {
  const embed = await getEmbedder();
  if (!embed) return null;
  try {
    return (await embed([`query: ${text}`]))[0] ?? null;
  } catch {
    return null;
  }
}

// ─── Vector store (memory_vectors table + in-process cache) ──────────

let vecCache: Map<string, Float32Array> | null = null;

export function invalidateVectorCache(): void {
  vecCache = null;
}

function loadVectorCache(): Map<string, Float32Array> {
  if (vecCache) return vecCache;
  const rows = getDb()
    .prepare(`SELECT id, dim, vector FROM memory_vectors`)
    .all() as Array<{ id: string; dim: number; vector: Buffer }>;
  const map = new Map<string, Float32Array>();
  for (const r of rows) {
    if (r.vector.length !== r.dim * 4) continue; // corrupt row: skip, backfill will rewrite
    map.set(r.id, new Float32Array(r.vector.buffer, r.vector.byteOffset, r.dim));
  }
  vecCache = map;
  return map;
}

export function upsertVector(memoryId: string, vec: Float32Array): void {
  getDb()
    .prepare(
      `INSERT INTO memory_vectors (id, model, dim, vector, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET model = excluded.model, dim = excluded.dim,
         vector = excluded.vector, updated_at = excluded.updated_at`
    )
    .run(memoryId, EMBEDDING_MODEL, vec.length, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength), nowIso());
  invalidateVectorCache();
}

export function deleteVector(memoryId: string): void {
  getDb().prepare(`DELETE FROM memory_vectors WHERE id = ?`).run(memoryId);
  invalidateVectorCache();
}

export function getVector(memoryId: string): Float32Array | null {
  return loadVectorCache().get(memoryId) ?? null;
}

/** Dot product; vectors are L2-normalized at embed time, so this is cosine. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

/** Map the compressed e5 similarity band (~0.6..0.95) onto 0..1. */
export function calibrateSimilarity(cos: number): number {
  return Math.max(0, Math.min(1, (cos - 0.6) / 0.35));
}

/**
 * Nearest stored vectors for a query vector. Returns raw cosines; status/
 * namespace filtering happens in SQL when the caller resolves the ids.
 */
export function semanticCandidates(
  queryVec: Float32Array,
  topN: number,
  minCosine = MIN_CANDIDATE_COSINE
): Array<{ id: string; similarity: number }> {
  const out: Array<{ id: string; similarity: number }> = [];
  for (const [id, v] of loadVectorCache()) {
    if (v.length !== queryVec.length) continue;
    const s = cosine(queryVec, v);
    if (s >= minCosine) out.push({ id, similarity: s });
  }
  out.sort((x, y) => y.similarity - x.similarity);
  return out.slice(0, topN);
}

/**
 * Nearest neighbors of an existing memory — the associative "related" edges.
 * Computed live from vectors, never stored: a stored graph would just go
 * stale next to the vectors it was derived from.
 */
export function relatedMemories(memoryId: string, k = 5): Array<{ id: string; similarity: number }> {
  const vec = getVector(memoryId);
  if (!vec) return [];
  return semanticCandidates(vec, k + 1).filter((c) => c.id !== memoryId).slice(0, k);
}

// ─── Capture hook + backfill ─────────────────────────────────────────

export async function embedAndStore(memoryId: string, content: string): Promise<boolean> {
  try {
    const embed = await getEmbedder();
    if (!embed) return false;
    const [vec] = await embed([`passage: ${content}`]);
    if (!vec) return false;
    upsertVector(memoryId, vec);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fire-and-forget embedding on capture. Failures are silent by design:
 * the backfill sweep (server start, `soul-mcp semantic backfill`) closes
 * any gap, so a slow or crashed embed never blocks or breaks a capture.
 */
export function embedLater(memoryId: string, content: string): void {
  if (!testEmbedder && !isSemanticConfigured()) return;
  void embedAndStore(memoryId, content);
}

export async function backfillVectors(
  opts: { batchSize?: number; onProgress?: (done: number, total: number) => void } = {}
): Promise<{ embedded: number; total: number }> {
  const embed = await getEmbedder();
  if (!embed) return { embedded: 0, total: 0 };
  const rows = getDb()
    .prepare(
      `SELECT m.id, m.content FROM memories m
       LEFT JOIN memory_vectors v ON v.id = m.id
       WHERE v.id IS NULL AND m.status IN ('candidate','active','confirmed','disputed')`
    )
    .all() as Array<{ id: string; content: string }>;
  const batch = Math.max(1, opts.batchSize ?? 16);
  let embedded = 0;
  for (let i = 0; i < rows.length; i += batch) {
    const chunk = rows.slice(i, i + batch);
    try {
      const vecs = await embed(chunk.map((r) => `passage: ${r.content}`));
      for (let j = 0; j < chunk.length; j++) {
        const vec = vecs[j];
        if (vec) {
          upsertVector(chunk[j]!.id, vec);
          embedded++;
        }
      }
    } catch {
      // skip this batch; a later sweep retries
    }
    opts.onProgress?.(Math.min(i + batch, rows.length), rows.length);
  }
  return { embedded, total: rows.length };
}

// ─── Status ──────────────────────────────────────────────────────────

export interface SemanticStatus {
  configured: boolean;
  available: boolean;
  model: string;
  vectors: number;
  missing: number;
  note: string | null;
}

export async function semanticStatus(): Promise<SemanticStatus> {
  const db = getDb();
  const configured = isSemanticConfigured();
  const available = configured ? (await getEmbedder()) !== null : false;
  const vectors = (db.prepare(`SELECT COUNT(*) c FROM memory_vectors`).get() as any).c as number;
  const missing = (
    db
      .prepare(
        `SELECT COUNT(*) c FROM memories m LEFT JOIN memory_vectors v ON v.id = m.id
         WHERE v.id IS NULL AND m.status IN ('candidate','active','confirmed','disputed')`
      )
      .get() as any
  ).c as number;
  return {
    configured,
    available,
    model: EMBEDDING_MODEL,
    vectors,
    missing,
    note: configured && !available ? (loadFailure ?? 'embedding backend not loadable') : null,
  };
}
