# Soul 4.0 — Mechanischer A/B-Dry-Run (Phase 1A)

> **Arm A/B sind Fixture-vs-Referenzlösung — ein Pipeline-Funktionsbeweis, KEIN Modell-Vergleich, keine konfirmatorische Aussage.**

Generiert von `eval/pilot/run-dry.mjs` (Skript, kein Handbetrieb).
Zweck: beweisen, dass Task-Ausführung → Outcome → vorregistrierte
Statistik-Pipeline (applyITT → Bootstrap-p → Holm → deterministische
Gates in `evaluateGate`) end-to-end MECHANISCH funktioniert.

## Protokoll-Hash (vor dem Lauf registriert)

- `protocol_hash`: `b92bcc5c6cdb29e7e09eff05b6f765fe46c6eca25233b6e4a0416399e61f74c7`
- Registrierung: neu geschrieben (seq 1) — Wegwerf-Ledger-DB, NICHT das Live-Ledger
- Idempotenz-Beweis (zweiter Aufruf): registered=false, already_registered=true

## Echte Verifier-Prozessläufe (3 Aufgaben, Stufen 1/3/5)

| Task | Stufe | Arm A (Fixture) | Arm B (Referenzlösung) | A ms | B ms |
|---|---|---|---|---|---|
| rr-01-module-graph | 1 | fail (exit 1) | pass (exit 0) | 52 | 53 |
| mfr-01-interval-overlap | 3 | fail (exit 1) | pass (exit 0) | 58 | 343 |
| rut-03-decompose-pipeline | 5 | fail (exit 1) | pass (exit 0) | 187 | 186 |

Erwartung erfüllt: Arm A überall fail = **true**, Arm B überall pass = **true**.

## Slot-Belegung für evaluateGate (mechanisch, deklariert)

| Protokoll-Slot | Belegung im Dry-Run |
|---|---|
| B | Arm A — unverändertes Fixture (Verifier muss fail) |
| C, D, E1, E2 | Arm B — Referenzlösungs-Overlay (Verifier muss pass); E2 mit Null-Toleranz-Zählern = 0 |
| tokens.B / tokens.D | Verifier-Laufzeit in ms als Zahlenstrom (kein Modell ⇒ keine Tokens; reiner Code-Pfad-Beweis) |

## Ergebnis der vorregistrierten Pipeline (evaluateGate)

- Familie: C_vs_B, D_vs_C, E1_vs_C, E2_vs_C · family_alpha 0.05 · resamples 10000 · seed 1

| Vergleich | Punktschätzer | roh p | Holm p | bestanden |
|---|---|---|---|---|
| C_vs_B | 1.0000 | 0.000100 | 0.000400 | true |
| D_vs_C | 0.0000 | 1.000000 | 1.000000 | false |
| E1_vs_C | 0.0000 | 0.000100 | 0.000400 | true |
| E2_vs_C | 0.0000 | 0.000100 | 0.000400 | true |

- Kosten-Gate (Laufzeit-ms-Stand-in): median(D)=186 ≤ 3·median(B)=175 → false
- Gesamtverdict: **false**

Mechanisch erwartet und korrekt: C_vs_B wird abgelehnt (Differenz +1 je
Task), D_vs_C NICHT (identische Slot-Belegung ⇒ Differenz 0 an Grenze 0 ⇒
p = 1), Gesamtverdict false. Ein "pass" wäre hier ein Pipeline-Bug —
dieses Verdict ist der Funktionsbeweis, keine Messaussage.
