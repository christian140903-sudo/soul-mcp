# Soul MCP — Versionierte API-Matrix

- **Stand-Version:** 3.2.0 (`SOUL_VERSION`, `src/kernel/db.ts:19` — bleibt bis zur Phase-2-Akzeptanz auf 3.2.0, PLAN §Betriebsregeln 4). **Baustand:** 4.0-dev — Phase 1A/1B, Phase 2 (Kontextmodus, ohne Worker) und Phase 3 (Skill-Registry) sind gebaut.
- **Datum:** 2026-07-17
- **Zweck:** Grundlage des Kompatibilitätsvertrags für Soul 4.0 (Sol-Gate **F03** öffentliche API, **F08** Kompatibilitätsvertrag / Golden Transcripts). Diese Matrix ist die kanonische Liste dessen, was 4.0 nicht brechen darf.
- **Belegquelle:** Jede Zeile ist aus `src/server.ts` extrahiert (Erst-Extraktion Commit 7c87b77; 4.0-Zeilen nachgeführt auf Stand 976b452). Klassifikation der 4.0-Wirkung nach `docs/SOUL4-VISION.md` §4 (Öffentliche API, Sol F03).

**Bestand:** 23 Tools (22 v3-Tools + `soul_run`, das einzige NEU-in-4.0-Tool per Vertrag) · 8 statische Resources + 1 Template-Resource (= 9) · 3 Prompts · CLI-Subcommand-Oberfläche (Tabelle C).

---

## Tabelle A — Tools (23)

Klassifikation der 4.0-Wirkung: **unverändert** · **additiv-erweitert** (Verhalten bleibt, Felder/Optionen kommen dazu) · **NEU in 4.0** · **deprecated-Kandidat** (echte Redundanz, nur benannt — nicht entschieden).

| Tool | Zweck (1 Satz) | Seit | Kernel-Module | 4.0-Klassifikation |
|------|----------------|------|---------------|--------------------|
| `soul_remember` | Speichert eine Erinnerung durch die Capture-Pipeline (Secret-Reject, Injection-Quarantäne, Dedup, Konflikt-Flag, Provenance-Guard). | v2 | memory (`capture`) | unverändert |
| `soul_recall` | Sucht Erinnerungen mit Score-Breakdown und Provenance; disputed geflaggt, quarantined/deleted nie. | v2 | retrieval (`recall`) | unverändert |
| `soul_context` | Kompiliert eine token-budgetierte Kontext-Kapsel (Identität, Ziele, relevante Memories, Konflikte) mit Ledger-Receipt. | v2 | context (`compileContext`) | **additiv-erweitert (GEBAUT, Phase 3)** — optionale `skills`-Kapselsektion: ≤3 task-scoped Skills, ausschließlich Lifecycle `promoted` (shadow/canary nie exponiert), deterministisches Matching; ohne Match fehlt der Key und die Kapsel bleibt byte-identisch zum Pre-Skills-Vertrag (`src/kernel/context.ts`, `getSkillsForTask`; Golden Tests halten). |
| `soul_workbench` | Liefert deterministisch berechnete Denk-Assignments (Denkpartner-Protokoll) mit exaktem Antwort-Schema. | v3.0 | workbench (`computeAssignments`) | unverändert |
| `soul_resolve` | Beantwortet ein Workbench-Assignment unter Code-Guards (kein Hard-Delete, Supersession, `needs_user`). | v3.0 | workbench (`resolveAssignment`) | unverändert |
| `soul_predict` | Registriert eine falsifizierbare Behauptung mit Wahrscheinlichkeit; fällige kehren via Workbench zurück, speisen Kalibrierung. | v3.0 | cognition (`makePrediction`) | unverändert |
| `soul_commit_deliberation` | Schließt eine `soul_deliberate`-Deliberation mit Verdict, Konfidenz, Annahmen ab. | v3.0 | cognition (`commitDeliberation`) | unverändert |
| `soul_feedback` | Schließt die Retrieval-Feedback-Schleife: welche Kapsel-Memories genutzt / unnütz waren. | v3.1 | memory (`applyMemoryFeedback`), runs (`closeRunWithFeedback`) | **additiv-erweitert (GEBAUT, Phase 2)** — neue optionale Parameter `run_id`, `outcome` (success/failure/mixed, Pflicht wenn `run_id` gesetzt), `evidence_ref`, `summary`; `context_id` ist jetzt optional (mindestens eines von `context_id`/`run_id` nötig). Mit `run_id` schließt es das pending Receipt und füllt das Episode-Outcome bitemporal nach; `evidence_ref` ist auditierbarer Verweis und ändert die `honesty_class` NICHT (bleibt `self_attested`). Calls ohne `run_id` verhalten sich exakt wie v3.1. |
| `soul_deliberate` | Liefert ein strukturiertes Denk-Scaffold plus validierte User-Prozeduren und Kalibrierungs-Record. | v3.0 | cognition (`deliberate`) | unverändert |
| `soul_confirm` | Bestätigt eine candidate/disputed Erinnerung als user-verifiziert (Konfidenz hoch, Status upgrade). | v2 | memory (`confirmMemory`) | unverändert |
| `soul_correct` | Korrigiert eine Erinnerung per Supersession (alt bleibt superseded + verlinkt). | v2 | memory (`correctMemory`) | unverändert |
| `soul_forget` | Vergisst eine Erinnerung; soft (Tombstone) default, `hard=true` löscht die Zeile. `destructiveHint`. | v2 | memory (`forgetMemory`) | unverändert |
| `soul_mark_useful` | Feedback-Loop: nützliche Memories ranken höher, unnütze verlieren Importance. | v2 | memory (`markUseful`) | unverändert |
| `soul_identity` | Setzt/aktualisiert eine Identity-Facette mit Konfidenz, Evidence-Count, Status. | v2 | identity (`setIdentityFacet`) | unverändert |
| `soul_about_me` | Alles über den User: Facetten, aktive Ziele, Präferenzen, offene Konflikte — Inferenzen als solche gelabelt. | v2 | identity, goals, retrieval, stats, memory | unverändert |
| `soul_goal` | Verwaltet Ziele und Commitments (create/update/complete/list, inkl. überfällige Commitments). | v2 | goals (`createGoal`/`updateGoal`/`listGoals`/`overdueCommitments`) | unverändert |
| `soul_timeline` | Fragt das Event-Ledger ab; mit `as_of` kognitive Zeitreise (welche Memories waren aktiv). | v2 | ledger (`queryEvents`/`memoriesAsOf`) | unverändert |
| `soul_reflect` | Session-Reflexion: Summary → `session_reflections` (Diary), nur echte Learnings werden Memories; zählt Session hoch. | v2 (Diary-Split v3.1) | ledger, memory, identity, stats, context | unverändert |
| `soul_status` | Health-Dashboard: Memory-Counts, Event-Count, Integritäts-Report. | v2 | stats (`getStats`) | **additiv-erweitert** — Vision §4: soll zusätzlich Run-/Skill-/Verifier-Kennzahlen (Break-even, Lernkurve) ausweisen. Bestehende Felder bleiben. |
| `soul_review_queue` | Memory-Inbox: Candidates, quarantined, disputed pairs zur Auflösung. | v3.0 | memory (`listMemories`/`listDisputedPairs`) | unverändert |
| `soul_export` | Exportiert alles als checksummiertes soul-passport JSON (`restore(export(soul)) == soul`). | v2 | transfer (`exportAll`) | **additiv-erweitert** — Vision §3/§4: Passport soll zusätzlich portable Skills / Receipts / lokale Evals / private Artefakte tragen (additiv, siehe Schema-Verträge). |
| `soul_import` | Importiert ein v2-Passport oder Legacy-v1; idempotent, Checksum-Mismatch verweigert, Live-Screening. | v2 | transfer (`importAll`/`importV1Export`) | **additiv-erweitert** — muss die additiven 4.0-Passport-Sektionen tolerant lesen; v2/v1-Pfade unverändert. |
| `soul_run` | Kompiliert Freitext deterministisch in einen TaskContract@1 und öffnet einen durablen Run im **Kontextmodus** (der Server spawnt nie — das Host-Modell führt im Gespräch aus). | **4.0 (GEBAUT, Phase 2)** | runs (`startContextRun`/`cancelRun`/`resumeRun`/`retryRun`/`reapExpired`) | **NEU in 4.0** — das einzige neue Tool per Vertrag (Vision §4). Aktionen: `submit` (default) · `cancel` · `resume` · `retry` (letzte drei mit Pflicht-`run_id`). Zustände: queued/running/succeeded/failed/cancelled (+ expired via Reaper). **Kontextmodus-Receipt-Vertrag (r2-F09):** Run, pending Receipt (`self_attested`) und PENDING-Episode entstehen SYNCHRON in einer Transaktion; Abschluss via `soul_feedback({run_id, outcome})`; ohne Feedback schließt der Reaper nach `SOUL_RECEIPT_TTL_DAYS` (Default 7) als `expired_unconfirmed` — Missingness, kein Verdikt. `deterministic_verified` wird in 4.0 NICHT vergeben (bräuchte validiertes VerifierResult@1). **Idempotenz:** gleicher `idempotency_key` → derselbe Run, nie ein Duplikat. Retry = neuer Attempt mit neuem Fencing-Token/Receipt/Episode, respektiert `budget.max_attempts`; Cancel schließt das Receipt als cancelled und die Episode terminal als `cancelled_unobserved` (Missingness, kein Urteil — V27). |

**Fußtext zu Tabelle A:**
- `soul_run` ist seit Phase 2 (Kontextmodus, Wellen A+B) **registriert und getestet** (`test/run-lifecycle.test.mjs`, `test/runs.test.mjs`, `test/chaos.test.mjs`). Der Worker-Modus (RunnerAdapter, separates Paket `soul-worker`) ist weiterhin **NICHT gebaut** — der Server spawnt nie; `soul_run` liefert ausschließlich den Kontextmodus.
- `soul_review` aus dem alten Ideen-Dump ist in v3.2 **nie existiert** und laut Vision §4 gestrichen (Workbench/Resolve/Review-Queue decken es ab). Kein Deprecation nötig — es gibt nichts zu deprecaten.
- **Deprecated-Kandidaten (nur benannt, nicht entschieden):** Ich finde im Code **keine echte Redundanz** unter den 22 v3-Tools. Grenzfall zur Prüfung: `soul_mark_useful` überschneidet sich funktional mit dem `unhelpful_ids`/`used_ids`-Pfad von `soul_feedback` (beide schreiben Usage-/Importance-Signal). `soul_feedback` ist kapsel-gebunden (`context_id`), `soul_mark_useful` ist ID-direkt — kein Duplikat, aber der einzige Kandidat, falls 4.0 das Feedback-Modell konsolidiert. Entscheidung offen.

---

## Tabelle B — Resources und Prompts

### Resources (8 statisch + 1 Template)

| Resource | URI | Zweck (1 Satz) | Seit | Kernel-Modul | 4.0-Klassifikation |
|----------|-----|----------------|------|--------------|--------------------|
| `identity` | `soul://identity` | Identity-Facetten mit Konfidenz und Status. | v2 | identity | unverändert |
| `status` | `soul://status` | Soul-Health und Knowledge-Integrity. | v2 | stats | additiv-erweitert (analog `soul_status`) |
| `goals` | `soul://goals` | Aktive Ziele und überfällige Commitments. | v2 | goals | unverändert |
| `constitution` | `soul://constitution` | Die aktive Constitution (Policy-Regeln). | v2 | policy | unverändert |
| `conflicts` | `soul://conflicts` | Ungelöste disputed Memory-Paare. | v2 | memory | unverändert |
| `timeline` | `soul://timeline` | Die 50 jüngsten Ledger-Events. | v2 | ledger | unverändert |
| `workbench` | `soul://workbench` | Offene Denk-Assignments (Denkpartner-Protokoll). | v3.0 | workbench | unverändert |
| `calibration` | `soul://calibration` | Prediction-Kalibrierungs-Record + offene Predictions. | v3.0 | cognition | unverändert |
| `memory` (Template) | `soul://memory/{id}` | Eine einzelne Erinnerung mit voller Provenance + Nachbarn + History. | v2 | memory, semantic, ledger | unverändert |

### Prompts (3)

| Prompt | Zweck (1 Satz) | Seit | 4.0-Klassifikation |
|--------|----------------|------|--------------------|
| `soul-session-start` | Session mit Kontinuität starten: `soul_context` + überfällige Commitments. | v2 | unverändert |
| `soul-daily-review` | Review von Candidates, Konflikten, überfälligen Commitments. | v3.0 | unverändert |
| `soul-session-end` | Vor Session-Ende reflektieren und konsolidieren (`soul_reflect`). | v2 | unverändert |

**Fußtext zu Tabelle B:** Kein neuer Resource/Prompt in der Vision spezifiziert. `soul://run/{id}` (Run-State) wäre ein plausibler additiver Phase-2-Resource, ist aber nicht spezifiziert — daher hier nicht als geplant geführt.

---

## Tabelle C — CLI-Oberfläche (`soul-mcp <subcommand>`)

Die CLI (`src/cli.ts`) ist **nicht** Teil des MCP-Tool-Vertrags (keine Wirkung auf die 23-Tool-Zählung), aber öffentliche Oberfläche. Bestand v3: `init` · `status` · `doctor` · `backup` · `restore` · `export` · `import` · `semantic` · `config`. **NEU in 4.0 (GEBAUT, Phase 3)** — analog zum bestehenden `semantic`-Subcommand-Muster:

| Subcommand | Zweck (1 Satz) | Kernel-Modul |
|------------|----------------|--------------|
| `skill list` | Skill-Registry anzeigen (Lifecycle, Source, Publisher). | skills (`listSkills`) |
| `skill register <manifest.json>` | Registriert ein SkillManifest@1 — startet IMMER in `shadow` (TB5.4), Screening fail-closed. | skills (`registerSkill`) |
| `skill transition <name> <to> [--version X] [--evidence <ref>] [--reason <text>]` | Lifecycle-Übergänge (shadow→canary→promoted→deprecated→revoked); Promote nur mit `--evidence`. | skills (`transitionSkill`) |
| `skill promote <name> --evidence <ref>` | Kurzform für transition auf `promoted`. | skills |
| `skill revoke <name>` | Terminal revozieren (inkl. Rollback-Sweep offener Runs). | skills |
| `skill import <pack.json>` | Signiertes Skill-Pack importieren — fail-closed (Signatur, Pin, Downgrade-Schutz); Pack-Skills starten in `shadow`. | skills (`importPack`) |
| `skill pin <pack.json> [--label <text>]` | Publisher-Key explizit pinnen (TOFU ist eine bewusste User-Aktion, nie implizit beim Import). | skills (`pinTrustedKey`) |

Skill-Registrierung/Lifecycle/Pack-Import laufen ausschließlich über die CLI — **kein neues MCP-Tool** dafür (Vertragstreue zu Vision §4: `soul_run` bleibt das einzige neue Tool).

---

## Verhaltensverträge

Öffentlich zugesicherte Verhalten (aus Tool-Descriptions in `src/server.ts` + Server-`instructions` + README.md). Diese darf 4.0 **nicht** brechen. Spalte „Getestet": Testdatei + belegende Assertion, sonst **UNGETESTET**.

| # | Vertrag | Quelle | Getestet |
|---|---------|--------|----------|
| V1 | `restore(export(soul)) == soul` — Export/Import ist ein treuer Round-Trip. | `soul_export` desc; README:107 | `test/transfer.test.mjs` (round-trip Test); `test/server.test.mjs` |
| V2 | Re-Import desselben Passports ist idempotent (ändert nichts). | `soul_import` desc; README | `test/transfer.test.mjs:106` (`imported: 0`); `test/v31-features.test.mjs:107` |
| V3 | Checksum-Mismatch **verweigert** den Import (Verhaltensänderung 3.1.1). | `soul_import` desc; README:20 | `test/transfer.test.mjs:151` (`throws /checksum does not verify/`) |
| V4 | Pre-3.0.1-Passport (ohne decisions/predictions) verifiziert weiterhin seine Checksum. | transfer-Logik | `test/transfer.test.mjs:137` |
| V5 | Secrets werden nie gespeichert, nur ein Redacted-Reject-Event bleibt. | `soul_remember` desc; README:125 | `test/pipeline.test.mjs` ('secrets are rejected and never stored') |
| V6 | Injection-artiger Inhalt wird quarantined und **nie** recalled. | `soul_recall` desc; README:125 | `test/pipeline.test.mjs:42`; `test/retrieval-context.test.mjs:27` |
| V7 | Import screent Live-Memories identisch: Secrets gedroppt, Injection quarantined. | `soul_import` desc; README:20 | `test/v311-fixes.test.mjs:60,76` |
| V8 | Superseded/History-Rows werden beim Import **nicht** gescreent (Tombstone bleibt). | 3.1.1-Fix | `test/v311-fixes.test.mjs:93` |
| V9 | `user_statement`-Provenance nur mit `source_ref`; sonst Downgrade auf `agent_inference`. | `soul_remember` desc; README:18 | `test/provenance-guards.test.mjs:56`; `test/v311-fixes.test.mjs:111` (Import-Pfad) |
| V10 | User-Autorität (Actor `user` + `user_statement`) nur mit `user_evidence` — über **alle sechs** User-Autoritäts-Tools (remember/confirm/correct/forget/identity/goal). | Tool-descs; README:18 | `test/provenance-guards.test.mjs` (remember) + `test/golden-contracts.test.mjs` (confirm/correct/forget/identity/goal, je mit/ohne `user_evidence`) |
| V11 | Korrektur ist Supersession, nie stille Mutation (alt → `superseded`, verlinkt). | `soul_correct` desc; README:104 | `test/pipeline.test.mjs:73` |
| V12 | Widersprechende Präferenzen werden `disputed` geflaggt, nicht überschrieben. | `soul_remember` desc; README:127 | `test/pipeline.test.mjs:62` |
| V13 | Disputed-Memory wird geflaggt geliefert und nie als Fakt behandelt (auch in der Kapsel, absichtlich sichtbar). | `soul_recall`/`soul_context` desc; README:127 | `test/retrieval-context.test.mjs:34` (recall flagged) + `test/golden-contracts.test.mjs` (Kapsel: disputed:true + beide Seiten in known_conflicts) |
| V14 | Private-Sensitivity-Memories betreten **nie** eine kompilierte Kontext-Kapsel. | `soul_context` desc; README:125 | `test/retrieval-context.test.mjs:68` |
| V15 | Kontext-Kapsel respektiert das Token-Budget und schreibt einen Ledger-Receipt. | `soul_context` desc | `test/retrieval-context.test.mjs:52,80` |
| V16 | Ein Modell-Verdict löscht nie hart; stärkster Effekt ist Supersession. | `soul_resolve` desc; README:28 | `test/workbench-decisions.test.mjs`; `test/workbench.test.mjs` |
| V17 | Ein User-Statement wird nie durch ein Modell-Verdict allein überstimmt (`outcome: needs_user`). | `soul_resolve` desc; README:29 | `test/workbench-decisions.test.mjs`; `test/v31-features.test.mjs`; `test/workbench.test.mjs` |
| V18 | Terminale Workbench-Verdicts werden nie erneut gefragt (persistieren in `workbench_decisions`). | README:18 | `test/workbench-decisions.test.mjs` |
| V19 | Session-Summary landet als Diary in `session_reflections` (kein Fakt, verdünnt Integrität nicht); nur echte Learnings werden Memories. | `soul_reflect` desc; README | `test/v31-features.test.mjs:211` |
| V20 | `session.reflected`-Event bleibt auf der Timeline sichtbar und überlebt Export/Import-Round-Trip. | 3.1.0-Fix (Commit 7c87b77) | `test/server.test.mjs:259` |
| V21 | `soul_feedback`: unerwähnte Memories bleiben unbekannt, werden **nicht** als unhelpful markiert. | `soul_feedback` desc | `test/golden-contracts.test.mjs` (unerwähnte Kapsel-IDs bleiben included, kein unhelpful, kein Malus) |
| V22 | Semantisch ähnliche Präferenzen ohne Wort-Overlap werden zu Dispute, nicht zu Merge. | README:85 | `test/workbench-semantic.test.mjs` |
| V23 | Soft-Forget hält Tombstone, entfernt aber aus FTS-Index UND Vector-Store; Hard-Forget löscht die Zeile. | `soul_forget` desc; README:20 | `test/semantic.test.mjs:83` (soft-deleted nie recalled); `test/pipeline.test.mjs` (Tombstone vs Row) |
| V24 | Deterministisches Retrieval-Tie-Breaking (gleiche Query → stabile Reihenfolge). | README:20 | `test/v311-fixes.test.mjs:178` (Score-Tie → importance desc, dann id asc) |
| V25 | `soul_run` submit erzeugt Run + pending Receipt (`self_attested`) + PENDING-Episode **synchron in einer Transaktion**; gleicher `idempotency_key` → derselbe Run, nie ein Duplikat. | `soul_run` desc | `test/runs.test.mjs` (synchron + schema-valid; Idempotenz-Test); `test/run-lifecycle.test.mjs` (e2e golden guard: submit ohne action = Welle-A-Kapselform) |
| V26 | Run-Abschluss nur über `soul_feedback({run_id, outcome})`; `evidence_ref` ändert die `honesty_class` NICHT (bleibt `self_attested`); ausbleibendes Feedback → Reaper schließt nach TTL als `expired_unconfirmed` (Missingness, kein Verdikt). | `soul_run`/`soul_feedback` desc | `test/runs.test.mjs` (bitemporaler Back-fill; evidence_ref-F02-Test; Reaper-TTL-Test); `test/chaos.test.mjs` (chaos d/e: Close überlebt SIGKILL, genau einmal) |
| V27 | Lifecycle-Aktionen: `cancel` schließt Receipt als cancelled, Episode terminal `cancelled_unobserved`; `resume` liefert idempotent dieselbe Kapsel bei gültiger Lease; `retry` = neuer Attempt (neues Fencing-Token/Receipt/Episode), respektiert `budget.max_attempts`, CAS lässt genau EINEN Gewinner zu; unbekannte/unpassende Zustände sind ehrliche Fehler. | `soul_run` desc | `test/run-lifecycle.test.mjs` (15 Fälle inkl. Retry-Race F03, double-cancel, expired-lease); `test/runs.test.mjs` (v12-Unique-Indizes) |
| V28 | Kapsel-Skills: nur `promoted`, ≤3, deterministisch task-gematcht; ohne Match KEIN `skills`-Key (byte-identische Pre-Skills-Kapsel); shadow/canary sind nie sichtbar. | `soul_context`-Kapselvertrag (Phase 3) | `test/skills.test.mjs` (`getSkillsForTask` + beide Kapsel-e2e-Tests) |
| V29 | Skill-Registrierung fail-closed: Positiv-Grammatik (F07), Monotonie-Gesetz (kein grant), Längenlimits, Secret-/URL-Deny, lifecycle-Claims normalisiert auf shadow; Pack-Import nur signiert + gepinnt (TOFU), Downgrade/Replay/Tampering refused, ein schlechtes Manifest refused das GANZE Pack. | CLI/`skills.ts`-Vertrag; SIGNED-PACK-TRUST | `test/skills.test.mjs` (Register-/Lifecycle-/Pack-Negativtests); `test/signed-pack.test.mjs` (Envelope-Schema) |

### UNGETESTET-Verträge — Stand nach Golden-Transcript-Runde: LEER

Alle drei Lücken sind seit 2026-07-16 durch `test/golden-contracts.test.mjs`
geschlossen (Tests über den echten MCP-Pfad in test/golden-contracts.test.mjs;
Gesamtsuite am r3-Freeze-Stand: 107 — aktuelle Zahl siehe Schema-Verträge unten):

- **V10 ✓** — alle sechs User-Autoritäts-Tools je mit/ohne `user_evidence`
  getestet (Ledger-Actor `user` nur mit Beleg; Aktion greift auch ohne, ehrlich
  als `agent` gebucht). Befund: Verträge halten, reine Testlücke.
- **V13 ✓** — disputed-Memory erscheint in der Kapsel mit `disputed: true`,
  Konflikt beidseitig in `known_conflicts` mit do-not-treat-as-fact-Note.
- **V21 ✓** — `soul_feedback` erhöht nur bei genannten IDs; unerwähnte
  Kapsel-Memories bleiben `included` ohne Malus.

*(Korrektur beim Review: V24 — Tie-Break-Determinismus — war hier ursprünglich
als ungetestet gelistet; tatsächlich deckt `test/v311-fixes.test.mjs:178` ihn ab.)*

---

## Schema-Verträge

| Vertrag | Wert | Quelle |
|---------|------|--------|
| DB-Schema-Version | `SCHEMA_VERSION = 12` (v10: runs/receipts/episodes · v11: skills/trusted_keys/pack_versions · v12: Unique-Indizes je (run, attempt) — alle additiv, unter Backup-Vertrag) | `src/kernel/db.ts:18` |
| Soul-Version (Server-Name/Version) | `SOUL_VERSION = '3.2.0'` (npm-Bump auf 4.0.0-beta erst nach Phase-2-Akzeptanz) | `src/kernel/db.ts:19` |
| Passport-Format | `format: 'soul-passport'` | `src/kernel/transfer.ts:25,98` |
| Passport-Version | `version: '2.0.0'` (Writer unverändert; Envelope-Writer noch nicht gebaut) | `src/kernel/transfer.ts:26,99` |
| Artefakt-Schemas (design/contracts/, 1A) | 8 Schemas: `TaskContract@1` · `SkillManifest@1` · `ReceiptV1` · `VerifierResult@1` · `CapabilityManifest@1` · `Episode@1` · `AuthorityEnvelope@1` · `SignedPackEnvelope@1` — Runtime-Kopien byte-gleich zum Vertrag (Anti-Drift-Test in `test/skills.test.mjs`) | `design/contracts/*.schema.json` |
| Testsuite | 349 Tests grün via `node --test` über 24 Testdateien (ohne `test/eval-pilot.test.mjs`, parallel in Arbeit; Zähler inkl. Subtests) — Stand 2026-07-17. Historische Zählung „107" bezog sich auf den r3-Freeze-Stand. | `npm test` |

### Was ein 4.0-Passport additiv ergänzen darf, ohne 2.0.0 zu brechen

Der Passport-Kompatibilitätsvertrag ist seit dem Freeze-Gate der **Sectioned
Envelope** (PassportEnvelope@3, SOUL4-DECISIONS §F01) — der frühere
"SemVer-additiv innerhalb 2.x"-Ansatz ist verworfen (r1-Befund F01: eine
Monolith-Checksum kann Integrität und Kompatibilitätssignal nicht gleichzeitig
tragen, fail-closed hätte jede Addition refused).

1. **Envelope 3.0.0:** Header trägt eine sortierte Sektionsliste
   `{name, version, hash, required}`; die Top-Level-Checksum hasht NUR diese
   Liste; jede Sektion hat einen eigenen SHA-256 über kanonisches JSON.
2. **Sektionen sind (name, version)-Tupel:** Der 3.2.0-Reader kennt genau
   `core@2.0.0`. Ein bekannter Name mit unbekannter Version ist eine
   unbekannte Sektion (core@X.Y → Refusal, weil required). Getestet in
   `test/envelope-v3.test.mjs`.
3. **Unbekannt + required → Refusal; unbekannt + optional → Skip** mit
   `skipped_sections`-Ausweis und Ledger-Event; der Hash der übersprungenen
   Sektion steht in der verifizierten Liste (Manipulation bleibt für einen
   4.0-Reader beweisbar).
4. **Writer:** 3.2.0 exportiert weiterhin 2.0.0 (Golden Test pinnt das);
   der Envelope-Writer kommt mit 4.0 und exportiert per Default weiter
   2.0.0-kompatibel; Extensions (skills, receipts, …) nur auf Wunsch.
5. **Schema-Version 9 → 10+ nur mit Migration + Backup** (unverändert:
   `VACUUM INTO` + `integrity_check`, `test/migration*.test.mjs`). *Baustand:
   v10/v11/v12 sind unter genau diesem Vertrag geschehen — additiv, mit
   Pre-Migration-Snapshot; getestet u.a. in `test/runs.test.mjs` (v9→current
   auf realer DB-Kopie) und `test/skills.test.mjs` (v11/v12-Inhalte).*

---

*API-Matrix v2 · Bestand Soul 3.2.0 + 4.0-dev-Baustand (Phasen 1A/1B/2-Kontextmodus/3 gebaut, Stand 976b452 + Folgearbeit) · Phase-0-Deliverable Sol F03/F08, nachgeführt 2026-07-17 · alle Zeilen aus `src/server.ts`/`src/cli.ts` + Test-Suite belegt.*
