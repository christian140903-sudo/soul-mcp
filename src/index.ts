#!/usr/bin/env node

/**
 * Soul MCP — single entry point.
 *
 * The v1 packaging bug (bin pointed at the init script, so MCP clients
 * launched a banner instead of a server) is fixed here structurally:
 *
 * - `soul-mcp serve`        -> MCP server, always
 * - `soul-mcp <command>`    -> CLI (init, status, doctor, backup, ...)
 * - `soul-mcp` (no args)    -> server when stdin is piped (how MCP clients
 *                              spawn processes), help when run in a terminal
 *
 * So every existing client config using `npx -y soul-mcp` starts the real
 * server, and humans in a terminal still get readable help.
 */

import { runCli } from './cli.js';
import { startServer } from './serve.js';

const arg = process.argv[2];

if (arg === 'serve' || (arg === undefined && !process.stdin.isTTY)) {
  startServer();
} else {
  runCli(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
