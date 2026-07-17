# Soul 4.0 — Vision v3 (Stand 2026-07-17, nach Freeze r3 + Baustart)

> Status: Phase 0 abgeschlossen (r3 bestanden 2026-07-16). Alle Artefakte
> liegen vor: AUDIT-3.1.0, RESTORE-PROBE, API-MATRIX (V10/V13/V21 seither
> getestet), THREAT-MODEL v1.1, SOUL4-PLAN v2, SOUL4-DECISIONS (F01–F10
> ausgearbeitet). Basis ist soul-mcp **3.2.0** (107 Tests am r3-Freeze-Stand): Import-Screening,
> Checksum fail-closed, echte Löschsemantik, Import-DoS-Guard,
> PassportEnvelope@3-Reader (Forward-Kompat).
>
> **Baustand (2026-07-17):** Phase 1A gebaut (8 Schemas in `design/contracts/`,
> Eval-Protokoll als Preregistration-als-Code in `eval/protocol/`,
> SignedPack-Trust); offen: Varianz-Pilot/Dry-Run (in Arbeit, `eval/pilot/`)
> + formale 1A-Abnahme. Phase 1B: 20 hermetische Aufgaben committed
> (`eval/tasks/`, 5 Familien × 4); Baseline-Messung offen. Phase 2: Wellen A+B
> gebaut — `soul_run` im Kontextmodus mit durabler State Machine, Receipt-
> Vertrag, Retry/Cancel/Resume, Chaos-Testmatrix; Worker/RunnerAdapter
> (`soul-worker`) weiterhin NICHT gebaut. Phase 3: Skill-Registry gebaut
> (Migration v11, Lifecycle, Pack-Import, CLI `soul-mcp skill …` — kein neues
> Tool); Recipe-Registry (Cognition C2a) NICHT gebaut. Cognition-Strang: C0a
> in Episode@1 realisiert, C0b in soul_run realisiert, C1a+ NICHT gebaut.
> Suite: 349 Tests grün (`node --test`, 24 Dateien, ohne eval-pilot),
> Stand 2026-07-17. Messungen (Arme A–E) stehen aus — Akzeptanzkriterien
> unberührt.
>
> **Freeze-Scope:** Phasen 1–3 verbindlich (r3-PASS); Phasen 4–5 Richtplan
> (Schärfung nach Phase-3-Gate). Rollen: dieses Dokument = warum/was;
> SOUL4-PLAN = Deliverables/Akzeptanz/Gates; THREAT-MODEL = bindende Grenzen;
> SOUL4-DECISIONS = Design-Antworten auf die Gate-Befunde.

---

## 1. Die eine tragende Idee

Soul 3.x verwaltet **vertrauenswürdige Erinnerung** (Provenienz, Ledger, Governance).
Soul 4.0 verwaltet zusätzlich **vertrauenswürdige Arbeitsfähigkeit**:

> Modell-Compute wird in dauerhaftes, überprüftes, zwischen Modellen
> portables Fähigkeitskapital umgewandelt.

Jeder teure, erfolgreiche Arbeitslauf soll nach Möglichkeit ein Asset
hinterlassen — einen versionierten Skill, einen Verifier, ein Gegenbeispiel,
ein Kontextrezept, eine Fehlerklassifikation. Nicht nur eine Antwort.

Alles andere aus dem Ideen-Dump (Reasoning Supervisor, Confidence Engine,
Meta Reasoner, Cognitive Cache, …) sind Umformulierungen oder Teilmodule davon.

## 2. Ehrliche Grenzen (nicht verhandelbar)

- Ein MCP-Server kann den Client **nicht zwingen**, seine Tools zu nutzen.
- Kein Versprechen "jedes Modell universal besser". Messbares Ziel: ein
  eingefrorenes Modell + gewachsener Soul schlägt das rohe Modell auf
  definierten **held-out** Aufgabenklassen — nach Einrechnung von Tokens,
  Kosten, Latenz.
- Keine Selbstverbesserung ohne Evals: Generator und Freigabe getrennt
  (technisch UND organisatorisch), deterministische Prüfungen > Modellurteil,
  Held-out-Sets für den Optimierer unsichtbar, Rollback für alles.
- Soul 4.0 ist **declarative-only**: Skills sind Kontext, Workflows,
  Rubriken, Verifier-Anweisungen — kein ausführbarer Code. Executable
  Skills erst in einem späteren Major hinter Capability-Manifest, Sandbox,
  Egress-Kontrolle, Approval und getrenntem Verifier-Prozess (Sol F06).

## 3. Kill-Liste, dreigeteilt (Sol F14)

**Nicht bauen:**
- Superlativ-Ziele ("1000×", "unschlagbar") — nicht messbar, Anti-Performance.
- 20 benannte "Engines" als eigene Module — konsolidiert auf wenige Verträge.
- Autonome Forge ab Tag 1 — erst hinter dem Lernkurven-Gate (Phase 5).
- Executable Skills in 4.0.

**Nicht eager exponieren (aber als Daten erlaubt):**
- Große Skill-/Rezept-Registry ist ok — aber niemals alle an den Client;
  ausschließlich task-scoped Aktivierung weniger relevanter Einträge.
  Die 253-Tools-Falle entsteht durch Exposition, nicht durch Existenz.

**Späteres separates Projekt:**
- Soul Lab (Fine-Tuning/Distillation in Gewichte). ABER: der exportierbare,
  datenschutzbereinigte Episoden-/Evidenzvertrag wird ab Phase 1 mitgeführt,
  damit dieser Weg offen bleibt.
- Forge als eigenes experimentelles Paket (soul-forge), nie Kernel-Abhängigkeit.

## 4. Architektur

### Verträge zuerst (Phase 1, vor jedem Feature-Code)
`TaskContract` · `SkillManifest` · `ReceiptV1` · `VerifierResult` ·
`CapabilityManifest` — kanonisch spezifiziert, versioniert, mit Golden-Tests.

ReceiptV1 (Sol F07): Input-/Output-Hashes, Skill-/Runner-/Verifier-Versionen,
Modell + Umgebung, Kosten, Evidenz, Parent-Receipts, Abbruchzustand.
Trust Root / Rotation / Revocation für signierte Packs werden als Vertrag
definiert; Signatur ≠ inhaltliche Sicherheit.

### Module
```
soul-kernel    (existiert: Memory, Provenienz, Ledger, Constitution, Workbench)
soul-runtime   (NEU: TaskContract-Compiler, Strategy Router, Context Compiler)
soul-verify    (NEU: Verifier-Hierarchie, Receipts, Eval-Harness)
soul-skills    (NEU: declarative Skill-Registry mit Lifecycle)
soul-worker    (OPTIONAL, separates Paket: RunnerAdapter-Implementierungen)
soul-forge     (PHASE 5, separates experimentelles Paket)
```

### Öffentliche API (Sol F03)
Der v3-Server registriert bereits 22 Tools. 4.0 fügt **genau ein** Tool
hinzu: `soul_run` *(Baustand: registriert und getestet — der Server führt
jetzt 23 Tools)*. `soul_feedback` und `soul_status` werden nur additiv
erweitert *(Baustand: `soul_feedback` erweitert — run_id/outcome/evidence_ref;
`soul_status` noch NICHT erweitert, Run-/Skill-Kennzahlen stehen aus)*.
`soul_review` ist gestrichen (Workbench/Resolve/Review-Queue
decken das ab). Phase-0-Deliverable: versionierte API-Matrix
(neu / erweitert / unverändert / deprecated).

`soul_run` bekommt eine **Durable Run State Machine** (Sol F12):
queued / running / waiting_verification / succeeded / failed / cancelled,
Idempotency-Key, Lease/Heartbeat, Retry-Policy, Cancel, Resume,
Budget-Enforcement. Gleiche Ergebnissemantik in beiden Betriebsarten.

### Betriebsarten (Fakten: Claude Code kann kein MCP-Sampling; SEP-2577
deprecated Sampling zugunsten von MRTR — beides Adapter-Territorium)
1. **Kontext-getrieben** (jeder Client, primär): Soul kompiliert TaskContract,
   Skill-Workflows, Rezepte, Rubriken, Verifier-Anweisungen; das Host-Modell
   führt aus und meldet über Soul-Tools zurück (Receipt-Schleife).
   Elicitation wo der Host es kann.
2. **RunnerAdapter-Worker** (providerneutraler Produktvertrag, Sol F05):
   separates Paket; Claude CLI ist EIN Adapter — Version gepinnt, isoliertes
   Arbeitsverzeichnis, restriktive Tools, Netzwerk aus, keine Secrets,
   harte Turn-/Zeit-/Ressourcenbudgets, strukturierte Ausgabe. Nur so laufen
   Replay, Varianten, Kompression unabhängig vom Client.
3. Sampling/MRTR: ausschließlich hinter Capability-Probe + austauschbarem
   Adapter, Experiment-Schicht. Kein Fundament.

## 5. Phasenplan (Sol F02-Schnitt)

**Phase 0 — Freeze, Forensik, Verträge der Realität** *(abgeschlossen, r3-PASS 2026-07-16)*
- v3.1-Freeze + Audit: erledigt, siehe docs/AUDIT-3.1.0.md (3 P1, 4 P2,
  7 Behauptungen widerlegt). P1/P2-Fixes: erledigt in 3.2.0 (107 Tests am
  r3-Freeze-Stand; die Suite wächst seither mit den 1A-Deliverables).
- Restore-Probe (Backup→Restore→Verify end-to-end).
- Client-Capability-Matrix (Claude Code: kein Sampling, Elicitation ja,
  keine Server-Reaktivierung — erhoben 2026-07-16).
- Threat Model (bösartige Packs, Skill-Inhalte, Modelloutputs; kompromittiertes
  OS out of scope).
- API-Matrix + Kompatibilitätsvertrag (Sol F08): Golden MCP Transcripts,
  Schema-Snapshots, Upgrade/Restore/Downlevel-Import, N/N-1-Matrix,
  Passport-Klassifizierung (portable Skills / Receipts / lokale Evals /
  private Artefakte).
- Backlog-Übernahme: soul_reflect→soul_timeline-Regressionstest (aus Gate
  soul-310-release-r3, deferred).

**Phase 1 — Messbarkeit** (Sol F09: geteilt) *(Baustand: 1A-Schemas +
Protokoll + Aufgaben gebaut; Varianz-Pilot/Dry-Run in Arbeit, Baseline-Messung
und formale Abnahme offen)*
- **1A Messprotokoll & Artefaktverträge:** TaskContract, SkillManifest,
  ReceiptV1, VerifierResult, CapabilityManifest; Statistik-Protokoll
  (Mehrfachläufe, gepaarte Aufgaben, Konfidenzintervalle, vorab fixierte
  Stop-/Kill-Regeln); Episoden-Exportvertrag.
- **1B Code-Eval-Strang, ausschließlich:** hermetische Repositories,
  starke Hidden Tests. Recherche/Dokumente erst nach belastbarem Code-Signal
  (sie sind eigene Benchmark-Produkte — eingefrorene Quellen bzw. kalibrierte
  Rubriken, später).
- **Eval-Arme (Sol F10):** A raw · B v3-Kapsel · C v4-Runtime ohne Skill ·
  D v4 mit korrektem Skill · E v4 mit irrelevantem/adversarialem Skill.
  Modell, Tools, Prompt, Kontextbudget, Seeds gepaart; Generator und Grader
  getrennt.

**Phase 2 — Dünner Runtime-Durchstich**
Nur zwei Strategien: `direct` und `plan_execute_verify`. Ein neues Tool:
`soul_run` (mit State Machine). Context Compiler mit hartem Budget und
Begründung pro Baustein. RunnerAdapter-Interface + genau ein Adapter.
Gemessen gegen Phase-1-Baselines; keine Freigabe ohne Signal in Arm C/D vs. B.
*(Baustand: Kontextmodus gebaut — State Machine, Receipt-Vertrag,
Retry/Cancel/Resume, Chaos-Matrix; RunnerAdapter/`soul-worker` NICHT gebaut;
Messung gegen Baselines steht aus.)*

**Phase 3 — Declarative Skill-Registry**
Lifecycle: Shadow → Canary → Promoted → Deprecated → Revoked (Sol F11).
Promotion nur auf unabhängigen Aufgaben + Compatibility Vector
(OS, Tools, Versionen, Kontextbudget — nicht nur "Modell"). Abhängigkeiten,
Konfliktauflösung, SemVer, Environment-Fingerprint, Rollback inkl. laufender
Runs. Genau 5 Skills: die Code-Fähigkeitsleiter passend zum Phase-1-Benchmark (SOUL4-PLAN §3, DECISIONS F04); Content-Skills folgen in Phase 4.
*(Baustand: Registry-Maschinerie gebaut — Migration v11, Lifecycle-Leiter,
Screening/Positiv-Grammatik, SignedPack-Import mit TOFU-Pinning,
Kapsel-Exposition ≤3 promoted, CLI `soul-mcp skill …`; Promotion-Zyklus mit
echten Eval-Daten und D/E-Messung stehen aus — Recipe-Registry (C2a) NICHT
gebaut, wartet auf eigenes Gate.)*

**Phase 4 — Breite**
Recherche- und Dokument-Aufgabenklassen (mit den in 1A definierten, dann
gebauten Benchmark-Produkten); Transfer von Skills auf weitere Modelle/
Umgebungen; ggf. Sampling/MRTR-Adapter, falls Client-Adoption real wird.

**Phase 5 — Forge (separates Paket, hinter Lernkurven-Gate)**
Counterfactual Replay in Sandbox, Varianten-Evolution mit Token-Treasury,
Skill-Kompression. Kill-Kriterium: flache Lernkurve nach Phase 3 → Forge
wird nicht gebaut.

## 6. Messgrößen (die einzigen Erfolgsclaims)

- Erfolgsquote / First-Pass-Akzeptanz auf Held-out-Aufgaben (Arme A–E)
- Faktische Fehler, Nutzerkorrekturen, Sicherheitsregressionen
- Kosten: Token, Laufzeit, Quotenverbrauch, Opportunity Cost (EUR wo messbar;
  bei Subscription-Workern ist EUR/Lauf kein Grenzpreis — Sol F13)
- **Skill-Break-even:** kumulierter Qualitätsgewinn − (Build + Verify +
  Routing + Wartung); Wiederverwendung = Aktivierungen ÷ geeignete Aufgaben
- Lernkurve: gleiche Modellversion nach 10/100/1000 verifizierten Aufgaben
- Transfer: Skill von Modell A von Modell B erfolgreich ausgeführt

## 7. Offene Punkte für das Einfrieren von Phase 1+

1. Threat Model ✓ (docs/THREAT-MODEL.md v1.1)
2. API-/Migrationsmatrix ✓ (docs/API-MATRIX.md, Envelope-Vertrag)
3. Restore-Probe ✓ (docs/RESTORE-PROBE.md, PASS auf realer Live-DB)
4. Eval-Protokoll 1A im Detail (Statistik, Aufgabenquellen, Leakage-Schutz)
5. PII-/Lizenz-Bereinigung für Skills aus realen Aufgaben (Sol Blind Spot)
6. Cross-OS-Fragen (Windows/Linux, better-sqlite3-Verteilung) vor npm-Breite
