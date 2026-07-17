# Changelog

## 4.0.0 — 2026-07-17

v4 turns work into verified capability — that is the goal: model compute
becomes durable, verified, portable capability capital; every expensive,
successful run should leave an asset behind, not just an answer. 4.0.0 ships
the machinery (durable runs, episode ledger, skill registry, preregistered
eval protocol) and deliberately not the capability claims: **model
measurements have not run** (see "Honest limits").

Schema v9 → v12 in three additive migrations (v10 runs/receipts/episodes ·
v11 skills/trusted_keys/pack_versions · v12 unique indexes per (run,
attempt)), each automatic with a verified backup first (`VACUUM INTO` +
`integrity_check`).

**Breaking changes: none for the 22 v3 tools.** Their contracts are pinned by
golden-contract tests over the real MCP path (six user-authority tools,
disputed-capsule delivery, feedback semantics) and the full suite is green at
this release. `soul_feedback` and `soul_context` are extended additively —
calls without the new parameters behave exactly as in 3.1/3.2. Major bump
because 4.0 adds a new public surface (a tool, a subsystem, a CLI area), not
because anything old broke.

### Added
- **`soul_run` — the only new tool, per contract** (API-MATRIX Tabelle A).
  Compiles free text deterministically into a `TaskContract@1` and opens a
  durable run in **context mode**: the server never spawns anything, the host
  model executes in the conversation. Run, pending receipt and PENDING
  episode are created **synchronously in one transaction**. Honesty classes
  in the schema: the receipt is `self_attested` and stays `self_attested` —
  `evidence_ref` is carried as an auditable reference and does NOT upgrade
  the class; `deterministic_verified` would require a validated
  `VerifierResult@1`, which 4.0 does not produce, so it is never issued.
  Idempotency (`idempotency_key` → same run, never a duplicate), lifecycle
  actions `cancel` / `resume` / `retry` (new attempt with new fencing token,
  receipt and episode, capped by `budget.max_attempts`; CAS allows exactly
  one retry winner), states queued/running/succeeded/failed/cancelled plus
  reaper expiry: an unclosed run becomes `expired_unconfirmed` after
  `SOUL_RECEIPT_TTL_DAYS` (default 7) — missingness, not a verdict.
  **Chaos matrix:** 5 SIGKILL edge cases (before first run, right after the
  reply, amid pipelined flood, after feedback close, during the reaper
  sweep), each asserting DB invariants after restart — no orphans, no double
  close (`test/chaos.test.mjs`).
- **Episode ledger (`Episode@1`):** every run books a bitemporal
  (decision, confidence, outcome) triple with the causal chain
  recommendation → acceptance → execution → outcome and two clocks
  (occurred_at vs. recorded_at; outcomes back-fill honestly). Missingness is
  strictly separated from failure — `expired_unconfirmed` and unknown
  execution are reported, never imputed. Emitted at exactly one place, the
  `soul_run`/receipt boundary; the 22 v3 tools emit no episodes.
- **Skill registry (declarative-only), schema v11.** Skills are data, never
  code: positive grammar of typed blocks, fail-closed screening (length
  caps, secret/URL deny, monotonicity law — a skill can never grant rights).
  Lifecycle ladder with code guards Shadow → Canary → Promoted → Deprecated
  → Revoked; every skill starts in shadow, promotion requires an evidence
  reference, revocation sweeps open runs. **Ed25519-signed packs** with
  trust-on-first-use key pinning — pinning is an explicit user action, never
  implicit on import; downgrade, replay and tampering are refused; one bad
  manifest refuses the whole pack. Capsule exposure: at most **3**
  task-scoped *promoted* skills, deterministically matched; shadow/canary
  never exposed; without a match the capsule is byte-identical to the
  pre-skills contract.
- **CLI `skill` subcommand area** (no new MCP tool for registry management,
  by design): `skill list` · `skill register <manifest.json>` ·
  `skill transition <name> <to>` · `skill promote <name> --evidence <ref>` ·
  `skill revoke <name>` · `skill import <pack.json>` · `skill pin <pack.json>`.
- **8 artifact contracts** in `design/contracts/` — `TaskContract@1`,
  `SkillManifest@1`, `ReceiptV1`, `VerifierResult@1`, `CapabilityManifest@1`,
  `Episode@1`, `AuthorityEnvelope@1`, `SignedPackEnvelope@1` — with an
  anti-drift test pinning runtime copies byte-equal to the contract files.
- **Eval preregistration as code** (`eval/protocol/`): protocol document,
  machine-readable constants and statistics implementation under one
  registered hash — any change is a visible revision that discards the
  running wave. Confirmatory statistics (paired bootstrap p-values, Holm
  correction over the 4-comparison family, resamples and alpha fixed in
  `protocol.json`) are wired into a deterministic gate function and proven
  **mechanically** end-to-end: a fixture-vs-reference dry run through
  applyITT → bootstrap → Holm → gate (`eval/pilot/DRY-RUN-REPORT.md` — a
  pipeline function proof, explicitly not a model comparison), plus a
  variance-pilot harness (30 real verifier process runs, 3 tasks × 5
  repeats × 2 arms; verifier determinism confirmed, power-calculation path
  implemented — `eval/pilot/PILOT-REPORT.md`).
- **20 hermetic eval tasks** (`eval/tasks/`, 5 families × 4): a
  code-capability ladder — repo recon, failing-test diagnosis, minimal fix
  with regression test, refactor under tests, contract review — each with
  **counterfactual verifiers** (must fail the untouched fixture, must pass
  the reference solution). This is the open baseline set; held-out gate sets
  deliberately live elsewhere.
- **Import size guard:** `soul_import` refuses payloads over 50 MB (default,
  `SOUL_MAX_IMPORT_BYTES`) before parsing — availability guard from the
  threat model (TB3). Shipped alongside the 3.2.0 envelope reader but never
  changelogged; recorded here.

### Changed
- **`soul_feedback` — additive extension.** New optional parameters
  `run_id`, `outcome` (success|failure|mixed — required when `run_id` is
  set), `evidence_ref`, `summary`. With `run_id` it closes the pending
  receipt and back-fills the episode outcome bitemporally. `context_id` is
  now optional — at least one of `context_id`/`run_id` is required. Calls
  without `run_id` behave exactly as in 3.1.
- **`soul_context` — additive extension.** Optional `skills` capsule
  section: ≤3 task-scoped promoted skills, deterministic matching; without a
  match the key is absent and the capsule is byte-identical to the
  pre-skills contract (golden tests hold).
- DB schema v9 → v12 (see above); `soul_run` and skill events append to the
  same single ledger.

### Unchanged contracts
- All 22 v3 tools: contracts unchanged, golden transcripts green
  (`test/golden-contracts.test.mjs` and full suite at this release).
- `docs/API-MATRIX.md` documents 29 behavior contracts V1–V29, each with the
  test that holds it: V1–V24 (the v2/v3 surface) hold unchanged; V25–V29 pin
  the new run/skill surface.
- Passport: the writer still exports format 2.0.0 (golden test pins it); the
  sectioned `PassportEnvelope@3` is read fail-closed (since 3.2.0 — unknown
  required section → refusal, unknown optional → skip with report). Pre-4.0
  passports import unchanged; the envelope **writer** is not built yet.
- Resources (8 static + 1 template) and prompts (3): unchanged.

### Security
- Threat-model-driven (docs/THREAT-MODEL.md v1.1): skills are untrusted
  typed data, never code; the server never spawns; a compromised OS is
  explicitly out of scope.
- Skill screening fail-closed: positive grammar, secret/URL deny, length
  limits, lifecycle claims normalized to shadow, monotonicity law (no
  grant). Pack import only signed + pinned; downgrade/replay/tamper refused.
- TOFU pinning is a deliberate user action (`skill pin`), never implicit.
- Import DoS guard (50 MB cap before parse), on top of the 3.2.0 screening
  and fail-closed checksums.

### Honest limits (what 4.0.0 does NOT contain)
- **No worker/RunnerAdapter.** Context mode only; `soul-worker` is a
  designed but unbuilt separate package. The server never spawns.
- **No recipe registry** (Cognition C2a) — waits behind its own gate.
- **No competence maps, no routing recommendations** (C1a+) — they need
  real, causally linked episodes first. The stated goal of the strand:
  *soul trainiert keine Modelle; es lernt eine auditierbare
  Entscheidungspolitik darüber, welches Modell mit welchem Kontext und
  welchem Verfahren wann eingesetzt wird* — 4.0.0 builds the data backbone;
  the policy learning is not in this release.
- **No model benchmarks.** The eval infrastructure exists and is
  preregistered; the measurements (arms A–E) are outstanding. This release
  makes no claim about making any model better at anything.
- **Skill promotion checks evidence structure, not evidence truth** — the
  registry makes a bad promotion auditable, not impossible.
- **`deterministic_verified` is never issued** in 4.0.
- **`soul_status`** does not yet report run/skill metrics (planned additive).

### Tests
- 107 (3.2.0 at the r3 freeze) → **355**, green via `node --test` across 26
  test files (run 2026-07-17; the counter includes subtests). Among them:
  the 5-case SIGKILL chaos matrix, 15 run-lifecycle cases (retry race,
  double cancel, expired lease), registry/pack negative tests, the
  eval-protocol and pilot-harness suites, and a v9→current migration test on
  a real database copy.

## 3.2.0 — 2026-07-16

Schema v9 (additive, automatic migration with verified backup). Security and
correctness fixes from the 3.1.0 forensic audit (docs/AUDIT-3.1.0.md).

Minor bump (not a patch) because one public contract changes behavior:

> **Behavior change: `soul_import` now fails closed on checksum mismatch.**
> A passport whose checksum does not verify is refused (throws, no write)
> instead of being imported with a `checksumValid: false` flag. Callers that
> relied on the old "import anyway" behavior must re-export from the source
> soul or restore an untampered copy.

### Fixed
- **Import bypassed the capture pipeline (P1).** `soul_import` (v2 passports)
  wrote memories with a raw insert, so secret, injection, sensitivity and
  constitution checks never ran. Live memories (candidate/active/confirmed/
  disputed) are now screened on import: secrets are dropped with a redacted
  `import.memory_skipped` event, injection-looking content is forced to
  `quarantined`, categories the constitution forbids are dropped, and
  sensitivity is re-derived. Non-live tombstones (superseded/deleted/…) pass
  through unchanged.
- **Checksum mismatch no longer imports (P1, behavior change).** A passport
  whose checksum does not verify was altered after export; the import is now
  refused with a `ChecksumMismatchError` (no partial write) instead of
  importing with a warning flag. Imported `user_statement` provenance without
  a `source_ref` is downgraded to `import` (one `import.provenance_downgraded`
  event each).
- **Soft delete now clears every retrieval surface (P1).** `soul_forget`
  (soft) left content in the FTS index and the vector store, so it stayed
  findable via full-text and semantic neighbors. The `memories_au` trigger
  (schema v9) now drops the FTS row on a `status→deleted` transition and does
  not re-index deleted rows on later updates; the vector is deleted too.
  Existing soft-deleted rows are purged from the index by the migration.
- **Secret patterns widened (P2).** Added Google API keys (`AIza…`), bearer
  tokens, and 64-hex secrets that appear next to a secret-ish keyword (bare
  hashes are not flagged); `lautet` added to the password pattern.
- **Content size cap (P2).** `capture` rejects content over 16 KB — a memory
  is a fact, not a document — so a single row can no longer bloat the store or
  consume a whole context capsule.
- **Deterministic retrieval ranking (P2).** bm25 is normalized min–max within
  the candidate set instead of by a fixed divisor, and score ties break by
  importance desc then id asc, so ranking is stable across processes.

### Added
- **Golden contract tests** (`test/golden-contracts.test.mjs`, suite 90→97):
  the `user_evidence` → ledger-actor coupling is now pinned per tool for all
  six user-authority tools; the disputed-capsule delivery (flag + both sides
  in `known_conflicts`) and the feedback semantics (unmentioned capsule
  memories are never penalized) each have an end-to-end MCP test. All three
  were test gaps, not behavior bugs.
- **Regression test** `soul_reflect → soul_timeline → passport roundtrip`
  (deferred from the 3.1.0 release gate).
- **Forward-compat: reads PassportEnvelope@3** (SOUL4-DECISIONS §F01) —
  `soul_import` now understands the sectioned 4.0 envelope (per-section SHA-256,
  hashed section list), verifying the list then each known section, importing
  `core` through the unchanged 2.0.0 path; unknown required sections are refused
  fail-closed, unknown optional sections are skipped and reported. The writer
  still exports 2.0.0 (reader-only, so the first fail-closed importer already
  speaks the 4.0 format). Tests in `test/envelope-v3.test.mjs` (suite 98→106).

### Note
- Disputed memories are still delivered in the context capsule with a
  `disputed` flag (not hidden) — this is deliberate (see README, "Disputed
  memories in context"). The caller must see the conflict, not one arbitrary
  side of it.

## 3.1.0 — 2026-07-15

Schema v7, all additive (automatic migration with verified backup).

### Added
- **Fact freshness (stale_fact):** memories accept `volatility` (stable /
  periodic ~180d / volatile ~30d) and `verification_ref`; facts past their
  review window return through the workbench as `stale_fact` assignments —
  `still_valid` renews the window with evidence, `outdated` expires honestly
  (agent-sourced only), user statements always go `needs_user`. Stale facts
  are visibly flagged in every context capsule.
- **Closed usage-feedback loop:** capsules carry a `context_id`; every
  delivered memory is logged in `retrieval_impressions` (rank + signal) — the
  measurement base for retrieval work. New `soul_feedback` tool and
  `soul_reflect.memory_feedback` flip signals to used/unhelpful and feed the
  ranking counters. Unmentioned = unknown, never unhelpful.
- **Closed decision loop:** `soul_deliberate` returns a `deliberation_id`;
  new `soul_commit_deliberation` records verdict, confidence and assumptions
  in the ledger. An uncommitted deliberation is an open thought.
- **Client sessions:** first capsule compile opens a `client_sessions` row
  (client, provider, model id, profile); `soul_reflect` closes it. Runtime
  model names live here, never in durable memories. Predictions reference
  their session and accept `domain` + `decision_id` — per-domain calibration
  becomes computable.
- **Honest metrics:** `confirmed_share` (diluted by reflections) is replaced
  by `user_statement_confirmation_rate`, `inference_review_rate`,
  `high_trust_share`, `reflection_count`, `freshness_due`. Session summaries
  move to their own `session_reflections` table.
- **Multi-process guards:** `busy_timeout=5000`; the in-process vector cache
  invalidates via `PRAGMA data_version` when ANOTHER process writes vectors.
- Calibration note is honest below n=5: "provisional, n=X" instead of silence.

### Fixed (release-gate findings, 13/13 disposed)
- Feedback counts only capsule-delivered memories, exactly once (undelivered
  or repeated ids are reported as `ignored`, never booked).
- `stale_fact` puts the user-authority guard before every action: a model can
  never self-verify a user statement; `still_valid` requires non-whitespace
  `evidence_ref`, otherwise the assignment stays open.
- `soul_confirm` with `user_evidence` on a volatile/periodic fact renews the
  freshness window and re-arms the stale_fact detector (closes the
  `needs_user` loop).
- Passport carries `session_reflections` + `client_sessions`; prediction
  import keeps all v7 fields. `retrieval_impressions` are deliberately
  ephemeral (measurement data, 90-day retention, swept hourly; schema v8 adds
  the created_at index).
- Deliberation double-commit is process-safe (immediate transaction).
- `client_name` (MCP client) and `model_id` (explicit hint) are separate
  dimensions in client_sessions.
- Same-day due facts are counted correctly (ISO-parameter comparison in
  stats and in the starter cockpit).

### Deliberately NOT in this wave
- RRF rank fusion / embedding swap: the measurement base (impressions) ships
  first — rankers change only after a gold set of real queries shows a win
  (measure before swapping).

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
