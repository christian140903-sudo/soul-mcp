/**
 * MCP server bootstrap. stdout is protocol-only; logs go to stderr.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createSoulServer } from './server.js';
import { closeDb, getDb } from './kernel/db.js';
import { expireStaleCandidates } from './kernel/memory.js';
import { loadConstitution } from './kernel/policy.js';
import { isSemanticConfigured, backfillVectors } from './kernel/semantic.js';
import { parseDuration } from './util/core.js';

export function startServer(): void {
  // Fail fast and loudly (on stderr) if the database can't be opened/migrated.
  try {
    getDb();
    const constitution = loadConstitution();
    const ms = parseDuration(constitution.retention.candidate);
    if (ms !== null) {
      const expired = expireStaleCandidates(ms);
      if (expired > 0) console.error(`[soul] expired ${expired} stale candidate(s)`);
    }
    // Close embedding gaps in the background (captures whose async embed
    // failed or was cut off). No-op when the semantic layer is off.
    if (isSemanticConfigured()) {
      void backfillVectors()
        .then((r) => {
          if (r.embedded > 0) console.error(`[soul] semantic backfill: ${r.embedded}/${r.total} vector(s)`);
        })
        .catch(() => {});
    }
  } catch (error) {
    console.error('[soul] failed to open database:', error);
    process.exit(1);
  }

  const server = createSoulServer();
  const transport = new StdioServerTransport();

  const shutdown = () => {
    closeDb();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  server.connect(transport).catch((error) => {
    console.error('[soul] failed to start:', error);
    closeDb();
    process.exit(1);
  });
}
