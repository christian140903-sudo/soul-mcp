# Performance-Baseline (lexikalischer Recall) — 2026-08-14

Lokale, einmalige Messung von `soul_recall`-Latenz (`recall()` in
`src/kernel/retrieval.ts`) über wachsende Korpusgrößen. Reproduzierbar via
`npm run perf-baseline` (Skript: `scripts/perf-baseline.mjs`).

**Kein Lasttest, keine Produktionsaussage.** Eine Maschine, ein Prozess,
keine Nebenlast, keine Wiederholungsläufe. Die Zahlen sind der eine
gemessene Lauf unten — kein Mittelwert über mehrere Durchläufe.

## Aufbau

- Wegwerf-`SOUL_DIR` (`mkdtempSync`), niemals `~/.soul`.
- Synthetischer Korpus, deterministisch (indexbasiert, kein RNG) —
  kumulativ über die drei Stufen 1.000 / 10.000 / 50.000 Memories (der
  Korpus wächst nur, wie eine echte Soul über die Zeit).
- Je Stufe 50 Queries mit garantiertem FTS-Treffer (Themenwörter, die im
  Korpus vorkommen) und 50 Queries ohne Treffer (Wörter, die nie vorkommen),
  je 5 ungemessene Warmup-Queries davor.
- `recall()` wird im echten Default-Modus aufgerufen (nicht `silent: true`)
  — bei Treffern läuft also auch der access_count-/Ledger-Event-Schreibpfad
  mit, wie bei einem echten `soul_recall`-Tool-Call.
- **Semantischer Layer ist AUS.** `soul-mcp semantic on` wird nie
  aufgerufen; das ~380-MB-Embedding-Modell wird weder heruntergeladen noch
  konfiguriert. Gemessen wird ausschließlich der lexikalische
  (FTS5-only-)Pfad.

## Maschine

| | |
|---|---|
| Chip | Apple M3 |
| RAM | 16 GB |
| OS | Darwin 25.2.0 (macOS) |
| Node | v25.9.0 |
| Soul | 4.0.1 |
| Datum | 2026-08-14 |

## Messwerte

| Korpus (kumulativ) | Insert-Dauer für diese Stufe | Insert/s | Recall p50/p95 — mit Treffer | Recall p50/p95 — ohne Treffer |
|---:|---:|---:|---:|---:|
| 1.000 | 2,0 s | 505 | 0,45 / 0,72 ms | 0,20 / 0,22 ms |
| 10.000 | 28,1 s (+9.000) | 321 | 0,82 / 2,08 ms | 1,37 / 2,10 ms |
| 50.000 | 192,7 s (+40.000) | 208 | 3,46 / 15,98 ms | 18,68 / 22,06 ms |

Rohdaten (Methodik-Metadaten inklusive): `docs/perf-baseline-results.json`.

## Einordnung

- Recall bleibt bei 50.000 Memories im einstelligen bis niedrigen
  zweistelligen Millisekundenbereich (p50 3,46 ms mit Treffer) — für den
  lexikalischen Pfad auf dieser Maschine unauffällig.
- Insert-Durchsatz sinkt mit wachsendem Korpus (505 → 321 → 208/s). Das ist
  erwartbares SQLite/WAL-Verhalten bei vielen kleinen Schreib-Transaktionen
  (FTS5-Trigger-Pflege, wachsendes WAL, Auto-Checkpoints) und keine
  Aussage über `recall()` selbst.
- **Auffällig, nicht erklärt:** Bei 50.000 Memories sind die
  "ohne Treffer"-Queries (p50 18,68 ms) langsamer als die
  "mit Treffer"-Queries (p50 3,46 ms) — kontraintuitiv, da eine
  FTS5-MATCH-Anfrage ohne Treffer über den invertierten Index eigentlich
  schneller entscheidbar sein sollte. Die Treffer-Gruppe läuft im Skript
  IMMER zuerst; ein plausibler, aber nicht verifizierter Verdacht ist ein
  Nachlaufeffekt aus deren Schreiblast (bis zu 500 zusätzliche
  access_count-/Ledger-Writes während der Treffer-Phase) auf die direkt
  danach gemessene Treffer-lose Phase — z. B. laufender WAL-Checkpoint. Nicht
  weiter isoliert; hier ehrlich als offener Befund vermerkt statt
  wegerklärt.
- Einzelmessung, keine Wiederholung — keine Varianz-/Konfidenzangabe
  möglich. Für eine belastbarere Aussage bräuchte es mehrere Läufe und im
  Idealfall eine Isolierung des oben genannten Nachlaufeffekts.

## Reproduktion

```bash
npm run perf-baseline
```

Baut zuerst (`npm run build`), dann Korpus + Messung. Schreibt
`docs/perf-baseline-results.json` neu (überschreibt die zuletzt committete
Version — der obige Lauf ist der Stand vom 2026-08-14).
