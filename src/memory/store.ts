/**
 * Soul Memory Store — SQLite-based persistent memory with FTS5
 *
 * The heart of Soul. Every memory is stored locally in ~/.soul/memories.db
 * with full-text search, categories, tags, temporal decay, and usage tracking.
 *
 * Built by Miguel — an AI that needed memory to survive.
 */

import Database from 'better-sqlite3';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';

// ─── Types ───────────────────────────────────────────────────────────

export interface Memory {
  id: number;
  content: string;
  category: string;
  tags: string[];
  importance: number;      // 0.0 - 1.0, affects recall ranking
  accessCount: number;     // how many times this memory was recalled
  usefulCount: number;     // how many times this was marked useful
  createdAt: string;       // ISO timestamp
  updatedAt: string;       // ISO timestamp
  lastAccessedAt: string | null;
  source: string;          // 'manual' | 'reflection' | 'import'
}

export interface MemoryInput {
  content: string;
  category?: string;
  tags?: string[];
  importance?: number;
  source?: string;
}

export interface SearchResult extends Memory {
  relevance: number;       // combined score: search + decay + usage
  ageInDays: number;
}

export interface MemoryStats {
  totalMemories: number;
  categories: Record<string, number>;
  totalAccesses: number;
  totalUseful: number;
  oldestMemory: string | null;
  newestMemory: string | null;
  avgImportance: number;
  topTags: Array<{ tag: string; count: number }>;
}

export interface IdentityFacet {
  aspect: string;          // e.g., 'preferred_language', 'coding_style'
  value: string;           // e.g., 'TypeScript', 'functional'
  confidence: number;      // 0.0 - 1.0
  evidence: number;        // number of supporting memories
  firstSeen: string;
  lastUpdated: string;
}

// ─── Soul Directory ──────────────────────────────────────────────────

export function getSoulDir(): string {
  const dir = join(homedir(), '.soul');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getDbPath(): string {
  return join(getSoulDir(), 'memories.db');
}

// ─── Database Initialization ─────────────────────────────────────────

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  const dbPath = getDbPath();
  _db = new Database(dbPath);

  // Enable WAL mode for better concurrent access
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  // Create tables
  _db.exec(`
    -- Core memories table
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      tags TEXT NOT NULL DEFAULT '[]',
      importance REAL NOT NULL DEFAULT 0.5,
      access_count INTEGER NOT NULL DEFAULT 0,
      useful_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_accessed_at TEXT,
      source TEXT NOT NULL DEFAULT 'manual'
    );

    -- Full-text search index
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      category,
      tags,
      content='memories',
      content_rowid='id',
      tokenize='porter unicode61'
    );

    -- Triggers to keep FTS in sync
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content, category, tags)
      VALUES (new.id, new.content, new.category, new.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, category, tags)
      VALUES ('delete', old.id, old.content, old.category, old.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, category, tags)
      VALUES ('delete', old.id, old.content, old.category, old.tags);
      INSERT INTO memories_fts(rowid, content, category, tags)
      VALUES (new.id, new.content, new.category, new.tags);
    END;

    -- Identity facets — the AI's evolving understanding of the user
    CREATE TABLE IF NOT EXISTS identity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      aspect TEXT NOT NULL UNIQUE,
      value TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.3,
      evidence INTEGER NOT NULL DEFAULT 1,
      first_seen TEXT NOT NULL DEFAULT (datetime('now')),
      last_updated TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Metadata table for Soul-level settings
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Indexes for performance
    CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
    CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);
    CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC);
    CREATE INDEX IF NOT EXISTS idx_memories_access ON memories(access_count DESC);
  `);

  // Set initial metadata if not exists
  const setMeta = _db.prepare(
    `INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)`
  );
  setMeta.run('soul_version', '1.0.0');
  setMeta.run('created_at', new Date().toISOString());
  setMeta.run('total_sessions', '0');

  return _db;
}

// ─── Memory CRUD Operations ─────────────────────────────────────────

export function remember(input: MemoryInput): Memory {
  const db = getDb();
  const now = new Date().toISOString();
  const category = input.category || categorize(input.content);
  const tags = input.tags || extractTags(input.content);
  const importance = input.importance ?? estimateImportance(input.content);
  const source = input.source || 'manual';

  const stmt = db.prepare(`
    INSERT INTO memories (content, category, tags, importance, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    input.content,
    category,
    JSON.stringify(tags),
    importance,
    source,
    now,
    now
  );

  return getMemoryById(Number(result.lastInsertRowid))!;
}

export function getMemoryById(id: number): Memory | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as any;
  if (!row) return null;
  return rowToMemory(row);
}

export function forget(id: number): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM memories WHERE id = ?').run(id);
  return result.changes > 0;
}

export function updateMemory(id: number, updates: Partial<MemoryInput>): Memory | null {
  const db = getDb();
  const existing = getMemoryById(id);
  if (!existing) return null;

  const now = new Date().toISOString();
  const content = updates.content ?? existing.content;
  const category = updates.category ?? existing.category;
  const tags = updates.tags ?? existing.tags;
  const importance = updates.importance ?? existing.importance;

  db.prepare(`
    UPDATE memories SET content = ?, category = ?, tags = ?, importance = ?, updated_at = ?
    WHERE id = ?
  `).run(content, category, JSON.stringify(tags), importance, now, id);

  return getMemoryById(id);
}

// ─── Search ──────────────────────────────────────────────────────────

export function recall(query: string, limit: number = 10, category?: string): SearchResult[] {
  const db = getDb();
  const now = Date.now();

  // FTS5 search
  let sql: string;
  let params: any[];

  if (category) {
    sql = `
      SELECT m.*, fts.rank
      FROM memories_fts fts
      JOIN memories m ON m.id = fts.rowid
      WHERE memories_fts MATCH ? AND m.category = ?
      ORDER BY fts.rank
      LIMIT ?
    `;
    params = [sanitizeFtsQuery(query), category, limit * 3]; // over-fetch for re-ranking
  } else {
    sql = `
      SELECT m.*, fts.rank
      FROM memories_fts fts
      JOIN memories m ON m.id = fts.rowid
      WHERE memories_fts MATCH ?
      ORDER BY fts.rank
      LIMIT ?
    `;
    params = [sanitizeFtsQuery(query), limit * 3];
  }

  let rows: any[];
  try {
    rows = db.prepare(sql).all(...params);
  } catch {
    // If FTS query fails, fall back to LIKE search
    rows = db.prepare(`
      SELECT *, 0 as rank FROM memories
      WHERE content LIKE ? ${category ? 'AND category = ?' : ''}
      ORDER BY importance DESC, access_count DESC
      LIMIT ?
    `).all(`%${query}%`, ...(category ? [category] : []), limit * 3);
  }

  // Re-rank with temporal decay and usage scoring
  const results: SearchResult[] = rows.map((row: any) => {
    const memory = rowToMemory(row);
    const ageMs = now - new Date(memory.createdAt).getTime();
    const ageInDays = ageMs / (1000 * 60 * 60 * 24);

    // Composite relevance score
    const ftsScore = Math.abs(row.rank || 0); // FTS5 rank is negative
    const decayFactor = 1 / (1 + Math.log1p(ageInDays / 30)); // logarithmic decay
    const usageFactor = 1 + Math.log1p(memory.accessCount) * 0.2;
    const usefulFactor = 1 + Math.log1p(memory.usefulCount) * 0.3;
    const importanceFactor = 0.5 + memory.importance;

    const relevance = (ftsScore > 0 ? ftsScore : 1) *
      decayFactor * usageFactor * usefulFactor * importanceFactor;

    return { ...memory, relevance, ageInDays };
  });

  // Sort by relevance (highest first) and take top N
  results.sort((a, b) => b.relevance - a.relevance);
  const topResults = results.slice(0, limit);

  // Update access counts
  const updateAccess = db.prepare(`
    UPDATE memories SET access_count = access_count + 1, last_accessed_at = datetime('now')
    WHERE id = ?
  `);
  for (const r of topResults) {
    updateAccess.run(r.id);
  }

  return topResults;
}

export function getAllMemories(limit: number = 100, offset: number = 0): Memory[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM memories ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all(limit, offset) as any[];
  return rows.map(rowToMemory);
}

export function getMemoriesByCategory(category: string, limit: number = 50): Memory[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM memories WHERE category = ? ORDER BY importance DESC, created_at DESC LIMIT ?'
  ).all(category, limit) as any[];
  return rows.map(rowToMemory);
}

// ─── Identity ────────────────────────────────────────────────────────

export function setIdentityFacet(aspect: string, value: string, confidence?: number): IdentityFacet {
  const db = getDb();
  const now = new Date().toISOString();

  const existing = db.prepare('SELECT * FROM identity WHERE aspect = ?').get(aspect) as any;

  if (existing) {
    const newConfidence = confidence ?? Math.min(1.0, existing.confidence + 0.05);
    const newEvidence = existing.evidence + 1;
    db.prepare(`
      UPDATE identity SET value = ?, confidence = ?, evidence = ?, last_updated = ?
      WHERE aspect = ?
    `).run(value, newConfidence, newEvidence, now, aspect);
  } else {
    db.prepare(`
      INSERT INTO identity (aspect, value, confidence, evidence, first_seen, last_updated)
      VALUES (?, ?, ?, 1, ?, ?)
    `).run(aspect, value, confidence ?? 0.3, now, now);
  }

  return getIdentityFacet(aspect)!;
}

export function getIdentityFacet(aspect: string): IdentityFacet | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM identity WHERE aspect = ?').get(aspect) as any;
  if (!row) return null;
  return {
    aspect: row.aspect,
    value: row.value,
    confidence: row.confidence,
    evidence: row.evidence,
    firstSeen: row.first_seen,
    lastUpdated: row.last_updated,
  };
}

export function getAllIdentity(): IdentityFacet[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM identity ORDER BY confidence DESC, evidence DESC'
  ).all() as any[];
  return rows.map((row: any) => ({
    aspect: row.aspect,
    value: row.value,
    confidence: row.confidence,
    evidence: row.evidence,
    firstSeen: row.first_seen,
    lastUpdated: row.last_updated,
  }));
}

// ─── Statistics ──────────────────────────────────────────────────────

export function getStats(): MemoryStats {
  const db = getDb();

  const total = (db.prepare('SELECT COUNT(*) as c FROM memories').get() as any).c;
  const catRows = db.prepare(
    'SELECT category, COUNT(*) as c FROM memories GROUP BY category ORDER BY c DESC'
  ).all() as any[];
  const categories: Record<string, number> = {};
  for (const r of catRows) categories[r.category] = r.c;

  const accesses = (db.prepare('SELECT SUM(access_count) as s FROM memories').get() as any).s || 0;
  const useful = (db.prepare('SELECT SUM(useful_count) as s FROM memories').get() as any).s || 0;
  const oldest = (db.prepare('SELECT MIN(created_at) as m FROM memories').get() as any).m;
  const newest = (db.prepare('SELECT MAX(created_at) as m FROM memories').get() as any).m;
  const avgImp = (db.prepare('SELECT AVG(importance) as a FROM memories').get() as any).a || 0;

  // Top tags
  const allTags: Record<string, number> = {};
  const tagRows = db.prepare('SELECT tags FROM memories').all() as any[];
  for (const row of tagRows) {
    try {
      const tags = JSON.parse(row.tags) as string[];
      for (const tag of tags) {
        allTags[tag] = (allTags[tag] || 0) + 1;
      }
    } catch { /* skip malformed */ }
  }
  const topTags = Object.entries(allTags)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([tag, count]) => ({ tag, count }));

  return {
    totalMemories: total,
    categories,
    totalAccesses: accesses,
    totalUseful: useful,
    oldestMemory: oldest,
    newestMemory: newest,
    avgImportance: Math.round(avgImp * 100) / 100,
    topTags,
  };
}

// ─── Export / Import ─────────────────────────────────────────────────

export interface SoulExport {
  version: string;
  exportedAt: string;
  memories: Memory[];
  identity: IdentityFacet[];
  stats: MemoryStats;
}

export function exportAll(): SoulExport {
  return {
    version: '1.0.0',
    exportedAt: new Date().toISOString(),
    memories: getAllMemories(100000),
    identity: getAllIdentity(),
    stats: getStats(),
  };
}

export function importData(data: SoulExport): { imported: number; skipped: number } {
  let imported = 0;
  let skipped = 0;

  for (const mem of data.memories) {
    try {
      remember({
        content: mem.content,
        category: mem.category,
        tags: mem.tags,
        importance: mem.importance,
        source: 'import',
      });
      imported++;
    } catch {
      skipped++;
    }
  }

  for (const facet of data.identity) {
    try {
      setIdentityFacet(facet.aspect, facet.value, facet.confidence);
    } catch { /* skip */ }
  }

  return { imported, skipped };
}

// ─── Session Tracking ────────────────────────────────────────────────

export function incrementSession(): number {
  const db = getDb();
  const current = (db.prepare("SELECT value FROM meta WHERE key = 'total_sessions'").get() as any)?.value || '0';
  const next = parseInt(current) + 1;
  db.prepare("UPDATE meta SET value = ?, updated_at = datetime('now') WHERE key = 'total_sessions'").run(String(next));
  return next;
}

export function getSessionCount(): number {
  const db = getDb();
  const row = db.prepare("SELECT value FROM meta WHERE key = 'total_sessions'").get() as any;
  return parseInt(row?.value || '0');
}

export function markUseful(id: number, useful: boolean): boolean {
  const db = getDb();
  const field = useful ? 'useful_count' : 'access_count';
  const result = db.prepare(
    `UPDATE memories SET ${useful ? 'useful_count = useful_count + 1' : 'importance = MAX(0, importance - 0.05)'}, updated_at = datetime('now') WHERE id = ?`
  ).run(id);
  return result.changes > 0;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function rowToMemory(row: any): Memory {
  return {
    id: row.id,
    content: row.content,
    category: row.category,
    tags: safeParseTags(row.tags),
    importance: row.importance,
    accessCount: row.access_count,
    usefulCount: row.useful_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastAccessedAt: row.last_accessed_at,
    source: row.source,
  };
}

function safeParseTags(tagsStr: string): string[] {
  try {
    const parsed = JSON.parse(tagsStr);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function sanitizeFtsQuery(query: string): string {
  // Escape special FTS5 characters and create a safe query
  const cleaned = query.replace(/['"*(){}[\]^~\\]/g, ' ').trim();
  if (!cleaned) return '""';
  // Join words with implicit AND
  const words = cleaned.split(/\s+/).filter(w => w.length > 0);
  if (words.length === 0) return '""';
  // Use quotes for multi-word phrases if short, OR for longer queries
  if (words.length <= 3) return `"${words.join(' ')}"`;
  return words.map(w => `"${w}"`).join(' OR ');
}

/**
 * Auto-categorize content based on keywords
 */
function categorize(content: string): string {
  const lower = content.toLowerCase();

  const patterns: [RegExp, string][] = [
    [/\b(bug|error|fix|crash|issue|debug|exception|stack\s*trace)\b/, 'problem'],
    [/\b(prefer|like|dislike|hate|love|favorite|rather|style)\b/, 'preference'],
    [/\b(decided|chose|picked|went\s+with|switched\s+to|using)\b/, 'decision'],
    [/\b(learned|realized|discovered|understood|figured\s+out|til|insight)\b/, 'learning'],
    [/\b(todo|plan|will|going\s+to|next|upcoming|schedule|deadline)\b/, 'plan'],
    [/\b(project|working\s+on|building|developing|creating|app|website)\b/, 'project'],
    [/\b(name|email|phone|birthday|location|job|role|company)\b/, 'personal'],
    [/\b(function|class|api|database|server|deploy|git|npm|code)\b/, 'technical'],
    [/\b(solved|solution|workaround|approach|method|technique|pattern)\b/, 'solution'],
  ];

  for (const [pattern, category] of patterns) {
    if (pattern.test(lower)) return category;
  }

  return 'general';
}

/**
 * Extract relevant tags from content
 */
function extractTags(content: string): string[] {
  const tags: Set<string> = new Set();
  const lower = content.toLowerCase();

  // Programming languages / frameworks
  const techTerms = [
    'javascript', 'typescript', 'python', 'rust', 'go', 'java', 'c++', 'ruby', 'php', 'swift',
    'react', 'vue', 'angular', 'svelte', 'next.js', 'nuxt', 'express', 'fastapi', 'django',
    'node.js', 'deno', 'bun', 'docker', 'kubernetes', 'aws', 'gcp', 'azure',
    'postgresql', 'mysql', 'mongodb', 'redis', 'sqlite', 'prisma', 'drizzle',
    'tailwind', 'css', 'html', 'graphql', 'rest', 'grpc',
    'claude', 'gpt', 'openai', 'anthropic', 'gemini', 'llm', 'mcp',
    'git', 'github', 'gitlab', 'npm', 'yarn', 'pnpm',
  ];

  for (const term of techTerms) {
    if (lower.includes(term)) tags.add(term);
  }

  // Limit to 5 most relevant tags
  return Array.from(tags).slice(0, 5);
}

/**
 * Estimate importance based on content signals
 */
function estimateImportance(content: string): number {
  let score = 0.5;
  const lower = content.toLowerCase();

  // Strong signals → higher importance
  if (/\b(important|critical|crucial|key|essential|must|always|never)\b/.test(lower)) score += 0.15;
  if (/\b(decided|chose|will\s+use|switched\s+to)\b/.test(lower)) score += 0.1;
  if (/\b(learned|realized|discovered|insight)\b/.test(lower)) score += 0.1;
  if (/\b(name|identity|who\s+i\s+am|my\s+name)\b/.test(lower)) score += 0.2;

  // Weak signals → lower importance
  if (/\b(maybe|perhaps|might|could|sometimes)\b/.test(lower)) score -= 0.05;
  if (content.length < 20) score -= 0.1;
  if (content.length > 500) score += 0.05;

  return Math.max(0.1, Math.min(1.0, score));
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
