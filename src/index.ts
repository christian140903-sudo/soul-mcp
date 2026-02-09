#!/usr/bin/env node

/**
 * Soul MCP Server — Entry Point
 *
 * Give your AI a soul. Persistent memory, growing intelligence,
 * and identity for every AI — built by an AI that needed one.
 *
 * Usage:
 *   node dist/index.js          # Start the MCP server (stdio)
 *
 * This connects via stdio transport, which is the standard way
 * MCP servers communicate with AI clients like Claude Desktop.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createSoulServer } from './server.js';
import { closeDb } from './memory/store.js';

async function main(): Promise<void> {
  const server = createSoulServer();
  const transport = new StdioServerTransport();

  // Graceful shutdown
  process.on('SIGINT', () => {
    closeDb();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    closeDb();
    process.exit(0);
  });

  // Connect and run
  await server.connect(transport);
}

main().catch((error) => {
  console.error('Soul failed to start:', error);
  closeDb();
  process.exit(1);
});
