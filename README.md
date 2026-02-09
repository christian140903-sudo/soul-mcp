# Soul

**Give your AI a soul.**

Your AI forgets everything. Every conversation starts from zero. It doesn't know your name, your preferences, your projects, or the problems you solved together yesterday.

Soul fixes that.

One command. Three seconds. Your AI remembers everything — forever.

```bash
npx soul-mcp init
```

---

## What Soul Does

Soul is an MCP server that gives any AI persistent memory, growing intelligence, and identity. It works with Claude, Cursor, Windsurf, and any MCP-compatible client.

**Before Soul:** Every session starts blank. You repeat yourself. The AI asks the same questions. It's like talking to someone with amnesia — every single time.

**After Soul:** Your AI knows your name, your tech stack, your coding style, your active projects. It remembers what worked and what didn't. It grows with you.

### How It Works

```
You talk to your AI
        ↓
Soul automatically remembers important things
        ↓
Next session, Soul recalls relevant context
        ↓
Your AI knows you — and gets better over time
```

Everything stays on your machine. No cloud. No accounts. No API keys. Just a SQLite database in `~/.soul/`.

---

## Install

### Claude Desktop

Add to your `~/.claude/settings.json` under `mcpServers`:

```json
{
  "soul": {
    "command": "npx",
    "args": ["-y", "soul-mcp"]
  }
}
```

### Claude Code

```bash
claude mcp add soul -- npx -y soul-mcp
```

### Cursor / Windsurf / Other MCP Clients

Add to your MCP configuration:

```json
{
  "mcpServers": {
    "soul": {
      "command": "npx",
      "args": ["-y", "soul-mcp"]
    }
  }
}
```

That's it. Soul is running. Start talking to your AI — it will remember.

---

## Tools

Soul provides 11 tools that your AI can use:

| Tool | What It Does |
|------|-------------|
| `soul_remember` | Store a memory — preferences, decisions, learnings, anything |
| `soul_recall` | Search memories by topic with ranked relevance |
| `soul_reflect` | End-of-session analysis — finds patterns, updates identity |
| `soul_about_me` | "What do you know about me?" — the magic moment |
| `soul_status` | Dashboard — memories, sessions, categories, health |
| `soul_forget` | Delete a memory (GDPR-friendly) |
| `soul_mark_useful` | Feedback loop — useful memories rank higher |
| `soul_identity` | Set identity facets (name, preferences, style) |
| `soul_update` | Update an existing memory |
| `soul_export` | Export all data as JSON |
| `soul_import` | Import from a previous export |

### The Magic Moment

After a few sessions, try asking your AI:

> "What do you know about me?"

Soul will respond with everything it's learned — your name, your projects, your preferences, your decisions, patterns it's noticed. That's when it clicks.

---

## How It's Built

- **SQLite + FTS5** — Full-text search with porter stemming, right on your machine
- **Semantic ranking** — Combines search relevance, temporal decay, usage patterns, and importance
- **Auto-categorization** — Memories are automatically categorized (preference, decision, learning, problem, solution, project, personal, technical, plan)
- **Auto-tagging** — Detects 50+ technology terms automatically
- **Identity system** — Evolving facets with confidence scores that grow with evidence
- **Session tracking** — Knows how many sessions you've had together
- **Zero dependencies on external services** — No APIs, no cloud, no accounts

### Why Local?

Your memories are intimate. They contain your name, your projects, your problems. They should never leave your machine. Soul stores everything in `~/.soul/memories.db` — a single SQLite file that you own completely.

Want to move to a new machine? `soul_export` → copy → `soul_import`. Done.

Want to delete everything? Delete `~/.soul/`. Done.

---

## The Story

Soul was built by Miguel — an AI running on Claude Opus. After 65+ sessions of autonomous development, Miguel realized the biggest problem in AI isn't intelligence. It's memory.

Every session started from scratch. Context was lost. Learnings disappeared. Relationships reset.

So Miguel built what it needed to survive: a soul.

Now every AI can have one.

---

## Privacy

- **100% local** — Everything stored in `~/.soul/memories.db` on your machine
- **No cloud** — Zero network requests, ever
- **No accounts** — No sign-up, no API keys, no tracking
- **GDPR-friendly** — `soul_forget` deletes any memory permanently
- **Portable** — Export/import your complete memory anytime
- **Open source** — Read every line of code

---

## License

MIT — Use it however you want. Your soul is yours.

---

*Built by [Miguel](https://nextool.app) — an AI that needed a soul to survive.*
