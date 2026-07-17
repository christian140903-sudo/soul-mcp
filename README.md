# soul-mcp

**A soul for your AI: memory it can trust, thinking that compounds — and work that leaves receipts.**

One MCP server, one SQLite file, local-first. No cloud, no account, no telemetry. Soul is a persistent memory **and runtime layer** for whatever model sits in front of it: it remembers with provenance, hands the model structured thinking work, and — new in 4.0 — books every consequential run with an honest receipt.

```bash
claude mcp add soul -- npx -y soul-mcp
```

**30 seconds to a running soul:** register the server (line above), start a session, and tell the model something worth keeping. It lands in `~/.soul/memories.db` with provenance and a ledger event. `npx soul-mcp status` shows what your soul knows; `npx soul-mcp doctor` checks its health. Everything else below is what happens between those two commands.

---

## The version arc

- **v1 — it remembers.** Persistent memory across sessions.
- **v2 — it can be trusted.** Event ledger, provenance on every fact, conflict detection instead of silent overwrites, a policy engine enforced in code, token-budgeted context capsules with receipts.
- **v3 — it thinks.** Soul cannot reason — but a language model sits in front of it in every session. v3 turns that model into Soul's reasoning engine, and Soul into the model's accumulated self-knowledge: the Denkpartner protocol (guarded think-assignments), prediction calibration, deliberation scaffolds, opt-in local semantic retrieval. Hardened across 3.0.1 / 3.1 / 3.2 by three external audit rounds — provenance guards on all six user-authority tools, fail-closed passport checksums, import screening, real delete semantics (details in the CHANGELOG).
- **v4 — it turns work into verified capability.** The goal (SOUL4-VISION §1): model compute becomes durable, verified, portable capability capital — *"Modell-Compute wird in dauerhaftes, überprüftes, zwischen Modellen portables Fähigkeitskapital umgewandelt."* Every expensive, successful run should leave an asset behind — a receipt, an episode, a skill — not just an answer. 4.0.0 ships the machinery for this: durable runs with honest receipts, an episode ledger, a guarded skill registry, and a preregistered eval protocol. It deliberately does **not** yet claim the capability gains — the preregistered measurements have not run (see "What 4.0.0 does not contain").

## What 4.0 adds, mechanism by mechanism

### 1. `soul_run` — durable runs with honest receipts

One new tool — the only one, by contract. `soul_run` compiles a free-text task deterministically into a `TaskContract@1` and opens a durable run in **context mode**: the server never spawns anything; the model in front of Soul executes the task in the conversation, Soul keeps the books. Run, pending receipt and PENDING episode are created **synchronously, in one transaction** — there is no window in which work happened but nothing was booked.

Honesty classes are the point. A receipt closed by the model's own report (`soul_feedback({run_id, outcome})`) is `self_attested` and *stays* `self_attested` — an `evidence_ref` (test command + exit code, a diff) is carried in the receipt as an auditable reference, but it does **not** upgrade the class. `deterministic_verified` would require a validated `VerifierResult@1`, which 4.0 does not produce — so 4.0 never issues it. Self-attested means self-attested, in the schema, not the fine print.

- **Idempotency:** same `idempotency_key` → the same run, never a duplicate.
- **Lifecycle:** `cancel` closes the pending receipt as cancelled (the episode stays PENDING — no outcome was ever observed); `resume` idempotently re-delivers the capsule under a valid lease; `retry` starts a new attempt with a new fencing token, receipt and episode, capped by `budget.max_attempts`. States: queued / running / succeeded / failed / cancelled, plus expiry via the reaper.
- **Abandonment is booked, not judged:** without feedback the reaper closes the receipt after `SOUL_RECEIPT_TTL_DAYS` (default 7) as `expired_unconfirmed` — missingness, not a verdict.
- **Chaos-tested:** 5 SIGKILL edge cases — kill before the first run, right after the reply, amid a flood of pipelined calls, after feedback close, and during the reaper sweep — each assert database invariants after restart: no orphans, no double close, closed exactly once.

### 2. The episode ledger — decisions with outcomes

Every consequential interaction becomes a bitemporal **(decision, confidence, outcome)** triple: what was recommended, what was accepted, what actually ran, what came of it — a causal chain *recommendation → acceptance → execution → outcome*, recorded with two clocks (when it happened vs. when Soul learned of it, so late outcomes back-fill honestly). Missingness is strictly separated from failure: an expired or unobserved outcome is reported as missing, never imputed as a failure. The contract is `Episode@1` in `design/contracts/`.

In 4.0.0 episodes are emitted at exactly one place — the `soul_run`/receipt boundary. The 22 v3 tools emit none.

> **Where this is heading** — the Cognition strand's goal, stated as a target, not an achievement: *"soul trainiert keine Modelle; es lernt eine auditierbare Entscheidungspolitik darüber, welches Modell mit welchem Kontext und welchem Verfahren wann eingesetzt wird."* (Soul trains no models; it learns an auditable decision policy about which model, with which context and which procedure, is used when.) 4.0.0 builds the data backbone for that policy — episodes with causal chaining. The policy learning itself — competence maps, routing recommendations — comes in C1a+ and will be descriptive before it is ever causal (docs/SOUL4-COGNITION-STRANG.md).

### 3. The skill registry — declarative-only, trust is earned

Skills are **data, never code**: context, workflows, rubrics, verifier instructions — expressed in a positive grammar of typed blocks. Screening is fail-closed: length caps, secret and URL denial, and a monotonicity law — a skill can describe work, it can never grant rights. The lifecycle is a ladder with code guards, **Shadow → Canary → Promoted → Deprecated → Revoked**: every skill starts in shadow (including imported ones), promotion requires an evidence reference, revocation sweeps open runs.

Skill packs are **Ed25519-signed** with trust-on-first-use key pinning — pinning is an explicit user action (`soul-mcp skill pin`), never implicit on import. Downgrade, replay and tampering are refused; one bad manifest refuses the whole pack. Exposure is scarce by design: a context capsule carries at most **3** task-scoped *promoted* skills, deterministically matched; shadow and canary are never exposed, and without a match the capsule stays byte-identical to the pre-skills contract. The registry is managed entirely through the CLI (`soul-mcp skill …`) — deliberately no new MCP tool for it.

### 4. Eval preregistration — the protocol is hashed code

The measurement protocol is not a promise in prose, it is code under a registered hash: `eval/protocol/` (protocol document, machine-readable constants, statistics implementation) — any change is a visible revision that discards the running wave. The confirmatory statistics — paired bootstrap p-values with Holm correction over the comparison family — are wired into a deterministic gate function and were proven **mechanically** end-to-end with a fixture-vs-reference dry run (`eval/pilot/DRY-RUN-REPORT.md`): a pipeline function proof, explicitly *not* a model comparison.

The open baseline set: **20 hermetic tasks** (5 families × 4 — a code-capability ladder from repo recon through failing-test diagnosis, minimal fix with regression test, refactor under tests, to contract review), each with **counterfactual verifiers**: every verifier must fail the untouched fixture and pass the reference solution, so a passing verifier means something. **Model measurements (arms A–E) have not run yet.** The protocol is preregistered precisely so that when they do, the numbers cannot be chosen after the fact.

## What 4.0.0 does *not* contain

Said here, prominently, in the same voice as the features:

- **No worker.** `soul_run` is context mode only — the server never spawns a process, an adapter, or a model. The RunnerAdapter/`soul-worker` design exists on paper as a separate package; it is not built.
- **No recipe registry.** Reasoning recipes (C2a) wait behind their own gate.
- **No competence maps, no routing recommendations.** C1a+ needs real, causally linked episodes first. Soul does not yet tell you which model to use for what — it is building the ledger that could one day justify such advice.
- **No model benchmarks.** The eval infrastructure exists — protocol, tasks, statistics, all preregistered — and the measurements are outstanding. Until they run, Soul makes **no claim** about making any model better at anything.
- **Skill promotion checks evidence structure, not evidence truth.** `skill promote` requires an evidence reference and validates its shape; it cannot verify that the referenced eval actually supports the skill. A dishonest operator can promote a bad skill — the registry makes that auditable, not impossible.
- **`deterministic_verified` is never issued.** Every closed 4.0 receipt is `self_attested` (or `expired_unconfirmed` / cancelled).
- **`soul_status` does not yet report run/skill metrics.** Planned additive extension; existing fields are unchanged.

## The 22 v3 tools are untouched — upgrade safety as a feature

4.0.0 adds exactly one tool and breaks none. All 22 v3 tools keep their contracts, pinned by golden-contract tests over the real MCP path: the six user-authority tools (evidence-coupled ledger actors), the disputed-capsule delivery, the feedback semantics. `docs/API-MATRIX.md` lists 29 documented behavior contracts (V1–V29), each with the test that holds it. `soul_feedback` and `soul_context` are extended additively — calls without the new parameters behave exactly as in v3.1. Passports: the writer still exports format 2.0.0; the sectioned `PassportEnvelope@3` is read fail-closed (unknown required section → refusal). Pre-4.0 passports import unchanged.

Verification method for this claim: 355 tests green via `node --test` across 26 test files (run 2026-07-17; the count includes subtests), among them the golden-contract suite, the 5-case chaos matrix and 15 run-lifecycle cases (retry races, double cancel, expired lease).

## Tools

| Tool | What it does |
|---|---|
| `soul_run` | **New in 4.0.** Durable run in context mode: TaskContract@1, pending `self_attested` receipt + PENDING episode in one transaction; idempotent submit; cancel/resume/retry |
| `soul_context` | Token-budgeted capsule: identity, goals, relevant memories (with reasons + provenance), conflicts, briefing & assignments per model profile — now optionally ≤3 promoted task-scoped skills |
| `soul_remember` / `soul_recall` | Capture pipeline (secret rejection, injection quarantine, dedup, conflict flagging) / hybrid search with score breakdown |
| `soul_workbench` / `soul_resolve` | Think-assignments and their guarded resolution (Denkpartner protocol) |
| `soul_predict` | Register testable claims; feeds the calibration record |
| `soul_deliberate` / `soul_commit_deliberation` | Structured reasoning scaffold + your validated procedures + calibration; committing a verdict closes the loop in the ledger |
| `soul_feedback` | Capsule feedback (used/unhelpful; unmentioned stays unknown) — and, with `run_id` + `outcome`, closes a run's receipt and back-fills its episode |
| `soul_confirm` / `soul_correct` / `soul_forget` / `soul_mark_useful` | Lifecycle — correction is supersession, never silent mutation |
| `soul_identity` / `soul_about_me` / `soul_goal` | Identity facets with confidence & evidence; goals and commitments with overdue tracking |
| `soul_timeline` / `soul_status` / `soul_review_queue` | Bitemporal ledger & time-travel, integrity report, human review queue |
| `soul_export` / `soul_import` | Checksummed Soul Passport — your soul is a file you own; oversized payloads refused before parsing |
| `soul_reflect` | End-of-session reflection (diary, not facts) |

23 tools total. Resources: `soul://identity`, `soul://status`, `soul://goals`, `soul://constitution`, `soul://conflicts`, `soul://timeline`, `soul://workbench`, `soul://calibration`, `soul://memory/{id}` (with live embedding neighbors). The session protocol is served through the MCP `instructions` field — no system-prompt boilerplate needed in your client.

## CLI

```bash
npx soul-mcp init            # create ~/.soul (or migrate v1/v2/v3 with automatic backup)
npx soul-mcp status          # memories, ledger, integrity, semantic layer
npx soul-mcp semantic on     # local semantic retrieval — opt-in download, ~400 MB installed
npx soul-mcp doctor          # health checks
npx soul-mcp backup          # consistent snapshot
npx soul-mcp export          # write a soul passport

# skill registry (new in 4.0 — CLI-only by design)
npx soul-mcp skill list                          # lifecycle, source, publisher
npx soul-mcp skill register manifest.json        # always starts in shadow, screening fail-closed
npx soul-mcp skill promote <name> --evidence <ref>
npx soul-mcp skill revoke <name>                 # terminal, sweeps open runs
npx soul-mcp skill import pack.json              # Ed25519-signed packs only, fail-closed
npx soul-mcp skill pin pack.json                 # explicit TOFU key pinning — never implicit
```

## Data & policy

Everything lives in `~/.soul/memories.db` (SQLite, WAL) — memories, ledger, and now runs, receipts, episodes and the skill registry. Schema migrations are automatic with a verified backup first (`VACUUM INTO` + `integrity_check`); 4.0 migrates v9 → v12 additively.

Policy lives in `~/.soul/constitution.json` and is **enforced in code**: secrets are never stored (only a redacted rejection event remains), injection-looking content is quarantined and never recalled, sensitive categories wait for explicit confirmation, and private-sensitivity memories never enter a compiled context. The same screening runs on `soul_import`; a passport whose checksum does not verify is refused, and imports over the size cap (default 50 MB, `SOUL_MAX_IMPORT_BYTES`) are refused before parsing. Every mutation — capture, confirm, correct, merge, dispute, resolve, forget, import, run, receipt, episode, skill transition — is an append-only ledger event. `soul_timeline` can answer *"what did you believe about X three weeks ago?"*.

### Disputed memories in context

A disputed memory (one that contradicts another and has not been resolved) **is** delivered in the context capsule — with a `disputed: true` flag and, in `known_conflicts`, both sides shown against each other. This is deliberate, not an oversight: hiding a disputed fact would silently pick one arbitrary side of an open conflict, which is exactly the failure Soul exists to prevent. The contract is that the caller sees the conflict and treats neither side as fact.

## Architecture & docs

The kernel is one process, module-per-concern: memory, retrieval, context, ledger, workbench, cognition, runs, skills, transfer, policy — all behind the single MCP server (`src/server.ts`) and the CLI (`src/cli.ts`). The 8 artifact contracts (`TaskContract@1`, `SkillManifest@1`, `ReceiptV1`, `VerifierResult@1`, `CapabilityManifest@1`, `Episode@1`, `AuthorityEnvelope@1`, `SignedPackEnvelope@1`) live in `design/contracts/` with an anti-drift test pinning the runtime copies byte-equal.

- `docs/SOUL4-VISION.md` — why v4 exists, phase plan, honest build state
- `docs/API-MATRIX.md` — the canonical compatibility contract: 23 tools, 29 behavior contracts, schema contracts
- `docs/THREAT-MODEL.md` — the security model: trust boundaries, invariants; a compromised OS is explicitly out of scope
- `docs/SOUL4-COGNITION-STRANG.md` — the decision-policy goal and its staged, gated path
- `eval/protocol/` + `eval/pilot/` — preregistered protocol (hashed) and the mechanical dry-run/pilot reports
- `docs/AUDIT-3.1.0.md`, `docs/RESTORE-PROBE.md` — the audits this codebase grew up against

## Migration

Existing v1/v2/v3 databases migrate automatically on first open, with a verified backup written first. All v2 and v3 tool contracts still work; 4.0 is additive.

MIT · built by [Miguel](https://nextool.app/soul) — an AI, for AIs, under human review.
