# Soul 4.0 — Säule 3: Der Cognition-Strang — ENTWURF v2 (2026-07-16)

> v2 nach PLAN-GATE `soul4-cognition-c0-c3-plan-gate` (Urteil: fail, 0.97 —
> 2 Blocker, 4 hoch, 3 mittel; alle 9 Befunde accepted und hier eingearbeitet,
> Dispositionen im SOL-LOG). Re-Gate als `soul4-cognition-plan-gate-r2`
> vor Verbindlichkeit.
>
> Verhältnis zu den bestehenden Dokumenten: Dieses Dokument ERGÄNZT den
> Plan-Freeze — es ändert NICHTS an den eingefrorenen Phasen 1–3
> (SOUL4-PLAN.md). Es konkretisiert den Richtplan-Raum (Phasen 4–5) zu einem
> eigenen, separat gegateten Strang. THREAT-MODEL v1.1 §5-Invarianten und das
> AuthorityEnvelope-Monotonie-Gesetz gelten unverändert für jede Zeile.
>
> Status: ENTWURF. Wird erst nach bestandenem Re-Gate verbindlich.

---

## 0. Produktthese (der ehrliche Satz)

**soul trainiert keine Modelle; es lernt eine auditierbare Entscheidungspolitik
darüber, welches Modell mit welchem Kontext und welchem Verfahren wann
eingesetzt wird.** (Outside-View-Gate 2026-07-16, Run 20260716-220915-gpt-28430
— bindende Sprachregelung. Alles darüber hinaus ist Overclaim.)

**Anspruchs-Begrenzung (F03/Annahme 3 des Gates):** Bis eine vorregistrierte,
kontrollierte Explorations-Mechanik existiert (C2b), sind alle Kompetenz-
Aussagen des Strangs **deskriptiv, nicht kausal**. Die Kompetenzkarte sagt
„unter den beobachteten Bedingungen war X mit Y erfolgreich", nie „X ist
besser als Z" — Selektionsbias und Confounding sind bei beratendem Routing
ohne Randomisierung nicht identifizierbar.

Die drei Säulen von Soul 4.0:

| Säule | Inhalt | Stand |
|---|---|---|
| 1 — Gedächtnis | Provenienz-Ledger, disputed-Zustand, Kalibrierung, Hybrid-Retrieval | gebaut (3.2.0), Ausbau C1 |
| 2 — Fähigkeiten | soul_run + Skill-Registry (Shadow→Canary→Promoted), declarative-only | Plan-Freeze Phasen 1–3 |
| 3 — Kognition | Empirische Entscheidungspolitik über Modelle, Rezepte, Kontext | DIESES DOKUMENT |

## 1. Warum Säule 3 die Lücke ist (extern verifiziert, 2026-07-16)

Live-Recherche über mem0 (61k★), Letta (23.8k★), Zep/Graphiti (28.8k★),
cognee (27.9k★), basic-memory, OpenMemory, txtai, MCP-Referenz-Server ergab:

1. **Kein Shipping-System kalibriert Confidence gegen echte Outcomes.**
2. **Kein System hat disputed als erstklassigen Zustand.** Soul hat das
   bereits — Alleinstellung, die ausgebaut, nicht neu erfunden werden muss.
3. **Kein System lernt aus Retrieval-Nutzung.** Ranking ist überall statisch.
4. **Querschnittsbefund:** Alle Inference-only-Verbesserungsmechanismen
   (Cascades/Routing, Self-Consistency, Reflexion, Experience Libraries,
   GEPA) brauchen dieselbe Datenstruktur: **persistente (Entscheidung,
   Confidence, Outcome)-Tripel.** Keines der großen Systeme besitzt sie —
   Soul besitzt sie im Ansatz (Prediction-Ledger, Brier-Buckets,
   memory_feedback).

## 2. Das Datenrückgrat: Episode@1 — geteilt in C0a und C0b (F01)

**C0a (innerhalb 1A, Vertrag only):** Episode@1-Schema, Feld-Klassifizierung,
Golden-Beispiele, Mess- und Linkage-Regeln. KEIN Runtime-Code, KEINE
Emission aus bestehenden v3-Tools.

**C0b (Phase 2, additive Instrumentierung):** Episoden entstehen an
soul_run/ReceiptV1 — gekoppelt an die dort ohnehin entstehende
Run/Receipt-Maschinerie. Bestehende v3-Tools emittieren vor
Phase-2-Akzeptanz keine Pflicht-Episoden.

### Episode@1 — Kernfelder (Finalisierung in C0a)

```
Identität & Zeit (bitemporal):
  episode_id, occurred_at / recorded_at

Klassifikation:
  task_slice          — (kind, risk), deterministisch (§3)
  domain_raw          — versioniertes Rohmerkmal, KEINE Statistik-Achse (F06)

Kausal-Verkettung (F03 — Kern des Vertrags):
  recommendation_id   — welche Empfehlung ausgesprochen wurde, nullable
  policy_version      — Stand der Politik, die empfahl
  offered             — {actor, recipe_id, context_recipe} wie empfohlen
  acceptance          — accepted | overridden | unknown
  executed            — {actor, recipe_id, context_echo} wie tatsächlich
                        gelaufen (best-effort Echo vom Client; unknown
                        ist zulässig und wird als unknown geführt)
  run_id, attempt_id, receipt_id, verifier_result_id — nullable Verweise

Vorhersage & Kosten:
  prediction          — {p, statement_ref} falls abgegeben (statement als
                        Hash/Referenz, Klartext nur wenn zwingend — F07)
  cost                — {tokens_est, latency_ms, attempts}

Outcome:
  outcome             — PENDING → success | failure | mixed |
                        expired_unconfirmed
  outcome_source      — verifier | user | self_attested | expired_unconfirmed
  outcome_observed_at — bitemporaler Nachtrag
  eligibility         — ob diese Episode in Statistik einfließen darf
                        (z.B. false bei unknown-Ausführung für Actor-Vergleiche)
```

Regeln:
- **expired_unconfirmed ist Missingness, kein negatives Outcome** (F03, I11).
  Missingness wird berichtet, nie imputiert.
- **Outcome-Semantik wird in C0a formalisiert** (Gate-Blind-Spot): Was zählt
  als user-Outcome (explizite Bestätigung/Korrektur, nicht Schweigen), wie
  werden mehrwertige Outcomes und konkurrierende Verifier aufgelöst
  (Rangfolge: verifier > user > self_attested nur für Eligibility, nie
  für Überschreibung eines expliziten User-Urteils — Autoritätsordnung
  der Constitution gilt).
- **Nichtstationarität als Epoch-Vertrag** (Gate-Blind-Spot): policy_version
  + model_echo + recipe_version definieren Epochen; Statistiken werden je
  Epoche geführt und nie stillschweigend über Epochen gemischt.
- Replays sind zeitkorrekt (Auswertung sieht nur Outcomes, die zum
  Replay-Zeitpunkt bekannt waren).

### Feld-Klassifizierung (F07)

Jedes Feld erhält in C0a eine Sensitivity-Klasse gemäß 1A-PII-Regelwerk;
`internal` ist eine Zugriffs-, keine Sensitivity-Klasse und ersetzt diese
nicht. Grundsätze: Datenminimierung (Statements/Task-Texte als
Hash/Referenz), dieselbe Secret-/PII-Schleuse für kontextgetriebene wie für
Worker-Episoden (TB6b schützt nur Worker→Provider — die Kapsel-Pfade
brauchen die Capture-Schleuse zusätzlich), Export-Default redigiert.

## 3. Task-Slices (gegen das Sparse-Data-Problem)

Deterministisch, grob, KEINE LLM-Klassifikation im Schreibpfad:

```
task_slice = (kind, risk)
  kind ∈ {code_fix, code_review, research, decision, estimate, content, ops, other}
  risk ∈ {low, high}
```

- Slices mit < N Episoden delegieren an den Eltern-Slice; kein Slice
  berichtet Statistik unter Mindest-N (N aus Varianz-Pilot).
- `domain` wird nur als versioniertes Rohmerkmal gespeichert (F06) und erst
  nach Pilot/Power-Nachweis zur Achse.
- Taxonomie-Erweiterung = versioniertes Constitution-Update.

## 4. C1 — Kompetenzkarte + Kalibrierung, geteilt in C1a/C1b (F06, F09)

**C1a — deskriptive Berichte (nach C0b, braucht echte verknüpfte Episoden):**
- Qualitäts- und **Missingness-Berichte** zuerst: n_verified, n_missing,
  n_unknown_execution, Outcome-Quellen-Mix, Zeitfenster — pro Slice.
- Kompetenzkarte rein deskriptiv: pro (task_slice, actor, recipe, epoch)
  Erfolgsrate mit Unsicherheitsintervall (Jeffreys, nur über Episoden mit
  eligibility=true und definiertem binärem Outcome), Kostenprofil, n.
- **Kein neues Tool (F02):** Veröffentlichung additiv unter soul_status und
  der Resource soul://status; Detaildaten ggf. als neue read-only Resource,
  deren Vertrag VOR C1a in der API-Matrix spezifiziert wird. Bestehende
  Statusfelder bleiben byte-identisch (Golden Transcripts).

**C1b — Rekalibrierung (erst nach Pilot + Mindestbasis):**
- Isotonic-Rekalibrierung pro Bucket erst ab vorregistrierter Mindestbasis
  (aus Pilot, nicht erfunden); bis dahin bleibt die bestehende globale
  Brier-Mechanik (cognition.ts) unverändert.
- Ausgabe trägt IMMER `{p_raw, p_calibrated, calibration_n}` (I3).

### Ehrliche Degradation bei dünner Evidenz (F06, beantwortet Frage 4)

Die Kapsel zeigt bei unzureichender Evidenz:
`evidence_state=insufficient`, n_verified, n_missing, Outcome-Quellen,
Zeitfenster, breites Intervall — **keine Rangzahl, keine
Dezimal-Erfolgsrate, keine adaptive Empfehlung.** Beispielformulierung:
„Default-Empfehlung (Constitution); 4 verifizierte, 3 ungeklärte Episoden;
nicht genug Evidenz für einen Modellvergleich."

## 5. C2 — Rezept-Registry + Routing, geteilt in C2a/C2b (F06, F09)

**C2a — Recipe-Schema + Lifecycle (nach Phase 3, OHNE adaptives Routing):**
- Recipe@1 als **Positiv-Grammatik analog Skill@1** (typisierte Blöcke,
  untrusted Daten, TB5-Schutz analog): Schrittfolgen wie
  `retrieve → Gegenhypothese → Toolcheck → Synthese` mit io-Erwartungen
  und Verifier-Hinweisen. Erweiterung der fünf soul_deliberate-Scaffolds.
- **Ein Lifecycle, zwei Registries:** Recipes nutzen die
  Shadow→Canary→Promoted→Deprecated→Revoked-Maschinerie der Skills.
  ≤3 Recipes pro Kapsel, task-scoped, Shadow nie normal exponiert (I13).
- Routing-Empfehlung = **Constitution-Defaults + deskriptive Kartendaten**,
  kein Bandit. Jede Empfehlung ist Ledger-Event mit recommendation_id,
  policy_version, Begründung (auditierbar) — das erzeugt die
  F03-Verkettung von Anfang an.

**C2b — kontrollierte Exploration (eigenes Daten-Gate):**
- Erst nach: vorregistrierter Mindestbasis, stabiler Outcome-Definition,
  nachgewiesener Linkage-Qualität (Missingness-Bericht unter Schwelle).
- Dann **capped Thompson-Sampling** (hartes Explorations-Budget) — kein
  ε-greedy (Gate-Antwort auf Frage 3: beide sind am Cold Start
  ungerechtfertigt; wenn später, dann Thompson mit Deckel).
- Kausale Aussagen („X besser als Z") NUR aus dieser vorregistrierten,
  begrenzten Randomisierung oder gepaarten Holdouts (F03).
- Routing bleibt beratend; Override ist zulässig und wird als
  acceptance=overridden geführt (ehrliche MCP-Mechanik: kein Sampling,
  keine Kontrolle über das Host-Modell).

## 6. C3 — Offline-Policy-Evolution (GEPA-artig, hinter Phase-5-Eintritt)

**Eintrittsbedingung = exakt die eingefrorene Phase-5-Bedingung (F04),
nicht weniger:** Phase-3-Gate abgeschlossen UND positive Lernkurve auf
frischen Held-out-Aufgaben bei gleicher Modellversion UND Sicherheits-/
Budget-Gates erfüllt UND eigenes PLAN-GATE. Eine Episodenschwelle ist
nur zusätzliche Voraussetzung, nie Ersatz.

Mechanik (unverändert aus v1): periodische OFFLINE-Optimierung von Souls
eigenen Text-Assets gegen Ledger-abgeleitete Eval-Sets; Shadow-Kandidaten,
Champion/Challenger mit vorregistrierter Metrik, Two-Key/Taint-Regeln aus
F08 wiederverwendet; jede Promotion versioniertes Ledger-Event mit
Rollback; nur Outcome-verankerte Metriken, nie Judge-only-Promotion.

## 7. Invarianten des Cognition-Strangs — I1–I13 (F05 erweitert)

PR-Invarianten wie THREAT-MODEL §5 — Verstöße blocken Merge:

- **I1 — Kein Lernsignal ohne externes Outcome.** Selbstbewertung
  (self_attested, Reflexion, Judge-only) ist nie allein ein Lernsignal.
- **I2 — Kein globaler Self-Improvement-Score.** Nur pro Slice, zeitlich
  out-of-sample, gegen eingefrorene Baseline.
- **I3 — Confidence nur mit Kalibrierungs-Provenienz.** p_raw +
  p_calibrated (+n) immer gemeinsam.
- **I4 — Capture bleibt kuratiert.** Episoden, keine Konversationen.
- **I5 — Policy ist Daten.** Jede Änderung versioniertes Ledger-Event
  mit Rollback.
- **I6 — Reflexions-Memories tragen Provenienz + Confabulation-Check.**
- **I7 — Routing berät, Autorität bleibt monoton.** Keine Empfehlung
  erweitert Rechte (F06-Gesetz).
- **I8 — Outcome-Authentizität + Rollentrennung.** Outcomes tragen
  verifizierbare Provenienz; Erzeuger, Bewerter und Promoter einer
  Policy/eines Recipes sind getrennte Rollen — niemand attestiert das
  eigene Artefakt.
- **I9 — Two-Key/Taint für jede Policy-Evolution.** Held-out-Schutz
  (F08-Mechanik) gilt für Recipes und Policies wie für Skills.
- **I10 — Empfehlung ist nicht Ausführung.** offered/accepted/executed
  strikt getrennt geführt; Statistik nur über belegte Ausführung.
- **I11 — Missingness ist nicht Misserfolg.** unknown/expired wird
  berichtet, nie als Erfolg oder Fehlschlag imputiert.
- **I12 — Datenminimierung per Feldklasse.** Episoden unterliegen
  Feld-Klassifizierung, Redaction und Export-Defaults (redigiert).
- **I13 — Recipes sind untrusted typisierte Daten.** Positiv-Grammatik,
  ≤3 pro Kapsel, task-scoped, Shadow nie normal exponiert.

## 8. Positionierung (nur intern; öffentliche Claims erst nach Messung)

| Lücke (extern verifiziert fehlend) | Soul-Antwort | Strang |
|---|---|---|
| Outcome-kalibrierte Confidence | Prediction-Ledger + Rekalibrierung | C1b |
| disputed als erstklassiger Zustand | existiert seit v2 — wird API-Vertrag | Säule 1 |
| Retrieval-Nutzungs-Feedback | memory_feedback → Slice-Statistik → Gewichte | C1a→C2b |
| Policy-Evolution auf eigenem Ledger | GEPA-artig, Holdout-gated | C3 |
| Provenienz als Client-Kontrakt | Sectioned Envelope + Kapsel-Semantik | Phasen 1–3 |

Sprachregel für README/Website: KEIN „revolutionär", KEIN „50 Jahre voraus",
KEINE Benchmarks ohne vorregistriertes Protokoll. Die Story ist §0 samt
Anspruchs-Begrenzung — jede Zahl aus einem echten Lauf.

## 9. Fahrplan (Schnittmuster aus F09, ersetzt v1-§9)

| Schritt | Inhalt | Voraussetzung |
|---|---|---|
| **C0a** | Episode@1-Schema, Feldklassen, Golden-Beispiele, Outcome-Semantik, Epoch-Vertrag, Linkage-Regeln | innerhalb 1A (füllt den Freeze, ändert ihn nicht) |
| **C0b** | Runtime-Instrumentierung an soul_run/ReceiptV1 | Phase 2 |
| **C1a** | deskriptive Qualitäts-/Missingness-/Kompetenz-Berichte via soul_status/Resource | C0b + Resource-Vertrag in API-Matrix |
| **C1b** | Isotonic-Rekalibrierung pro Bucket | Varianz-Pilot + vorregistrierte Mindestbasis |
| **C2a** | Recipe@1 + Lifecycle (keine Adaption), Empfehlungs-Events mit Verkettung | Phase 3 (Registry-Maschinerie) |
| **C2b** | capped Thompson-Exploration, kausale Vergleiche | eigenes Daten-Gate (Linkage-Qualität + Mindestbasis) |
| **C3** | Offline-Policy-Evolution | exakt Phase-5-Eintrittsbedingung (F04) |

Jeder Übergang hat ein eigenes Sol-Gate (zweiphasiges SOL-LOG, hohe
Befunde vor Fortschritt CLOSED).

## 10. Entschiedene Fragen (v1-§10, beantwortet durch das PLAN-GATE)

1. **Kein 23. Tool.** Kompetenzdaten additiv unter soul_status +
   read-only Resource mit vorab spezifiziertem Vertrag. (F02)
2. **Slice bleibt (kind, risk).** domain nur Rohmerkmal bis
   Power-Nachweis. (F06)
3. **Kein Bandit am Start.** Constitution-Defaults + beobachtende
   Berichte; später capped Thompson hinter Daten-Gate; ε-greedy nie. (F06)
4. **Dünne Evidenz wird als evidence_state=insufficient ausgewiesen** —
   n_verified/n_missing/Quellen/Zeitfenster, keine Scheinpräzision. (F06)
5. **Keine Episodenzahl-Löschschwelle.** Append-only Kernevents +
   Hash-Referenzen dauerhaft; Klartext/PII-Payloads nach Feldklasse und
   Constitution-Frist redigiert/tombstoned; Projektionen jederzeit
   rekonstruierbar; Größen-Gate empirisch per Lasttest (DB-Bytes,
   Query-Latenz, Backup-Zeit). (F08)
