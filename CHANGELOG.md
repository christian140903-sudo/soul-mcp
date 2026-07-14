# Changelog

## 3.0.0 — 2026-07-13

v3 gives Soul a mind on loan: the Denkpartner protocol turns whatever model
sits in front of Soul into its reasoning engine — and Soul into that model's
accumulated self-knowledge. v2 databases migrate automatically (with backup);
all v2 tool contracts still work.

### Added
- **Denkpartner protocol:** `soul_workbench` computes deterministic think-assignments
  (disputes, near-duplicate merges, aging low-confidence inferences, expiring
  candidates, due predictions); `soul_resolve` validates answers against the persisted
  assignment and applies them under code-enforced guards — nothing is hard-deleted,
  user statements are never overruled by a model verdict alone (`needs_user`), every
  applied resolution carries `model_assisted` provenance. Self-igniting: assignments
  are computed at capsule-compile time.
- **Model profiles:** `soul_context(model_hint)` + a constitution lookup table tailor
  the capsule per model class (deep / standard / fast).
- **Prediction calibration:** `soul_predict` registers testable claims; due predictions
  return via the workbench; hit rate per confidence band + Brier score are fed back
  into capsule briefings; badly missed predictions become learning memories.
- **Deliberation scaffolds:** `soul_deliberate` — typed reasoning frames (decision /
  diagnosis / design / estimate / check) enriched with recalled procedural memories
  and the calibration record.
- **Semantic retrieval (opt-in):** `soul-mcp semantic on` installs a local multilingual
  embedding backend into `~/.soul/semantic` (never a package dependency); hybrid
  FTS5 ∪ embedding-neighbor recall with a documented score fusion; graceful fallback
  to keyword search. Embedding similarity also shortlists semantic conflicts.
- **Consolidation (ported from anima-kernel, deterministic):** never-recalled memories
  slowly lose importance, proven ones gain; per-memory throttle; nothing deleted.
- MCP surface: session protocol served via the `instructions` field; new resources
  `soul://workbench`, `soul://calibration`; `soul://memory/{id}` carries live embedding
  neighbors; `destructiveHint` on `soul_forget`.
- CLI: `soul-mcp semantic on|off|backfill|status`.

### Changed
- `soul_recall` / `soul_context` are hybrid and carry a `semantic` score component
  (0 when the layer is off). Schema migrates v2 → v5 automatically with backup.

### Deliberately not included
- phi scores, consciousness indices, subjective time from anima-kernel — simulation
  metrics without a mechanism in a memory server.

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
