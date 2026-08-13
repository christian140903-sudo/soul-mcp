/**
 * Soul 4.0 — local recall() performance baseline (Härtungsplan Punkt 6).
 *
 * Builds a synthetic corpus of 1,000 / 10,000 / 50,000 memories (cumulative
 * — the corpus only grows across stages, matching how a real Soul grows
 * over time) in a throwaway SOUL_DIR, NEVER ~/.soul, and measures recall()
 * latency at each stage: p50/p95 in ms, split into queries that hit the FTS
 * index and queries that don't.
 *
 * Lexical path only. The optional semantic layer (~380 MB embedding model
 * download) is never enabled here — `isSemanticConfigured()` stays false,
 * so embedQuery() short-circuits to null and recall() runs its pure-FTS
 * scoring path (WEIGHTS_LEXICAL).
 *
 * This is a single local machine, single process, no concurrent load — a
 * baseline snapshot, not a load test and not a production claim. See
 * docs/PERF-BASELINE.md for the one measured run this script produced and
 * its honest framing.
 *
 * Usage: npm run perf-baseline
 * Output: docs/perf-baseline-results.json (machine-readable) + stdout summary.
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { performance } from 'node:perf_hooks';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const soulDir = mkdtempSync(join(tmpdir(), 'soul-perf-baseline-'));
process.env.SOUL_DIR = soulDir;

const { capture } = await import('../dist/src/kernel/memory.js');
const { recall } = await import('../dist/src/kernel/retrieval.js');
const { getDb, closeDb, SOUL_VERSION } = await import('../dist/src/kernel/db.js');

const STAGES = [1000, 10000, 50000];
const QUERIES_PER_GROUP = 50;
const WARMUP_QUERIES = 5;
const BATCH_SIZE = 2500;

// --- deterministic synthetic corpus (no RNG — index-based, reproducible) --
// Every generated string embeds its own index, so content is always unique
// (capture() merges exact-duplicate content instead of inserting a new row,
// which would silently shrink the corpus below the target size).
const TOPICS = [
  'deploy', 'backup', 'schema', 'cache', 'router', 'ledger', 'index', 'token',
  'queue', 'socket', 'compiler', 'scheduler', 'firewall', 'gateway', 'cluster',
  'pipeline', 'registry', 'sandbox', 'endpoint', 'dashboard',
];
const ACTIONS = [
  'handles', 'validates', 'compiles', 'retries', 'archives', 'throttles',
  'reindexes', 'reconciles', 'monitors', 'restarts',
];
const SUBJECTS = [
  'the api gateway', 'the worker pool', 'the release pipeline', 'the metrics collector',
  'the backup job', 'the ingest service', 'the auth layer', 'the search index',
];

function syntheticContent(i) {
  const topic = TOPICS[i % TOPICS.length];
  const action = ACTIONS[Math.floor(i / TOPICS.length) % ACTIONS.length];
  const subject = SUBJECTS[Math.floor(i / (TOPICS.length * ACTIONS.length)) % SUBJECTS.length];
  return `Note ${i}: the ${topic} module ${action} requests for ${subject} during startup.`;
}

// Queries guaranteed to hit the FTS index: every TOPIC word appears in a
// known, non-trivial fraction of the corpus by construction above.
const HIT_QUERIES = Array.from({ length: QUERIES_PER_GROUP }, (_, k) => TOPICS[k % TOPICS.length]);
// Queries guaranteed to miss: tokens that never appear in syntheticContent().
const MISS_QUERIES = Array.from({ length: QUERIES_PER_GROUP }, (_, k) => `nonexistent_query_term_${k}`);

function percentile(sortedMs, p) {
  if (sortedMs.length === 0) return null;
  const idx = Math.min(sortedMs.length - 1, Math.floor((p / 100) * sortedMs.length));
  return Math.round(sortedMs[idx] * 100) / 100;
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return { n: sorted.length, p50_ms: percentile(sorted, 50), p95_ms: percentile(sorted, 95) };
}

async function timeQueries(queries) {
  const samples = [];
  for (const q of queries) {
    const t0 = performance.now();
    await recall(q); // default (non-silent) call — the real soul_recall path,
    // including the access_count/ledger-event write on a non-empty hit.
    samples.push(performance.now() - t0);
  }
  return samples;
}

function insertBatch(startIndex, count) {
  const db = getDb();
  const tx = db.transaction((n0, n) => {
    for (let i = n0; i < n0 + n; i++) capture({ content: syntheticContent(i) });
  });
  tx(startIndex, count);
}

function machineInfo() {
  let cpu = os.cpus()[0]?.model ?? 'unknown';
  let ramBytes = os.totalmem();
  if (process.platform === 'darwin') {
    try {
      cpu = execFileSync('sysctl', ['-n', 'machdep.cpu.brand_string']).toString().trim();
    } catch {
      // fall back to os.cpus() above
    }
    try {
      ramBytes = Number(execFileSync('sysctl', ['-n', 'hw.memsize']).toString().trim());
    } catch {
      // fall back to os.totalmem() above
    }
  }
  return {
    platform: process.platform,
    arch: process.arch,
    os_release: os.release(),
    node_version: process.version,
    cpu,
    ram_gb: Math.round((ramBytes / 1024 ** 3) * 10) / 10,
  };
}

const result = {
  generated_at: new Date().toISOString(),
  soul_version: SOUL_VERSION,
  machine: machineInfo(),
  semantic_layer: 'off — lexical-only recall (embedding model never downloaded or configured)',
  methodology: {
    corpus: 'cumulative across stages; content is deterministic (index-based), not random',
    stages: STAGES,
    queries_per_group_per_stage: QUERIES_PER_GROUP,
    warmup_queries_per_group: WARMUP_QUERIES,
    insert_batch_size: BATCH_SIZE,
    recall_call: 'default (non-silent) — includes the access_count/ledger-event write on hits',
    caveat: 'single local machine, single process, no concurrent load — a baseline snapshot, not a load test',
  },
  stages: [],
};

let cumulative = 0;
try {
  for (const target of STAGES) {
    const toInsert = target - cumulative;
    const insertStart = performance.now();
    for (let done = 0; done < toInsert; done += BATCH_SIZE) {
      insertBatch(cumulative + done, Math.min(BATCH_SIZE, toInsert - done));
    }
    const insertMs = performance.now() - insertStart;
    cumulative = target;

    // Untimed warmup so the first timed samples aren't skewed by cold caches.
    await timeQueries(HIT_QUERIES.slice(0, WARMUP_QUERIES));
    await timeQueries(MISS_QUERIES.slice(0, WARMUP_QUERIES));

    const hitSamples = await timeQueries(HIT_QUERIES);
    const missSamples = await timeQueries(MISS_QUERIES);

    const stageResult = {
      cumulative_memories: cumulative,
      insert_ms_for_this_stage: Math.round(insertMs),
      insert_memories_per_sec: Math.round((toInsert / insertMs) * 1000),
      recall_with_fts_hits: summarize(hitSamples),
      recall_without_fts_hits: summarize(missSamples),
    };
    result.stages.push(stageResult);
    process.stdout.write(
      `stage ${cumulative}: insert ${Math.round(insertMs)}ms (${stageResult.insert_memories_per_sec}/s) — ` +
        `recall p50/p95 hits ${stageResult.recall_with_fts_hits.p50_ms}/${stageResult.recall_with_fts_hits.p95_ms}ms, ` +
        `no-hits ${stageResult.recall_without_fts_hits.p50_ms}/${stageResult.recall_without_fts_hits.p95_ms}ms\n`
    );
  }
} finally {
  closeDb();
  rmSync(soulDir, { recursive: true, force: true });
}

const outPath = join(root, 'docs', 'perf-baseline-results.json');
writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n');
process.stdout.write(`\nWritten: ${outPath}\n`);
