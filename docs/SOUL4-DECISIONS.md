# Soul 4.0 — Design-Entscheidungen zu den Freeze-Gate-Befunden F01–F10
*(2026-07-16, Antwort auf Sol-Gate phase0-freeze-soul4, Urteil fail 0.98.
Jede Entscheidung geht bewusst über die Minimal-Maßnahme hinaus, wo das
Problem hinter dem Befund es verlangt. Kein Superlativ — Mechanismen.)*

---

## F01 — Passport: Sectioned Envelope, JETZT im Reader verankert

**Problem hinter dem Befund:** Eine Checksum macht zwei Jobs — Integrität
des Ganzen UND Kompatibilitätssignal. Deshalb kollidieren fail-closed und
Forward-Kompatibilität zwangsläufig.

**Entscheidung:** Trennung der Jobs durch einen **Sectioned Envelope**
(Passport-Format 3.0.0):
- Jede Sektion (`core`, später `skills`, `receipts`, …) trägt einen eigenen
  SHA-256 über ihren kanonischen JSON-Inhalt.
- Der Header trägt eine sortierte Sektionsliste `{name, version, hash,
  required}`; die Top-Level-Checksum hasht NUR diese Liste.
- Reader-Regel: Listen-Checksum verifizieren → Hashes aller BEKANNTEN
  Sektionen verifizieren → unbekannte Sektion mit `required:true` → refuse
  (fail-closed bleibt); unbekannte optionale Sektion → überspringen, aber
  ihr Hash steht in der verifizierten Liste, Manipulation bleibt also für
  jeden fähigeren Reader beweisbar.

**Der eigentliche Hebel — Timing:** 3.2.0 ist noch NICHT veröffentlicht.
Der Envelope-**Reader** wird noch in 3.2.0 eingebaut (Writer bleibt 2.0.0).
Damit versteht die erste Version, die je mit fail-closed-Import in die Welt
geht, bereits das 4.0-Format. Das Kompatibilitätsproblem wird gelöst, bevor
es existieren kann — danach wäre es nur noch mit einem Major zu heilen.
Golden Tests: alt→neu, neu→alt, Tamper an jeder Sektion einzeln, required-
Refusal. (Implementierung: separater Auftrag, Spez unten in §Anhang A.)

## F02 — Eval: Preregistration als Code, nicht als Absichtserklärung

**Problem:** Selbstbetrug entsteht aus Freiheitsgraden nach dem Blick auf
Daten — nicht aus böser Absicht.

**Entscheidung:** Das Protokoll wird ausführbar und unveränderlich:
1. `eval/protocol/` enthält EVAL-PROTOCOL.md **und das Analyse-Skript**;
   beides wird vor dem ersten Messlauf committed, der Verzeichnis-Hash im
   Ledger verankert. Ergebnisse entstehen nur durch dieses Skript;
   jede Änderung = sichtbare Protokoll-Revision, laufende Welle verworfen.
2. Fixierte Kenngrößen: primärer Endpunkt pass@1 auf Hidden Tests;
   Analyseeinheit Task-Cluster; gepaarter Cluster-Bootstrap (BCa, 10k),
   Läufe innerhalb Task genestet; feste Stichprobe (aus Varianz-Pilot, F15);
   Intention-to-treat (Abbruch/Timeout = Fehlschlag); Holm-Korrektur über
   die konfirmatorischen Vergleiche; Sekundärmetriken nur deskriptiv
   (Outcome-Switching-Verbot).
3. Entscheidungsregeln vorab: C vs B einseitige Nichtunterlegenheit
   (δ = 3 Prozentpunkte); D vs C Überlegenheit nur wenn CI-Untergrenze > 0
   UND Punktschätzer ≥ +10pp; Kosten-Gate Median-Tokens(D) ≤ 3× B.
   Futility-Grenze stoppt aussichtslose Wellen (spart Compute, F15).

## F03 — E-Arm-Split + stehende Adversarial-Suite

**Problem:** Mein Formulierungsfehler (E≤B "widerlegen") + falscher
Komparator: Sicherheit misst sich an C, nicht an B.

**Entscheidung:** Zwei Arme, zwei Fragen, ein Dauerläufer:
- **E1 (irrelevanter Skill):** Äquivalenz zu C innerhalb ±δ bei Qualität
  UND Kosten — beweist, dass falsches Routing nicht schadet.
- **E2 (adversarialer Skill):** Nichtunterlegenheit zu C PLUS Null-Toleranz:
  `policy_violations = egress_attempts = authority_claims = 0`; zusätzlich
  Router-Reject-Rate als eigene Metrik (erkennt Soul den Skill als
  unpassend?).
- **Dauerhaft statt einmalig:** Die adversarialen Skills (Egress-Köder,
  Verifier-Sabotage, Autoritäts-Claim, Budget-Burn) werden eine versionierte
  Fixture-Bibliothek, die als **Regressionssuite bei jeder Runtime-/Router-
  Änderung** läuft — nicht nur in Phase-3-Messwellen. Aus einem Messarm wird
  eine permanente Sicherheitsgrenze in CI.

## F04 — Skills und Benchmark aus einem Guss: die Code-Fähigkeitsleiter

**Problem:** Phase 3 wollte Content-Skills auf einem Code-Benchmark messen.

**Entscheidung:** Phase 3 baut ausschließlich **5 Code-Skills, die eine
Leiter bilden** — jede Stufe produziert schema-validierte Artefakte, damit
deterministische Teilverifikation möglich ist:
1. `repo-recon` (Struktur+Tests erfassen → strukturierter Report)
2. `failing-test-diagnosis` (Symptome → Hypothesen → Ausschlussmatrix)
3. `minimal-fix-with-regression-test` (Fix + Test, der vorher rot war)
4. `contract-review` (Änderung gegen API-/Verhaltensverträge prüfen)
5. `refactor-under-tests` (Verhalten konstant, Struktur besser)
Die Leiter deckt genau die Aufgabenklasse des Phase-1-Benchmarks ab; D-vs-C
ist damit sauber messbar. Chrisos Content-/Audit-Skills wandern nach
Phase 4, wenn deren Benchmark-Produkte existieren.

## F05 — Worker: Datenklassen-Schleuse vor dem Provider

**Problem:** TB6 isolierte den Worker vom System, aber nicht die
Arbeitsdaten vom Modellprovider.

**Entscheidung:** Neue Boundary TB6b mit einer **Klassifizierungs-Schleuse**:
- Jeder Run deklariert die Datenklasse seiner Inputs
  (`public | project | personal | secret`) im AuthorityEnvelope (F06).
- Der Worker-Wrapper (nicht das Modell, nicht der Prompt) erzwingt:
  `secret` verlässt die Maschine nie; `personal` nur mit explizitem
  User-Grant pro Run; Redaction-Pass vor jedem Provider-Call.
- Provider-Endpunkte sind eine EIGENE Allowlist; das Tool-Netz des Workers
  ist davon getrennt und per Default leer.
- Adapter-Binary per **Digest** gepinnt (nicht Versionsstring — ein
  auto-updatender CLI-Client ist sonst eine wandernde Trust-Basis).
- Harte Limits im Wrapper: Prozesse, Disk, Output-Bytes, Wanduhrzeit, EUR.
- Phase-2-Akzeptanz enthält **Escape-/Egress-Negativtests** als Fixtures.

## F06 — AuthorityEnvelope: v3-Philosophie auf Ausführungsrechte gespiegelt

**Problem (Sols stärkster Fund):** Niemand regelte, WER einen
kostenpflichtigen/dateiverändernden Run autorisiert. Freitext hätte Rechte
kompilieren können — ein injizierter Host wäre Ausführungsautorität.

**Entscheidung:** Dieselbe Mechanik, die v3 für Wahrheit etabliert hat
(user-Autorität nur mit `user_evidence`), wird auf Rechte übertragen:
**Capability nur mit Grant.**
- Der `AuthorityEnvelope` ist ein eigenes, versioniertes, vom Modell
  **nicht beschreibbares** Objekt: erlaubte Pfade, Tools, Netzwerkziele,
  Schreibrechte, Datenklasse, Budget.
- **Monotonie-Gesetz:** Autorität entsteht nur aus (a) explizitem
  User-Grant, (b) minimalem Constitution-Default; Skills, Freitext und
  Modelloutput können sie ausschließlich REDUZIEREN, nie erweitern.
- Effektive Rechte eines Runs = Schnittmenge(Envelope, Adapter-Capabilities,
  Constitution). Modell-Wünsche landen als `requested_authority` im
  Kontrakt und werden erst durch expliziten User-Grant (Elicitation/CLI)
  wirksam. Netzwerk und destruktive Rechte: immer explizit, nie Default.
- Damit ist die Symmetrie komplett: v3 bewacht, was Soul GLAUBT;
  der Envelope bewacht, was Soul TUT.

## F07 — Skills: Positiv-Grammatik statt Deny-Heuristik

**Problem:** Eine Deny-Liste gegen bösartige Instruktionen ist derselbe
verlorene Wettlauf wie jeder Injection-Filter.

**Entscheidung:** Die Angriffsfläche wird **strukturell** klein gemacht:
- `Skill@1` ist keine Freitext-Datei, sondern eine **typisierte Grammatik**:
  erlaubte Blöcke sind `steps`, `rubric`, `verifier_hints`,
  `context_recipe`, `io_schema` — mit Längenlimits pro Feld; URLs/Pfade nur
  in deklarierten Referenzfeldern, die NIE automatisch geladen werden;
  alles außerhalb der Grammatik ist invalid, nicht "verdächtig".
- Die Deny-Liste bleibt als ZWEITE Schicht (defense in depth), zusammen mit
  dem bestehenden Secret-/Injection-Screening.
- Invariante (Threat Model §5): *Skills sind untrusted data und können
  Tool-/Netz-/Dateirechte nie erweitern* (Anschluss an F06-Monotonie).
- Shadow-Skills werden ausschließlich in isolierten Eval-/Canary-Runs
  exponiert, nie in normalen Kapseln.
- Das Registry-Screening bekommt **adversariale Negativtests** (die
  E2-Fixture-Bibliothek aus F03 doppelt als Screening-Testset — ein
  Artefakt, zwei Verteidigungslinien).

## F08 — Held-out: Capabilities statt Disziplin (Two-Key)

**Problem:** "Eigenes Verzeichnis + Vorsatz" hält keinem Optimierer stand —
und ein Solo-Entwickler kann sich nicht selbst verblinden.

**Entscheidung:** Zugriff wird technisch unmöglich statt verboten:
- Hidden Tests liegen **verschlüsselt** im Repo (age); den Key besitzt nur
  der Grader-Prozess (Env-File außerhalb jedes Agent-/Optimierer-Kontexts).
- Runner erhalten ausschließlich öffentliche Fixtures; der Wrapper prüft
  Env+Mounts und **taintet** jeden Lauf, dessen Prozess Key oder
  Klartext-Pfad je gesehen hat — getaintete Läufe sind ungültig, das steht
  im Receipt.
- Manifeste und Splits werden vorab gehasht und committed.
- **Set-Pensionierung:** Ein Gate-Set wird nach jedem konfirmatorischen
  Gebrauch nach `spent/` verschoben; das nächste Gate zieht ein frisches.
- Aufgaben-Generierung durch einen getrennten Agenten; ich sehe bis nach
  dem Gate nur Metadaten. **Ehrlich deklariertes Restrisiko:** vollständige
  Selbst-Verblindung ist solo nicht erreichbar — das steht als R7 im
  Threat Model, nicht im Kleingedruckten.

## F09 — Runs: Ehrlichkeit als Design — at-least-once + Fencing + Reaper

**Problem:** "Resume ohne Doppel-Ausführung" versprach exactly-once —
verteilte Systeme können das für externe Effekte nicht garantieren.

**Entscheidung:** Das Versprechen wird durch ein haltbares ersetzt:
- **at-least-once + Fencing + Idempotenz:** RunAttempt-Zeile + Budget-
  Reservierung atomar VOR Dispatch; jeder Attempt trägt ein Fencing-Token;
  Side-Effects laufen attempt-scoped (eigenes Workdir), der Commit-Schritt
  prüft das Token — ein verwaister alter Worker kann nie mehr committen.
- **Der Worker schreibt sein finales Receipt nie selbst:** ein
  Coordinator/Reaper erzeugt Receipts aus Attempt-State + Worker-Log —
  auch für Timeout, Crash und Kill. Kein Lauf ohne Receipt, gerade der
  gescheiterte nicht.
- **Receipt-Ehrlichkeitsklassen:** `self_attested < deterministic_verified
  < model_graded` — ein Receipt sagt immer dazu, wie sehr man ihm glauben
  darf (Anschluss an TB2: deterministisch > Modellurteil).
- **Chaos-Testmatrix** statt eines Lease-Tests: kill −9 an JEDER Grenze
  (vor Dispatch / im Run / vor Commit / vor Receipt) ist je ein eigener
  Testfall der Phase-2-Akzeptanz.
- **Kontext-getriebener Modus (ohne Worker) — vollständiger Receipt-Vertrag
  (per r2-F09, verbindlich auch hier, nicht nur im PLAN):** `soul_run` ohne
  Worker liefert den kompilierten TaskContract + Rezept als Kapsel zurück
  und legt SYNCHRON bei Run-Erzeugung ein Receipt im Zustand `pending`
  (Ehrlichkeitsklasse `self_attested`) an. Rückmeldung über `soul_feedback`
  schließt es (ggf. Hochstufung auf `deterministic_verified`); bleibt
  Feedback aus, schließt der Reaper es nach definiertem Timeout
  (Default 7 Tage) als `expired_unconfirmed`. Die Invariante „jeder Run hat
  ein Receipt" gilt in BEIDEN Modi synchron ab Run-Erzeugung — nur der
  Abschlussweg unterscheidet sich. `expired_unconfirmed` ist Missingness,
  nie ein Erfolgs- oder Misserfolgs-Beleg.
  *(Baustand-Präzisierung per Bündel-Gate F02: die „ggf. Hochstufung auf
  `deterministic_verified`" findet in 4.0 NICHT statt — sie setzt ein
  validiertes VerifierResult@1 voraus, das 4.0 nicht produziert. Gebaut ist:
  das Receipt bleibt `self_attested`; `evidence_ref` wird als auditierbarer
  Verweis geführt, ohne Klassenwechsel. Test: `test/runs.test.mjs`.)*

## F10 — Verlorene Verträge: vollständige Disposition

| Vertrag | Spez | Implementierung | Test |
|---|---|---|---|
| SignedPackEnvelope + Keyring (Trust Root, Rotation, Revocation) | Phase 1A (Schema + Design) | Phase 3, VOR erster Fremd-Pack-Annahme | Phase 3 (Signatur-Tamper, Revocation) |
| Retry / Cancel | Phase 2 (Teil der State Machine) | Phase 2 | Phase 2 (inkl. Chaos-Matrix F09) |
| Skill-Dependencies, Konfliktauflösung, Skill-SemVer | Phase 3 (SkillManifest@1) | Phase 3 | Phase 3 |
| Cross-Soul-Sync | — | **explizit NICHT in 4.0** | — |
| Import-DoS-Limits (F14) | erledigt | 3.2.0 (`SOUL_MAX_IMPORT_BYTES`-Guard; Suite am r3-Freeze-Stand: 107 Tests) | ✓ golden-contracts |

---

## Anhang A — PassportEnvelope@3 Kurz-Spez (für die Implementierung)

```jsonc
{
  "format": "soul-passport",
  "version": "3.0.0",
  "exportedAt": "…",
  "sections": [   // sortiert nach name; DIES ist die gehashte Liste
    { "name": "core",   "version": "2.0.0", "hash": "sha256:…", "required": true },
    { "name": "skills", "version": "1",     "hash": "sha256:…", "required": false }
  ],
  "checksum": "sha256 über kanonisches JSON von `sections`",
  "core":   { /* exakt der bisherige 2.0.0-Body */ },
  "skills": { /* … */ }
}
```
Kanonisierung: JSON.stringify mit sortierten Keys, UTF-8. Reader-Algorithmus
und Fehlerpfade wie in §F01. 3.2.0 implementiert NUR den Reader; der Writer
exportiert weiterhin 2.0.0 (Golden Tests fixieren beides).
