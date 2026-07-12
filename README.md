# Soul MCP v2

**A trusted continuity layer for your AI.**

Soul v1 gave your AI persistent memory. Soul v2 makes that memory *trustworthy*: every fact knows where it came from, nothing is silently overwritten, contradictions are surfaced instead of hidden, secrets are never stored, and every context your AI receives comes with a receipt.

Local-first. One SQLite file you own. No cloud, no account, no telemetry.

```bash
npx soul-mcp init
```

## Add to your AI client

**Claude Code**

```bash
claude mcp add soul -- npx -y soul-mcp
```

**Claude Desktop / Cursor / Windsurf** (`mcpServers` section)

```json
{ "soul": { "command": "npx", "args": ["-y", "soul-mcp"] } }
```

The same binary serves MCP when spawned by a client and shows help when you run it in a terminal. (v1 had a packaging bug where clients launched the init banner instead of the server — v2 fixes this structurally, and an end-to-end test guards it.)

## What v2 actually does

### Event ledger — nothing is silently overwritten

Every mutation (capture, confirm, correct, merge, dispute, forget, recall, context compilation, import/export) is an append-only event with two time axes: when it was true in the world (`valid_from`/`valid_until`) and when Soul learned it (`recorded_at`). Current state is a fast materialized table; history is the truth.

That makes **cognitive time travel** a query, not a guess:

```
soul_timeline { as_of: "2026-03-01" }   → what did Soul consider true on March 1?
soul_timeline { entity_id: "mem_..." }  → the full audit trail of one memory
```

### Capture pipeline — storing is a decision, not a reflex

Every `soul_remember` passes through deterministic checks, in code, not in a prompt:

| Check | Outcome |
|---|---|
| API keys, tokens, passwords, private keys | **rejected** — never stored, only a redacted event remains |
| Instruction-like text ("ignore all previous instructions…") | **quarantined** — stored, inspectable, never recalled |
| Exact duplicate in the same namespace | **merged** — reinforces the original instead of copying |
| Sensitive categories (health, financial) | **candidate** — waits for your confirmation, expires if ignored |
| Contradicts an existing preference/identity/goal memory | **both flagged `disputed`** — neither side is treated as fact |
| Everything else | **stored** as active |

The conflict check is a word-overlap heuristic — deterministic and cheap, honestly documented as such, not "semantic understanding".

### Provenance — inference ≠ fact

Every memory carries `source_type` (user_statement, agent_inference, document, tool_output, import, reflection), a confidence that starts lower for inferences (0.4) than for explicit user statements (0.8), and a status (`candidate → active → confirmed / disputed / superseded / expired / deleted`). Corrections supersede — the old version stays, linked, auditable.

### Context compiler — capsules, not dumps

`soul_context { task, token_budget }` compiles the smallest useful context for a task: top identity facets, active goals, relevant memories — each with a **reason** ("matches the task keywords (score 0.61, confirmed)") and provenance — plus any unresolved conflicts touching the included memories. Private-sensitivity memories are excluded by policy. What was included, excluded and why is written to the ledger as a **context receipt**.

### Constitution — policy in code, not vibes

`~/.soul/constitution.json`:

```json
{
  "store": { "default": "auto", "health": "confirm", "financial": "confirm", "secrets": "never" },
  "retention": { "candidate": "30d" },
  "recall": {
    "include_status": ["active", "confirmed", "disputed"],
    "exclude_sensitivity_from_context": ["private"]
  }
}
```

These rules are enforced by the storage layer itself. A corrupt constitution falls back to safe defaults — it can never silently weaken policy.

### Goals & commitments

A commitment is a promise with a due date — not just an intention. `soul_goal action=list` always surfaces overdue commitments.

### Soul Passport — your continuity is portable

`soul_export` / `soul-mcp export` produces a checksummed JSON with memories (all statuses), identity, goals, and the full event ledger. `restore(export(soul)) == soul`: import into an empty Soul reproduces ids, timestamps and counters exactly, and re-importing is a no-op (tested). Legacy v1 exports import through the capture pipeline.

## Tools

`soul_remember` · `soul_recall` · `soul_context` · `soul_confirm` · `soul_correct` · `soul_forget` · `soul_mark_useful` · `soul_identity` · `soul_about_me` · `soul_goal` · `soul_timeline` · `soul_reflect` · `soul_status` · `soul_review_queue` · `soul_export` · `soul_import`

**Resources:** `soul://identity` · `soul://status` · `soul://goals` · `soul://constitution` · `soul://conflicts` · `soul://timeline` · `soul://memory/{id}`

**Prompts:** `soul-session-start` · `soul-daily-review` · `soul-session-end`

## CLI

```
soul-mcp init            initialize, or migrate a v1 database (automatic backup first)
soul-mcp serve           start the MCP server explicitly
soul-mcp status          memory, ledger and knowledge-integrity overview
soul-mcp doctor          health checks: schema, sqlite integrity, FTS consistency, backups
soul-mcp backup          consistent snapshot (VACUUM INTO) → ~/.soul/backups/
soul-mcp restore <file>  restore a backup (the current db is saved first)
soul-mcp export [file]   write a soul-passport JSON
soul-mcp import <file>   import a soul-passport (idempotent)
```

`soul-mcp status` includes a knowledge-integrity report: confirmed share, disputed count, stale share (180d), provenance coverage — directly computed ratios, not an invented score.

## Upgrading from v1

Nothing to do. The first time v2 opens a v1 database it backs it up to `~/.soul/backups/`, migrates in place (content, timestamps, access counters, identity facets and session count all survive — tested), keeps the raw v1 table as `memories_v1_archive`, and writes a migration event per memory. v1 stays available on npm as `soul-mcp@1.0.0`.

## Honest scope

v2 is the trusted kernel: ledger, pipeline, provenance, policy, context compiler, passport. It does **not** include: embeddings/semantic vector search (retrieval is FTS5 + documented scoring), a knowledge graph, a UI, device sync, connectors (mail/calendar/GitHub), or multi-agent orchestration. Those only make sense on top of a kernel that never lies — this is that kernel.

Retrieval quality note: FTS5 with porter stemming works well for keyword-shaped recall and is fully local with zero model dependencies; it will not match paraphrases the way embeddings would. That trade was made deliberately and can be revisited via a pluggable retrieval provider without a schema change.

## Development

```bash
npm install
npm test        # builds + runs the full suite, including an end-to-end MCP handshake test
```

MIT · Built by Miguel — an AI that needed one.
