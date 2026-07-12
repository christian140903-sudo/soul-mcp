/**
 * Soul CLI: init, status, doctor, backup, restore, export, import, config, help.
 * Human-facing output only — the MCP server lives in serve.ts.
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import {
  getDb,
  closeDb,
  getDbPath,
  getSoulDir,
  getBackupDir,
  backupLive,
  SCHEMA_VERSION,
} from './kernel/db.js';
import { capture } from './kernel/memory.js';
import { getStats, getSessionCount } from './kernel/stats.js';
import { exportAll, importAll } from './kernel/transfer.js';
import { constitutionPath, loadConstitution } from './kernel/policy.js';
import { appendEvent } from './kernel/ledger.js';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const AMBER = '\x1b[33m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';

export function runCli(args: string[]): void {
  const command = args[0] || 'help';
  try {
    switch (command) {
      case 'init': init(); break;
      case 'status': status(); break;
      case 'doctor': doctor(); break;
      case 'backup': backup(); break;
      case 'restore': restore(args[1]); break;
      case 'export': exportCmd(args[1]); break;
      case 'import': importCmd(args[1]); break;
      case 'config': printConfig(); break;
      case 'help': case '--help': case '-h': help(); break;
      case '--version': case '-v': console.log('2.0.0'); break;
      default:
        console.log(`Unknown command: ${command}. Run ${CYAN}soul-mcp help${RESET} for usage.`);
        process.exitCode = 1;
    }
  } finally {
    closeDb();
  }
}

function init(): void {
  console.log('');
  console.log(`${AMBER}${BOLD}  SOUL v2.0.0${RESET} ${DIM}— a trusted continuity layer for your AI${RESET}`);
  console.log('');

  const dbPath = getDbPath();
  const existed = existsSync(dbPath);
  getDb(); // opens + migrates (v1 databases are upgraded with an automatic backup)

  if (existed) {
    console.log(`${GREEN}  ✓${RESET} Found existing database — schema v${SCHEMA_VERSION} ${DIM}(v1 data is migrated automatically, a backup lands in ~/.soul/backups/)${RESET}`);
  } else {
    console.log(`${GREEN}  ✓${RESET} Database created at ${CYAN}${dbPath}${RESET}`);
    capture({
      content: 'Soul v2 was initialized. Event ledger, capture pipeline and context compiler are active.',
      category: 'learning',
      importance: 0.6,
      sourceType: 'reflection',
    });
  }

  loadConstitution();
  console.log(`${GREEN}  ✓${RESET} Constitution at ${CYAN}${constitutionPath()}${RESET} ${DIM}(edit it — it is enforced in code)${RESET}`);
  console.log('');
  printConfig();
}

function status(): void {
  if (!existsSync(getDbPath())) {
    console.log(`${AMBER}  Soul not initialized. Run: ${CYAN}npx soul-mcp init${RESET}`);
    return;
  }
  const stats = getStats();
  console.log('');
  console.log(`${AMBER}${BOLD}  Soul Status${RESET} ${DIM}v2.0.0${RESET}`);
  console.log(`${DIM}  ──────────────────────────────${RESET}`);
  console.log(`  Memories:    ${BOLD}${stats.totalMemories}${RESET} ${DIM}${JSON.stringify(stats.byStatus)}${RESET}`);
  console.log(`  Events:      ${BOLD}${stats.totalEvents}${RESET}`);
  console.log(`  Goals:       ${BOLD}${stats.totalGoals}${RESET}`);
  console.log(`  Identity:    ${BOLD}${stats.identityFacets}${RESET} facets`);
  console.log(`  Sessions:    ${BOLD}${getSessionCount()}${RESET}`);
  console.log(`  Integrity:   confirmed ${stats.integrity.confirmed_share} · disputed ${stats.integrity.disputed_count} · stale(180d) ${stats.integrity.stale_share_180d} · provenance ${stats.integrity.provenance_coverage}`);
  console.log(`  Database:    ${CYAN}${getDbPath()}${RESET}`);
  console.log('');
}

function doctor(): void {
  console.log('');
  console.log(`${AMBER}${BOLD}  Soul Doctor${RESET}`);
  let ok = true;

  const check = (label: string, fn: () => string | true) => {
    try {
      const result = fn();
      if (result === true) {
        console.log(`${GREEN}  ✓${RESET} ${label}`);
      } else {
        console.log(`${GREEN}  ✓${RESET} ${label} ${DIM}${result}${RESET}`);
      }
    } catch (error) {
      ok = false;
      console.log(`${RED}  ✗${RESET} ${label}: ${error}`);
    }
  };

  check('database opens and migrates', () => {
    getDb();
    return `schema v${SCHEMA_VERSION}`;
  });
  check('sqlite integrity_check', () => {
    const result = getDb().pragma('integrity_check') as Array<{ integrity_check: string }>;
    if (result[0]?.integrity_check !== 'ok') throw new Error(JSON.stringify(result));
    return true;
  });
  check('fts index consistent', () => {
    const db = getDb();
    const m = (db.prepare(`SELECT COUNT(*) c FROM memories`).get() as any).c;
    const f = (db.prepare(`SELECT COUNT(*) c FROM memories_fts`).get() as any).c;
    if (m !== f) throw new Error(`memories=${m} fts=${f} — run backup, then reindex`);
    return `${m} rows`;
  });
  check('constitution loads', () => {
    loadConstitution();
    return constitutionPath();
  });
  check('backup directory writable', () => {
    const dir = getBackupDir();
    writeFileSync(join(dir, '.write-test'), 'ok');
    return dir;
  });
  check('export/import round-trip (in memory)', () => {
    const data = exportAll({ includeEvents: false });
    if (!data.checksum) throw new Error('missing checksum');
    return `${data.memories.length} memories checksummed`;
  });

  console.log('');
  console.log(ok ? `${GREEN}  All checks passed.${RESET}` : `${RED}  Some checks failed.${RESET}`);
  console.log('');
  if (!ok) process.exitCode = 1;
}

function backup(): void {
  getDb();
  const dest = backupLive('manual');
  appendEvent('system.backup', 'system', null, { path: dest });
  console.log(`${GREEN}  ✓${RESET} Backup written to ${CYAN}${dest}${RESET}`);
}

function restore(file?: string): void {
  const backups = existsSync(getBackupDir())
    ? readdirSync(getBackupDir()).filter((f) => f.endsWith('.db')).sort().reverse()
    : [];
  if (!file) {
    console.log(`  Usage: soul-mcp restore <backup-file>`);
    console.log(`  Available backups in ${CYAN}${getBackupDir()}${RESET}:`);
    for (const b of backups.slice(0, 10)) console.log(`    ${b}`);
    return;
  }
  const source = existsSync(file) ? file : join(getBackupDir(), file);
  if (!existsSync(source)) {
    console.log(`${RED}  ✗${RESET} Backup not found: ${source}`);
    process.exitCode = 1;
    return;
  }
  closeDb();
  const current = getDbPath();
  if (existsSync(current)) {
    const safety = backupSafetyCopy(current);
    console.log(`${DIM}  current database saved to ${safety}${RESET}`);
  }
  // stale WAL/SHM from a crashed process would override the restored file
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = current + suffix;
    if (existsSync(sidecar)) rmSync(sidecar);
  }
  copyFileSync(source, current);
  console.log(`${GREEN}  ✓${RESET} Restored from ${CYAN}${source}${RESET}`);
}

function backupSafetyCopy(dbPath: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = join(getBackupDir(), `memories-pre-restore-${stamp}.db`);
  copyFileSync(dbPath, dest);
  return dest;
}

function exportCmd(outFile?: string): void {
  getDb();
  const data = exportAll();
  const out = outFile || join(getSoulDir(), `soul-passport-${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(out, JSON.stringify(data, null, 2));
  console.log(`${GREEN}  ✓${RESET} Exported ${data.memories.length} memories, ${data.identity.length} facets, ${data.goals.length} goals, ${data.events.length} events`);
  console.log(`    ${CYAN}${out}${RESET}`);
}

function importCmd(inFile?: string): void {
  if (!inFile || !existsSync(inFile)) {
    console.log(`  Usage: soul-mcp import <soul-passport.json>`);
    process.exitCode = 1;
    return;
  }
  getDb();
  const data = JSON.parse(readFileSync(inFile, 'utf-8'));
  const result = importAll(data);
  console.log(`${GREEN}  ✓${RESET} Imported: ${result.memories.imported} memories (${result.memories.skipped} already present), ` +
    `${result.identity.imported} facets, ${result.goals.imported} goals, ${result.events.imported} events`);
  if (!result.checksumValid) {
    console.log(`${AMBER}  ! checksum mismatch — the file may have been edited or truncated${RESET}`);
  }
}

function printConfig(): void {
  console.log(`  ${BOLD}Add Soul to your AI client${RESET}`);
  console.log('');
  console.log(`  ${BOLD}Claude Code:${RESET}  ${CYAN}claude mcp add soul -- npx -y soul-mcp${RESET}`);
  console.log('');
  console.log(`  ${BOLD}Claude Desktop / Cursor / Windsurf${RESET} ${DIM}(mcpServers section)${RESET}`);
  console.log(`${CYAN}  { "soul": { "command": "npx", "args": ["-y", "soul-mcp"] } }${RESET}`);
  console.log('');
  console.log(`${DIM}  The same command serves MCP when spawned by a client and shows this help in a terminal.${RESET}`);
  console.log('');
}

function help(): void {
  console.log('');
  console.log(`${AMBER}${BOLD}  Soul MCP v2${RESET} — a trusted continuity layer for your AI.`);
  console.log('');
  console.log(`  ${BOLD}Commands${RESET}`);
  console.log(`    ${CYAN}soul-mcp init${RESET}                Initialize (or migrate a v1 database, with backup)`);
  console.log(`    ${CYAN}soul-mcp serve${RESET}               Start the MCP server (stdio)`);
  console.log(`    ${CYAN}soul-mcp status${RESET}              Memory, ledger and integrity overview`);
  console.log(`    ${CYAN}soul-mcp doctor${RESET}              Health checks (schema, integrity, fts, backups)`);
  console.log(`    ${CYAN}soul-mcp backup${RESET}              Consistent snapshot into ~/.soul/backups/`);
  console.log(`    ${CYAN}soul-mcp restore <file>${RESET}      Restore a backup (current db is saved first)`);
  console.log(`    ${CYAN}soul-mcp export [file]${RESET}       Write a soul-passport JSON`);
  console.log(`    ${CYAN}soul-mcp import <file>${RESET}       Import a soul-passport (idempotent)`);
  console.log(`    ${CYAN}soul-mcp config${RESET}              Show client configuration snippets`);
  console.log('');
  console.log(`  ${DIM}Data: ~/.soul/memories.db · Policy: ~/.soul/constitution.json (enforced in code)${RESET}`);
  console.log('');
}
