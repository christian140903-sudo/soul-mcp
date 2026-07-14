# Changelog

## 3.0.1 — 2026-07-14

Bugfix release for the Denkpartner protocol's two integrity gaps, found in a
live-session audit (with GPT-5.6 Sol as outside reviewer). Schema migrates
v5 → v6 automatically, with a backup written first.

### Fixed
- **Workbench re-issue bug (P0):** a resolved assignment only closed the
  assignment — the detectors never learned the verdict, so `keep_separate`
  pairs (and `unclear`, `doubt`, `recommend_confirm`, `still_open` subjects)
  were re-issued on the next scan. New `workbench_decisions` table records
  every applied verdict: terminal outcomes (`keep_separate`, `compatible`,
  supersessions, `needs_user`, resolved predictions) block re-issue for good;
  non-terminal ones (`unclear`, `doubt`, `endorse`, `recommend_confirm` 30 days,
  `still_open` 7 days) carry a cooldown. Decision insert, state change and
  assignment close commit in one transaction. Regression-tested: three
  detector runs after each resolution kind issue nothing new.
- **Silent resolve on rejected verdicts:** a resolution the apply-guards
  rejected (`invalid_resolution`, `capture_failed`) still marked the
  assignment `resolved`. It now stays open — nothing may look answered when
  nothing was applied.
- **Provenance guard (P0):** `soul_remember` defaulted to `user_statement`,
  and `soul_confirm` was booked as a user action — agent writes could mint
  user authority. Tool-call default is now `agent_inference`; `user_statement`
  requires a `source_ref` citing the user's words (downgraded with an explicit
  note otherwise); `soul_confirm` books the ledger actor as `user` only when
  `user_evidence` is passed, `agent` otherwise. The confirmation itself still
  applies either way.

### Fixed (release-gate findings, GPT-5.6 Sol audit)
- **Provenance guard covers ALL user-authority paths:** `soul_identity`
  `confirmed=true` and `soul_correct` now also require `user_evidence` — an
  unevidenced confirmation is downgraded to an observation, an unevidenced
  correction is stored as `agent_inference`, both with an explicit note.
  Enforced in the kernel, not just the tool layer.
- **Stale conflict links:** superseding, retiring, expiring, correcting or
  forgetting a memory now clears the contradiction back-links on its partners
  (last conflict gone → partner returns to `active`). Previously a disputed
  memory could keep pointing at a superseded/deleted partner and sit in the
  review queue forever.
- **WAL-safe migration backups:** the automatic pre-migration backup uses
  `VACUUM INTO` (consistent snapshot including WAL content) and is verified
  with `integrity_check` before the migration runs — a plain file copy could
  miss committed data in the WAL sidecar.
- **Soul Passport completeness:** `soul_export`/`soul_import` now carry
  `workbench_decisions` and `predictions` — terminal verdicts, cooldowns and
  the calibration record survive a passport transfer. Passports exported
  before 3.0.1 still verify against their original checksum.

### Fixed (second-round gate findings)
- **Stale confirmations:** changing a confirmed identity facet's VALUE without
  fresh `user_evidence` now drops it back to `observed` — an old confirmation
  covers only the value the user actually confirmed (this also closes the
  `soul_reflect` identity-update path). Unchanged values keep their status.
- **Actor forgery closed:** the kernel derives the ledger actor strictly from
  evidence (`user` only with non-whitespace `user_evidence`); the caller can
  no longer pass an actor override, and whitespace never counts as evidence
  (including `source_ref` for `user_statement` writes).
- **All six user-authority paths guarded:** `soul_goal` (create/update/complete)
  and `soul_forget` were still booked as user actions by default — both now
  default to `agent` and accept `user_evidence`, reported via `booked_as`.

### Changed
- `soul_remember` and `soul_correct` responses now include the stored `source_type`.
- Dispute verdict `unclear` outcome string renamed from `noted` to `unclear`.

### Tests
- 53 → 70: workbench re-issue regressions (8), MCP provenance end-to-end
  (remember/confirm/identity/correct/forget/goal, candidate flow), actor-forgery
  and whitespace-evidence negatives, stale-pair cleanup, passport round-trip
  including decisions + predictions with a 3.0.0-checksum compatibility case,
  and a v5→v6 migration test with WAL-resident data and a full restore drill.

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
