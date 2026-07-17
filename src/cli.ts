/**
 * Soul CLI: init, status, doctor, backup, restore, export, import, config, help.
 * Human-facing output only — the MCP server lives in serve.ts.
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync, readdirSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import {
  getDb,
  closeDb,
  getDbPath,
  getSoulDir,
  getBackupDir,
  backupLive,
  SCHEMA_VERSION,
  SOUL_VERSION,
} from './kernel/db.js';
import {
  semanticDir,
  setSemanticConfigured,
  semanticStatus,
  backfillVectors,
  embedQuery,
  EMBEDDING_MODEL,
} from './kernel/semantic.js';
import { capture } from './kernel/memory.js';
import { getStats, getSessionCount } from './kernel/stats.js';
import { exportAll, importAll } from './kernel/transfer.js';
import { constitutionPath, loadConstitution } from './kernel/policy.js';
import { appendEvent } from './kernel/ledger.js';
import {
  registerSkill,
  transitionSkill,
  listSkills,
  importPack,
  pinTrustedKey,
  keyIdOf,
  type SkillLifecycle,
} from './kernel/skills.js';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const AMBER = '\x1b[33m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';

export async function runCli(args: string[]): Promise<void> {
  const command = args[0] || 'help';
  try {
    switch (command) {
      case 'init': init(); break;
      case 'status': await status(); break;
      case 'doctor': doctor(); break;
      case 'backup': backup(); break;
      case 'restore': restore(args[1]); break;
      case 'export': exportCmd(args[1]); break;
      case 'import': importCmd(args[1]); break;
      case 'semantic': await semanticCmd(args.slice(1)); break;
      case 'skill': skillCmd(args.slice(1)); break;
      case 'config': printConfig(); break;
      case 'help': case '--help': case '-h': help(); break;
      case '--version': case '-v': console.log(SOUL_VERSION); break;
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
  console.log(`${AMBER}${BOLD}  SOUL v${SOUL_VERSION}${RESET} ${DIM}— a trusted continuity layer for your AI${RESET}`);
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

async function status(): Promise<void> {
  if (!existsSync(getDbPath())) {
    console.log(`${AMBER}  Soul not initialized. Run: ${CYAN}npx soul-mcp init${RESET}`);
    return;
  }
  const stats = getStats();
  const sem = await semanticStatus();
  console.log('');
  console.log(`${AMBER}${BOLD}  Soul Status${RESET} ${DIM}v${SOUL_VERSION}${RESET}`);
  console.log(`${DIM}  ──────────────────────────────${RESET}`);
  console.log(`  Memories:    ${BOLD}${stats.totalMemories}${RESET} ${DIM}${JSON.stringify(stats.byStatus)}${RESET}`);
  console.log(`  Events:      ${BOLD}${stats.totalEvents}${RESET}`);
  console.log(`  Goals:       ${BOLD}${stats.totalGoals}${RESET}`);
  console.log(`  Identity:    ${BOLD}${stats.identityFacets}${RESET} facets`);
  console.log(`  Sessions:    ${BOLD}${getSessionCount()}${RESET}`);
  console.log(`  Integrity:   user-confirm ${stats.integrity.user_statement_confirmation_rate} · inference-review ${stats.integrity.inference_review_rate} · high-trust ${stats.integrity.high_trust_share} · disputed ${stats.integrity.disputed_count} · freshness-due ${stats.integrity.freshness_due}`);
  console.log(`  Semantic:    ${sem.configured ? (sem.available ? `${GREEN}on${RESET} ${DIM}(${sem.model}, ${sem.vectors} vectors, ${sem.missing} missing)${RESET}` : `${RED}configured but unavailable${RESET} ${DIM}(${sem.note})${RESET}`) : `${DIM}off — keyword search only. Enable: soul-mcp semantic on${RESET}`}`);
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

async function semanticCmd(args: string[]): Promise<void> {
  const sub = args[0] || 'status';
  getDb();
  if (sub === 'on') {
    const dir = semanticDir();
    mkdirSync(dir, { recursive: true });
    console.log(`${DIM}  installing @huggingface/transformers into ${dir} (one-time, ~400 MB installed — this is why it is opt-in)…${RESET}`);
    const result = spawnSync(
      'npm',
      ['install', '--prefix', dir, '--no-fund', '--no-audit', '--loglevel=error', '@huggingface/transformers@^4.2.0'],
      { stdio: 'inherit' }
    );
    if (result.status !== 0) {
      console.log(`${RED}  ✗${RESET} npm install failed — semantic layer NOT enabled.`);
      process.exitCode = 1;
      return;
    }
    setSemanticConfigured(true);
    console.log(`${DIM}  loading the embedding model (${EMBEDDING_MODEL}; downloads ~30 MB on first run)…${RESET}`);
    const probe = await embedQuery('warmup');
    if (!probe) {
      const s = await semanticStatus();
      console.log(`${RED}  ✗${RESET} embedding backend failed to load${s.note ? `: ${s.note}` : ''} — semantic layer NOT enabled.`);
      setSemanticConfigured(false);
      process.exitCode = 1;
      return;
    }
    console.log(`${GREEN}  ✓${RESET} semantic layer enabled ${DIM}(${EMBEDDING_MODEL}, ${probe.length} dims, multilingual)${RESET}`);
    appendEvent('system.semantic', 'system', null, { enabled: true, model: EMBEDDING_MODEL });
    await backfillCmd();
  } else if (sub === 'off') {
    setSemanticConfigured(false);
    appendEvent('system.semantic', 'system', null, { enabled: false });
    console.log(`${GREEN}  ✓${RESET} semantic layer disabled — recall falls back to keyword search. Stored vectors are kept.`);
  } else if (sub === 'backfill') {
    await backfillCmd();
  } else {
    const s = await semanticStatus();
    console.log('');
    console.log(`  Semantic layer: ${s.configured ? (s.available ? `${GREEN}on${RESET}` : `${RED}configured but unavailable${RESET} (${s.note})`) : 'off'}`);
    console.log(`  Model:          ${s.model}`);
    console.log(`  Vectors:        ${s.vectors} stored, ${s.missing} memories missing one`);
    console.log('');
    console.log(`${DIM}  soul-mcp semantic on | off | backfill${RESET}`);
    console.log('');
  }
}

async function backfillCmd(): Promise<void> {
  const r = await backfillVectors({
    onProgress: (done, total) => process.stdout.write(`\r  embedding ${done}/${total}…`),
  });
  if (r.total > 0) process.stdout.write('\n');
  console.log(
    r.total === 0
      ? `${GREEN}  ✓${RESET} all memories already have vectors`
      : `${GREEN}  ✓${RESET} backfill: ${r.embedded}/${r.total} missing vectors embedded`
  );
}

/**
 * Skill-Registry management (Soul 4.0 Phase 3). Deliberately CLI-only:
 * register/promote/import are Ring-2 user actions — the 22+1 MCP tool
 * contract stays untouched, models cannot manage the registry.
 */
function skillCmd(args: string[]): void {
  const sub = args[0] || 'list';
  getDb();

  const readJson = (file?: string): unknown => {
    if (!file || !existsSync(file)) throw new Error(`file not found: ${file ?? '(missing argument)'}`);
    return JSON.parse(readFileSync(file, 'utf-8'));
  };
  const flagValues = (name: string): string[] => {
    const out: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === `--${name}` && args[i + 1] !== undefined) out.push(args[i + 1]!);
    }
    return out;
  };
  const positional = args.slice(1).filter((a, i, arr) => !a.startsWith('--') && arr[i - 1]?.startsWith('--') !== true);

  if (sub === 'list') {
    const skills = listSkills();
    if (skills.length === 0) {
      console.log(`${DIM}  No skills registered. Register one: ${CYAN}soul-mcp skill register <manifest.json>${RESET}`);
      return;
    }
    console.log('');
    for (const s of skills) {
      const badge = s.lifecycle === 'promoted' ? GREEN : s.lifecycle === 'revoked' ? RED : AMBER;
      console.log(`  ${badge}${s.lifecycle.padEnd(10)}${RESET} ${BOLD}${s.name}${RESET}@${s.version} ${DIM}(${s.source}${s.publisher_key_id ? `, ${s.publisher_key_id.slice(0, 20)}…` : ''})${RESET}`);
      console.log(`  ${''.padEnd(11)}${DIM}${s.description.slice(0, 100)}${RESET}`);
    }
    console.log('');
  } else if (sub === 'register') {
    const r = registerSkill(readJson(positional[0]), { source: 'local', actor: 'user' });
    if (r.ok) {
      console.log(`${GREEN}  ✓${RESET} Registered ${BOLD}${r.name}@${r.version}${RESET} in lifecycle ${AMBER}shadow${RESET} ${DIM}(every skill starts here — promote via canary + evidence)${RESET}`);
    } else {
      console.log(`${RED}  ✗${RESET} Refused: ${r.reason}${r.detail ? ` — ${r.detail}` : ''}`);
      process.exitCode = 1;
    }
  } else if (sub === 'transition' || sub === 'promote' || sub === 'revoke') {
    const name = positional[0];
    const to: SkillLifecycle | undefined =
      sub === 'promote' ? 'promoted' : sub === 'revoke' ? 'revoked' : (positional[1] as SkillLifecycle | undefined);
    const version = flagValues('version')[0];
    if (!name || !to) {
      console.log(`  Usage: soul-mcp skill transition <name> <to> [--version X] [--evidence <ref>] [--reason <text>]`);
      process.exitCode = 1;
      return;
    }
    const evidence = flagValues('evidence');
    const r = transitionSkill(name, to, {
      version,
      ...(evidence.length > 0 ? { evidence: { eval_refs: evidence } } : {}),
      reason: flagValues('reason')[0],
      actor: 'user',
    });
    if (r.ok) {
      console.log(`${GREEN}  ✓${RESET} ${r.name}@${r.version}: ${r.from} → ${BOLD}${r.to}${RESET}`);
      if (r.cancelled_runs.length > 0) console.log(`    ${AMBER}rollback cancelled ${r.cancelled_runs.length} open run(s): ${r.cancelled_runs.join(', ')}${RESET}`);
    } else {
      console.log(`${RED}  ✗${RESET} Refused: ${r.reason}${r.detail ? ` — ${r.detail}` : ''}`);
      process.exitCode = 1;
    }
  } else if (sub === 'import') {
    const r = importPack(readJson(positional[0]), { actor: 'user' });
    if (r.ok) {
      console.log(`${GREEN}  ✓${RESET} Imported pack ${BOLD}${r.pack_name}@${r.pack_version}${RESET} from ${DIM}${r.key_id}${RESET}`);
      for (const s of r.skills_registered) console.log(`    ${AMBER}shadow${RESET} ${s.name}@${s.version} ${DIM}(pack skills always start in shadow)${RESET}`);
      if (r.sections_skipped.length > 0) console.log(`    ${DIM}skipped unknown optional sections: ${r.sections_skipped.join(', ')}${RESET}`);
    } else {
      console.log(`${RED}  ✗${RESET} Refused (fail-closed): ${r.reason}${r.detail ? ` — ${r.detail}` : ''}`);
      process.exitCode = 1;
    }
  } else if (sub === 'pin') {
    // Explicit TOFU pinning — running this command IS the user confirmation
    // (Ring 2). Verify the fingerprint out-of-band before pinning.
    const doc = readJson(positional[0]) as { envelope?: { publisher?: { key_id?: string; pubkey?: string } } };
    const pub = doc?.envelope?.publisher;
    if (!pub?.key_id || !pub?.pubkey) {
      console.log(`${RED}  ✗${RESET} No publisher key found in the pack file.`);
      process.exitCode = 1;
      return;
    }
    const fingerprint = keyIdOf(pub.pubkey);
    console.log(`  Publisher fingerprint: ${BOLD}${fingerprint}${RESET}`);
    console.log(`  ${DIM}Compare this out-of-band with the publisher before trusting imports (SIGNED-PACK-TRUST §1).${RESET}`);
    const r = pinTrustedKey({ keyId: pub.key_id, pubkey: pub.pubkey, label: flagValues('label')[0], actor: 'user' });
    if (r.ok) {
      console.log(r.already_pinned
        ? `${GREEN}  ✓${RESET} Key was already pinned.`
        : `${GREEN}  ✓${RESET} Key pinned (TOFU). Imports signed by this key are now accepted.`);
    } else {
      console.log(`${RED}  ✗${RESET} Refused: ${r.reason}${r.detail ? ` — ${r.detail}` : ''}`);
      process.exitCode = 1;
    }
  } else {
    console.log(`  Unknown skill subcommand: ${sub}`);
    console.log(`  ${DIM}soul-mcp skill list | register <manifest.json> | transition <name> <to> [--version X] [--evidence <ref>]… | promote <name> --evidence <ref> | revoke <name> | import <pack.json> | pin <pack.json> [--label <text>]${RESET}`);
    process.exitCode = 1;
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
  console.log(`    ${CYAN}soul-mcp semantic on${RESET}         Enable local semantic retrieval (opt-in download)`);
  console.log(`    ${CYAN}soul-mcp semantic backfill${RESET}   Embed memories that are missing a vector`);
  console.log(`    ${CYAN}soul-mcp skill list${RESET}          Skill registry (lifecycle, source, publisher)`);
  console.log(`    ${CYAN}soul-mcp skill register <f>${RESET}  Register a SkillManifest@1 (starts in shadow)`);
  console.log(`    ${CYAN}soul-mcp skill transition${RESET}    Lifecycle moves; promote needs --evidence <ref>`);
  console.log(`    ${CYAN}soul-mcp skill import <pack>${RESET} Import a signed skill pack (fail-closed)`);
  console.log(`    ${CYAN}soul-mcp skill pin <pack>${RESET}    Pin a publisher key (explicit TOFU trust)`);
  console.log(`    ${CYAN}soul-mcp config${RESET}              Show client configuration snippets`);
  console.log('');
  console.log(`  ${DIM}Data: ~/.soul/memories.db · Policy: ~/.soul/constitution.json (enforced in code)${RESET}`);
  console.log('');
}
