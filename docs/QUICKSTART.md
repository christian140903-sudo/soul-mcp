# Soul quick start

This guide takes a fresh machine from zero to persistent MCP memory without a
cloud account.

## Requirements

- Node.js 18 or newer
- an MCP client that can launch a local stdio server

## 1. Initialize and check the local store

```bash
npx -y soul-mcp init
npx -y soul-mcp doctor
```

The canonical database is `~/.soul/memories.db`. Initialization is safe to run
again. Existing v1, v2 and v3 databases migrate automatically after a verified
backup.

## 2. Connect a client

### Claude Code

```bash
claude mcp add soul -- npx -y soul-mcp
```

### Claude Desktop, Cursor or Windsurf

Add this entry to the client's `mcpServers` configuration:

```json
{
  "soul": {
    "command": "npx",
    "args": ["-y", "soul-mcp"]
  }
}
```

Restart the client after changing its MCP configuration.

## 3. Verify the experience

In the client, ask:

> Remember that I prefer concise release notes with a verification section.

Then start a new conversation and ask:

> What do you know about how I prefer release notes?

The client decides when to call tools. You can ask it explicitly to use
`soul_remember`, `soul_recall` or `soul_context` when testing a setup.

## Useful commands

```bash
npx -y soul-mcp --version
npx -y soul-mcp status
npx -y soul-mcp doctor
npx -y soul-mcp backup
npx -y soul-mcp export
```

## Optional semantic retrieval

```bash
npx -y soul-mcp semantic on
```

This is opt-in because it installs an additional local dependency and
downloads an embedding model. Keyword retrieval remains available without it.

## Troubleshooting

- **The client shows a banner instead of connecting:** confirm
  `npx -y soul-mcp --version` is 2.0.0 or newer. The v1 binary had this bug.
- **Database error:** run `npx -y soul-mcp doctor`; do not delete the database.
  Backups are in `~/.soul/backups/`.
- **Client cannot find tools:** restart the client and confirm its MCP config
  launches `npx` with `-y` and `soul-mcp` as separate arguments.
- **Need to inspect data:** export a passport. Do not post the passport in a
  public issue; it can contain personal context.
