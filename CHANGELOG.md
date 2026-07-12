# Changelog

## 2.0.0 — 2026-07-12

Complete kernel rewrite. v1 databases are migrated automatically (with backup).

### Fixed
- **Critical:** the published `bin` pointed at the init script, so MCP clients following the documented config (`npx -y soul-mcp`) launched a banner on stdout and exited instead of serving MCP. The entry point now serves when spawned with piped stdio and shows help in a terminal; an end-to-end JSON-RPC test guards this permanently.
- Import no longer duplicates data on re-import (idempotent by id/aspect).
- Export/import now preserves ids, timestamps and access counters exactly (round-trip tested).
- All multi-statement writes run in transactions.

### Added
- Append-only **event ledger** with bitemporal fields (`valid_from`/`valid_until` vs `recorded_at`); every mutation is an event; `soul_timeline` queries history and reconstructs what Soul knew at any past date.
- **Capture pipeline**: secret rejection (API keys, tokens, passwords, private keys), prompt-injection quarantine, duplicate merging, sensitive-category confirmation flow with expiring candidates, word-overlap conflict detection that marks contradicting memories `disputed` instead of overwriting.
- **Provenance** on every memory: source type, source ref, confidence (lower for agent inferences than user statements), status lifecycle (`candidate/active/confirmed/disputed/superseded/expired/deleted/quarantined`).
- `soul_correct`: corrections supersede with links; nothing is mutated in place.
- **Context compiler** (`soul_context`): token-budgeted capsules with per-item reasons and provenance, constitution-based sensitivity exclusion, and context receipts in the ledger.
- **Constitution** at `~/.soul/constitution.json`, enforced deterministically in the storage layer.
- **Goals & commitments** with overdue detection.
- **Soul Passport** export/import: checksummed, idempotent, full-fidelity; legacy v1 exports still import.
- **MCP resources** (`soul://identity`, `soul://status`, `soul://goals`, `soul://constitution`, `soul://conflicts`, `soul://timeline`, `soul://memory/{id}`) and **prompts** (`soul-session-start`, `soul-daily-review`, `soul-session-end`).
- CLI: `serve`, `doctor`, `backup`, `restore`, `export`, `import`; versioned schema migrations with automatic pre-migration backups.
- Knowledge-integrity report in `soul_status` (confirmed share, disputed count, stale share, provenance coverage).
- Test suite: 31 tests including migration from a real v1 schema and an end-to-end MCP handshake.

### Not included (deliberately)
Embeddings, knowledge graph, UI, sync, connectors, multi-agent orchestration — see "Honest scope" in the README.

## 1.0.0 — 2026-02-09

Initial release: SQLite/FTS5 memory store, identity facets, session tracking, 11 MCP tools.
