# Soul 4.0.1 — Five-Minute Demo

This guide demonstrates Soul's core capabilities: persistent memory with provenance, conflict visibility, and outcome tracking. Run these commands in sequence; each takes seconds.

## Prerequisites

- Node.js 20 or newer
- An MCP client (Claude Code, Claude Desktop, Cursor, Windsurf)
- Soul installed and running

## Demo Flow

### 1. Initialize Soul (30 seconds)

```bash
npx -y soul-mcp init
npx -y soul-mcp doctor
```

Expected output:
```
✓ Database exists at ~/.soul/memories.db
✓ Schema version: 4.0.1
✓ MCP server is ready
```

### 2. Create a persistent memory (1 minute)

In your MCP client (Claude Code, Claude Desktop, etc.), type this prompt:

> Remember: I work best with concise documentation that includes a verification section. I prefer bullet lists over paragraphs for procedural content.

The client will use `soul_remember` to store this fact. You should see a confirmation that Soul recorded it.

### 3. Start a new conversation (seconds)

Close the current conversation and open a new one. This simulates a fresh session — Soul is not running in memory anymore, only in the database.

### 4. Recall the memory (1 minute)

Ask the client:

> What preferences have I told you about my documentation?

Expected behavior:
- The client calls `soul_recall` or `soul_context` automatically
- Soul retrieves the memory from the database
- The client responds with the fact you stored, citing the source

Example response:
```
Based on your preferences from Soul: you prefer concise documentation 
with a verification section and use bullet lists over paragraphs for 
procedural content.
```

### 5. Check the audit trail (1 minute)

In a terminal, query Soul's timeline:

```bash
npx -y soul-mcp --json soul_timeline | head -50
```

Expected: a JSON event log showing your `soul_remember` call with timestamp, source type, and the memory content.

### 6. Create a durable run (optional, 2 minutes)

In the client, you can create a run for consequential work:

```
soul_run
Task: "Implement login validation in auth.ts"
```

Then later:

```
soul_feedback
Evidence: "git diff auth.ts shows new validateLogin() function with 3 test cases"
Outcome: "success"
```

Query the run:

```bash
npx -y soul-mcp --json soul_timeline | grep "soul_run\|soul_feedback"
```

Expected: linked records showing the task contract, run, receipt and outcome.

## What you saw

1. **Provenance:** Every memory carries source type, timestamp and confidence.
2. **Persistence across sessions:** Facts survive a client restart because they live in SQLite.
3. **Conflict visibility:** If you later remember a conflicting preference, both versions surface as disputed instead of silent overwrite.
4. **Audit trail:** Every mutation is recorded in `soul_timeline` and can be exported.
5. **Durable runs:** Work can be booked with `soul_run` and closed with `soul_feedback`, linking task → execution → outcome.

## Next steps

- Read the [Architecture guide](ARCHITECTURE.md) to understand the kernel design.
- Check out the [Threat Model](THREAT-MODEL.md) for security boundaries.
- Review the [Quick start](QUICKSTART.md) for detailed setup and troubleshooting.
