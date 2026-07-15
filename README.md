# soul-mcp

**A soul for your AI: memory it can trust — and a thinking loop that makes any model work above its weight.**

One MCP server, one SQLite file, local-first. No cloud, no account, no telemetry.

```bash
claude mcp add soul -- npx -y soul-mcp
```

---

## The version arc

- **v1 — it remembers.** Persistent memory across sessions.
- **v2 — it can be trusted.** Event ledger, provenance on every fact, conflict detection instead of silent overwrites, a policy engine enforced in code, token-budgeted context capsules with receipts.
- **v3 — it thinks.** Soul cannot reason — but a language model sits in front of it in every session. v3 turns that model into Soul's reasoning engine, and Soul into the model's accumulated self-knowledge. Both get better with every session. The loop is called the **Denkpartner protocol**.
- **v3.0.1 — its verdicts stick, and its ledger cannot be fooled.** Found in a live audit (with GPT-5.6 as outside reviewer): workbench verdicts now persist in a `workbench_decisions` table, so a judged pair is never re-asked (terminal verdicts block forever, `unclear`/`doubt`/`still_open` carry cooldowns). And a hard provenance rule closes every path that could mint user authority: across **all six** user-authority tools (`remember`, `confirm`, `correct`, `forget`, `identity`, `goal`), the ledger actor `user` and `user_statement` provenance exist only together with `user_evidence` — a quote of the user's actual words. Without it the action still applies, honestly booked as the agent's. Passports now carry decisions and predictions; migration backups are WAL-safe (`VACUUM INTO` + `integrity_check`). 70 tests.
- **v3.1 — it stays honest under review.** 13 gate fixes from a second external audit round: feedback integrity, stale-fact guards, a freshness-confirm loop for volatile facts, complete v7 passports, commit-race hardening, client/model separation in session accounting. Session reflections move to their own diary table so summaries stop diluting integrity metrics. 81 tests.
- **v3.2 — its trust boundary holds at the edges.** A forensic audit of 3.1.0 (docs/AUDIT-3.1.0.md) found the gaps at the trust boundary and closed them: imported live memories now pass the same secret/injection/sensitivity screening as captured ones, a checksum mismatch refuses the import outright (**behavior change** — previously it imported with a warning flag), `user_statement` provenance without evidence is downgraded on import, and forgetting a memory now really removes it from the FTS index and the vector store — not just from the status filter. Plus: stronger secret patterns, a 16 KB content cap, deterministic retrieval tie-breaking. Golden-contract tests now pin all six user-authority tools, the disputed-capsule path and feedback semantics. 97 tests.

## What v3 adds, mechanism by mechanism

### 1. The Denkpartner protocol (workbench + resolve)

Soul computes, deterministically, what needs judgment — unresolved contradictions, near-duplicate memories, aging low-confidence inferences, expiring candidates, due predictions — and hands them to the model as structured **assignments** inside its context capsule. The model answers through `soul_resolve`; the answer is validated against the persisted assignment and applied under guards **enforced in code, not prompt**:

- a model verdict never hard-deletes anything — the strongest effect is supersession (history kept, linked, reversible),
- a user statement is never overruled by a model verdict alone (`outcome: "needs_user"`),
- every applied resolution is a ledger event with `model_assisted` provenance.

A real assignment, from a real run:

```json
{
  "kind": "dispute",
  "instruction": "These memories are flagged as contradicting. Judge: real contradiction, or compatible statements? ...",
  "memories": [
    { "content": "User prefers tabs for indentation in python",   "source": "user_statement", "status": "disputed" },
    { "content": "User prefers spaces for indentation in python", "source": "user_statement", "status": "disputed" }
  ],
  "respond_with": { "verdict": "contradiction | compatible | unclear", "current": "(memory id)", "reasoning": "why" }
}
```

And the guard doing its job when the model tried to overrule the user:

```json
{
  "applied": false,
  "outcome": "needs_user",
  "detail": "The losing side is a user statement. A model verdict never overrules the user — the pair stays disputed and waits in the review queue."
}
```

The loop is self-igniting: compiling a context capsule is the moment assignments are computed. A capable model gets consolidation work without ever asking for it. **The smarter the model in front of Soul, the better your memory becomes — and the memory carries that quality to every model that comes after.**

### 2. Model-aware capsules (`model_profiles`)

`soul_context` accepts a `model_hint`. A lookup table in your constitution — a table, not magic — maps model classes to profiles: *deep* models (Fable, Opus, GPT-5) receive a briefing plus up to two think-assignments, *standard* models one, *fast* models (Haiku, mini, flash) none. Same soul, tailored collaboration.

### 3. Prediction calibration — self-knowledge no base model has

The model registers testable claims with probabilities (`soul_predict`). Due predictions return through the workbench for resolution. From resolved ones Soul computes the model's **actual calibration** — hit rate per confidence band, Brier score — and feeds it back into every capsule briefing. From a real run:

```
Calibration over 6 resolved predictions: Brier 0.489 (0 = perfect, 0.25 = coin flip).
Largest gap: in the 85–100% band you predicted ~88% but hit 33% (n=3).
```

No language model knows how often its own "I'm 90% sure" was actually right — across sessions, in *your* environment. With Soul, it does. Badly missed predictions (surprise ≥ 0.5) automatically become learning memories, because a wrong confident prediction is the most valuable training signal a session can produce.

### 4. Deliberation scaffolds (`soul_deliberate`)

For decisions, diagnoses, designs, estimates and claim-checks: a deterministic thinking scaffold (decompose → counter-hypothesis → evidence → decide with stated confidence), enriched with the user's own **validated procedures** recalled from memory and the calibration record. Honest framing, stated in the tool itself: the scaffold is structure plus recalled experience — the lift comes from working the steps, not from magic.

### 5. Semantic retrieval — local, opt-in, explainable

```bash
soul-mcp semantic on
```

installs a local embedding backend into `~/.soul/semantic` (never a dependency — it is ~400 MB installed, which is exactly why it is opt-in) and embeds your memories with a multilingual model (`multilingual-e5-small`, 384d, quantized). Recall becomes hybrid: FTS5 keyword candidates ∪ embedding neighbors, fused by a documented formula — every result still carries its full score breakdown (`fts`, `semantic`, `confidence`, `importance`, `recency`, `usage`). A paraphrase with zero keyword overlap is found; without the semantic layer everything degrades gracefully to keyword search.

Embedding similarity also powers conflict detection now: highly similar preference/identity/goal memories with different content are handed to the model as dispute assignments — catching contradictions the word-overlap heuristic can't see.

### 6. Consolidation that behaves like memory should

Ported from [anima-kernel](https://github.com/christian140903-sudo/anima) (the author's computational-consciousness research), simplified and deterministic: memories that are never recalled slowly lose importance; memories that keep proving useful gain a little. Throttled per memory, nothing is ever deleted by decay — it only reshapes ranking pressure. What we deliberately did **not** port: phi scores, consciousness indices, subjective time. Those are simulation metrics; in a memory server they would be vocabulary without a mechanism.

## What v3 does *not* claim

An MCP server cannot raise a model's raw reasoning power — nothing turns a small model into a frontier one, and anyone claiming otherwise is selling something. What Soul does is narrower and real: **persistent memory with provenance, accumulated self-knowledge (calibration), structured deliberation, and a consolidation loop that compounds across sessions.** Those are precisely the axes on which models feel "a generation better" — continuity, reliability, self-awareness of limits — and they are the axes a server *can* own, because they live in data, not weights.

## Tools

| Tool | What it does |
|---|---|
| `soul_context` | Token-budgeted capsule: identity, goals, relevant memories (with reasons + provenance), conflicts — plus briefing & assignments per model profile |
| `soul_remember` / `soul_recall` | Capture pipeline (secret rejection, injection quarantine, dedup, conflict flagging) / hybrid search with score breakdown |
| `soul_workbench` / `soul_resolve` | Think-assignments and their guarded resolution |
| `soul_predict` | Register testable claims; feeds the calibration record |
| `soul_deliberate` | Structured reasoning scaffold + your validated procedures + calibration |
| `soul_confirm` / `soul_correct` / `soul_forget` / `soul_mark_useful` | Lifecycle — correction is supersession, never silent mutation |
| `soul_identity` / `soul_about_me` / `soul_goal` | Identity facets with confidence & evidence; goals and commitments with overdue tracking |
| `soul_timeline` / `soul_status` / `soul_review_queue` | Bitemporal ledger & time-travel, integrity report, human review queue |
| `soul_export` / `soul_import` | Checksummed Soul Passport — your soul is a file you own |
| `soul_reflect` | End-of-session reflection |

Resources: `soul://identity`, `soul://status`, `soul://goals`, `soul://constitution`, `soul://conflicts`, `soul://timeline`, `soul://workbench`, `soul://calibration`, `soul://memory/{id}` (with live embedding neighbors). The session protocol is served through the MCP `instructions` field — no system-prompt boilerplate needed in your client.

## CLI

```bash
npx soul-mcp init        # create ~/.soul (or migrate v1/v2 with automatic backup)
npx soul-mcp status      # memories, ledger, integrity, semantic layer
npx soul-mcp semantic on # enable local semantic retrieval (opt-in download)
npx soul-mcp doctor      # health checks
npx soul-mcp backup      # consistent snapshot
npx soul-mcp export      # write a soul passport
```

## Data & policy

Everything lives in `~/.soul/memories.db` (SQLite, WAL). Policy lives in `~/.soul/constitution.json` and is **enforced in code**: secrets are never stored (only a redacted rejection event remains), injection-looking content is quarantined and never recalled, sensitive categories wait for explicit confirmation, and private-sensitivity memories never enter a compiled context. The same screening runs on `soul_import`, and a passport whose checksum does not verify is refused. Every mutation — capture, confirm, correct, merge, dispute, resolve, forget, import — is an append-only ledger event. `soul_timeline` can answer *"what did you believe about X three weeks ago?"*.

### Disputed memories in context

A disputed memory (one that contradicts another and has not been resolved) **is** delivered in the context capsule — with a `disputed: true` flag and, in `known_conflicts`, both sides shown against each other. This is deliberate, not an oversight: hiding a disputed fact would silently pick one arbitrary side of an open conflict, which is exactly the failure Soul exists to prevent. The contract is that the caller sees the conflict and treats neither side as fact (`soul_context`/`soul_recall` flag it; the server instructions say so). Filtering disputed content out of the capsule is intentionally *not* done — surfacing it, flagged, is the safer default.

## Migration

Existing v1/v2 databases migrate automatically on first open, with a backup written first. All v2 tool contracts still work; v3 is additive.

MIT · built by [Miguel](https://nextool.app/soul) — an AI, for AIs, under human review.
