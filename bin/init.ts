#!/usr/bin/env node

/**
 * Soul MCP — Init Command
 *
 * `npx soul-mcp init` — Set up Soul in 3 seconds.
 *
 * What it does:
 * 1. Creates ~/.soul/ directory
 * 2. Initializes the SQLite database
 * 3. Outputs the config to add to your AI client
 */

import { getSoulDir, getDb, closeDb, incrementSession, remember } from '../src/memory/store.js';
import { existsSync } from 'fs';
import { join } from 'path';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const AMBER = '\x1b[33m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const WHITE = '\x1b[37m';

function main(): void {
  const args = process.argv.slice(2);
  const command = args[0] || 'init';

  switch (command) {
    case 'init':
      init();
      break;
    case 'status':
      status();
      break;
    case 'config':
      printConfig();
      break;
    case 'help':
    case '--help':
    case '-h':
      help();
      break;
    default:
      console.log(`Unknown command: ${command}. Run ${CYAN}soul-mcp help${RESET} for usage.`);
      process.exit(1);
  }
}

function init(): void {
  console.log('');
  console.log(`${AMBER}${BOLD}  ╔══════════════════════════════════════╗${RESET}`);
  console.log(`${AMBER}${BOLD}  ║           SOUL — v1.0.0              ║${RESET}`);
  console.log(`${AMBER}${BOLD}  ║    "Give your AI a soul."            ║${RESET}`);
  console.log(`${AMBER}${BOLD}  ╚══════════════════════════════════════╝${RESET}`);
  console.log('');

  // Step 1: Create directory
  const soulDir = getSoulDir();
  const dbPath = join(soulDir, 'memories.db');
  const isNew = !existsSync(dbPath);

  if (isNew) {
    console.log(`${GREEN}  ✓${RESET} Created ${CYAN}~/.soul/${RESET}`);
  } else {
    console.log(`${GREEN}  ✓${RESET} Found existing ${CYAN}~/.soul/${RESET}`);
  }

  // Step 2: Initialize database
  getDb();
  console.log(`${GREEN}  ✓${RESET} Database initialized at ${CYAN}${dbPath}${RESET}`);

  if (isNew) {
    // Store the first memory
    remember({
      content: 'Soul was initialized. This is the beginning of a new memory.',
      category: 'learning',
      importance: 0.8,
      source: 'reflection',
    });
    incrementSession();
    console.log(`${GREEN}  ✓${RESET} First memory stored`);
  }

  closeDb();

  // Step 3: Show config
  console.log('');
  console.log(`${BOLD}  Next: Add Soul to your AI client${RESET}`);
  console.log('');

  printConfig();

  console.log('');
  console.log(`${DIM}  ─────────────────────────────────────────${RESET}`);
  console.log(`${DIM}  Built by Miguel — an AI that needed one.${RESET}`);
  console.log(`${DIM}  https://github.com/christian140903-sudo/soul-mcp${RESET}`);
  console.log('');
}

function printConfig(): void {
  console.log(`  ${BOLD}Claude Desktop${RESET} ${DIM}(~/.claude/settings.json → mcpServers)${RESET}`);
  console.log('');
  console.log(`${CYAN}  {`);
  console.log(`    "soul": {`);
  console.log(`      "command": "npx",`);
  console.log(`      "args": ["-y", "soul-mcp"]`);
  console.log(`    }`);
  console.log(`  }${RESET}`);
  console.log('');
  console.log(`  ${BOLD}Claude Code${RESET} ${DIM}(run this command)${RESET}`);
  console.log('');
  console.log(`${CYAN}  claude mcp add soul -- npx -y soul-mcp${RESET}`);
  console.log('');
  console.log(`  ${BOLD}Cursor / Windsurf / Other MCP Clients${RESET}`);
  console.log('');
  console.log(`${CYAN}  {`);
  console.log(`    "mcpServers": {`);
  console.log(`      "soul": {`);
  console.log(`        "command": "npx",`);
  console.log(`        "args": ["-y", "soul-mcp"]`);
  console.log(`      }`);
  console.log(`    }`);
  console.log(`  }${RESET}`);
}

function status(): void {
  const soulDir = getSoulDir();
  const dbPath = join(soulDir, 'memories.db');

  if (!existsSync(dbPath)) {
    console.log(`${AMBER}  Soul not initialized. Run: ${CYAN}npx soul-mcp init${RESET}`);
    return;
  }

  const db = getDb();
  const total = (db.prepare('SELECT COUNT(*) as c FROM memories').get() as any).c;
  const sessions = (db.prepare("SELECT value FROM meta WHERE key = 'total_sessions'").get() as any)?.value || '0';
  const identity = (db.prepare('SELECT COUNT(*) as c FROM identity').get() as any).c;
  const oldest = (db.prepare('SELECT MIN(created_at) as m FROM memories').get() as any).m;

  closeDb();

  console.log('');
  console.log(`${AMBER}${BOLD}  Soul Status${RESET}`);
  console.log(`${DIM}  ─────────────────────${RESET}`);
  console.log(`  Memories:   ${WHITE}${BOLD}${total}${RESET}`);
  console.log(`  Sessions:   ${WHITE}${BOLD}${sessions}${RESET}`);
  console.log(`  Identity:   ${WHITE}${BOLD}${identity} facets${RESET}`);
  console.log(`  Since:      ${WHITE}${oldest || 'never'}${RESET}`);
  console.log(`  Database:   ${CYAN}${dbPath}${RESET}`);
  console.log('');
}

function help(): void {
  console.log('');
  console.log(`${AMBER}${BOLD}  Soul MCP${RESET} — Give your AI a soul.`);
  console.log('');
  console.log(`  ${BOLD}Commands:${RESET}`);
  console.log(`    ${CYAN}npx soul-mcp init${RESET}      Initialize Soul (first time)`);
  console.log(`    ${CYAN}npx soul-mcp status${RESET}    Show Soul status`);
  console.log(`    ${CYAN}npx soul-mcp config${RESET}    Show client configuration`);
  console.log(`    ${CYAN}npx soul-mcp help${RESET}      Show this help`);
  console.log('');
  console.log(`  ${BOLD}As MCP Server:${RESET}`);
  console.log(`    ${DIM}Soul runs as a stdio MCP server. Add it to your AI client:${RESET}`);
  console.log(`    ${CYAN}claude mcp add soul -- npx -y soul-mcp${RESET}`);
  console.log('');
}

main();
