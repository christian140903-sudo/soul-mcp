# Soul 4.0 — Varianz-Pilot, mechanische Ebene (F15, Phase 1A)

> **Mechanischer Pilot — die Ergebnis-Varianz echter Modell-Läufe ist damit NICHT gemessen; die konfirmatorische Stichprobenzahl kann erst nach echten Modell-Pilotläufen fixiert werden. Dieser Pilot fixiert nur: Verifier-Determinismus bestätigt, Harness funktionsfähig, Rechenweg der Power-Fixierung implementiert und getestet.**

Generiert von `eval/pilot/run-pilot.mjs`. Design: 3 Aufgaben × 5 Wiederholungen × 2 Arme = 30 echte Verifier-Prozessläufe.

## Verifier-Determinismus (Outcome-Varianz muss 0 sein)

| Task | Arm-A-Outcomes (5×) | Arm-B-Outcomes (5×) | Varianz 0 | erwartet (A fail / B pass) |
|---|---|---|---|---|
| rr-01-module-graph | fail | pass | true | true |
| mfr-01-interval-overlap | fail | pass | true | true |
| rut-03-decompose-pipeline | fail | pass | true | true |

Determinismus bestätigt: **true**

## Laufzeit-Varianz (real gemessen, Sekunden)

| Task | Arm A mean ± sd | Arm B mean ± sd |
|---|---|---|
| rr-01-module-graph | 0.052 ± 0.001 | 0.052 ± 0.001 |
| mfr-01-interval-overlap | 0.060 ± 0.003 | 0.336 ± 0.017 |
| rut-03-decompose-pipeline | 0.188 ± 0.001 | 0.189 ± 0.001 |

Varianzzerlegung über Arm-B-Laufzeiten: σ²_between = 0.020049, σ²_within = 0.000102 (Grand Mean 0.192 s).

## Beispiel-Power-Rechnung (F15: task-zentriert, einseitig α = 0.05, Power 0.8)

Rechenweg: T = ⌈(z₀.₉₅ + z₀.₈)² · (σ²_b + σ²_w/R) / Δ²⌉ mit Beispiel-Δ = 20 % der mittleren Laufzeit = 0.0384 s.

| Repeats R | erforderliche Tasks T | Gesamtläufe T·R |
|---|---|---|
| 1 | 85 | 85 |
| 2 | 85 | 170 |
| 3 | 85 | 255 |
| 5 | 84 | 420 |
| 10 | 84 | 840 |

Sobald σ²_between > 0 wächst der Gesamtaufwand T·R mit R — mechanische
Bestätigung der F15-Regel "mehr unabhängige Aufgaben schlägt mehr Repeats".

## Ehrlich offen

- Die Beispiel-Zahlen oben sind LAUFZEIT-Sekunden, nicht pass@1: ohne echte
  Modell-Läufe existiert keine Outcome-Varianz (Verifier sind deterministisch).
- Die konfirmatorische Wiederholungszahl wird erst nach echten Modell-
  Pilotläufen fixiert und dann als sichtbare Protokoll-Revision nachgetragen
  (EVAL-PROTOCOL.md §3/§5), BEVOR die erste konfirmatorische Welle startet.
