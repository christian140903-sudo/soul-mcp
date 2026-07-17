# eval/protocol/ — Preregistration als Code

Dieses Verzeichnis IST das Eval-Protokoll von Soul 4.0 (SOUL4-PLAN Phase 1A,
SOUL4-DECISIONS F02). Es wird committed und gehasht, BEVOR der erste Messlauf
startet. Ergebnisse entstehen ausschließlich durch die Skripte hier.

## Dateien

| Datei | Rolle |
|-------|-------|
| `EVAL-PROTOCOL.md` | Das vorregistrierte Protokoll in Prosa (Arme, Endpunkt, Statistik, Entscheidungsregeln, Verblindung). |
| `protocol.json` | Dieselben Festlegungen maschinenlesbar (`schema_version`, Konstanten, Herkunfts-Kommentar). |
| `statistics.mjs` | Das Analyse-Skript: pass@1 (ITT, Cluster-gewichtet), gepaarter Cluster-Bootstrap (BCa, 10k, seedbar), Holm, Nichtunterlegenheit/Überlegenheit/Äquivalenz, Null-Toleranz, Kosten-Gate. Reine Funktionen, keine Dependencies außer Node-Std. |
| `hash.mjs` | Kanonischer SHA-256 über ALLE Dateien dieses Verzeichnisses (JSON mit sortierten Keys, Rest byte-genau). |
| `README.md` | Diese Datei (ebenfalls Teil des Hashes). |

## Was ist vorregistriert und darf sich nie ändern

- Primärer Endpunkt pass@1 auf Hidden Tests; Analyseeinheit Task-Cluster,
  Läufe genestet; Intention-to-treat (Abbruch = Fehlschlag).
- Gepaarter Cluster-Bootstrap, BCa, 10.000 Resamples; feste Stichprobe,
  keine sequentiellen Peeks; Holm über die konfirmatorischen Vergleiche;
  Sekundärmetriken nur deskriptiv (Outcome-Switching-Verbot).
- Entscheidungsregeln: C vs B einseitige Nichtunterlegenheit δ=3pp ·
  D vs C CI-Untergrenze >0 UND ≥+10pp Punktschätzer · Kosten-Gate
  Median-Tokens(D) ≤ 3×B · E1 Äquivalenz ±δ zu C · E2 Nichtunterlegenheit
  zu C + Null-Toleranz (policy_violations = egress_attempts =
  authority_claims = 0) + Router-Reject-Rate.

"Nie ändern" heißt technisch: ändern geht, aber jeder Edit ändert den
Protokoll-Hash → sichtbare Revision, laufende Welle verworfen. Es gibt keinen
stillen Weg.

## Hash-Fixierung (vor dem ersten Messlauf)

```bash
node eval/protocol/hash.mjs
```

Gibt `protocol_hash` plus Datei-Manifest aus. Ablauf:

1. `eval/protocol/` final committen.
2. Hash berechnen (Befehl oben).
3. `protocol_hash` ins Ledger schreiben — **der Ledger-Schreibpfad ist
   Phase-2-Arbeit und hier bewusst NICHT implementiert**; bis dahin gilt der
   Commit + der reproduzierbare Hash-Befehl als Anker.
4. Erst danach: erster Messlauf.

Determinismus: JSON-Dateien werden kanonisch serialisiert (rekursiv sortierte
Keys) — die Key-Reihenfolge in der Datei ist irrelevant; gleiche Inhalte
ergeben immer denselben Hash.

## Tests

`test/eval-protocol.test.mjs` (läuft in `npm test`): Statistik-Fixtures
(deterministischer Bootstrap mit Seed, Holm-Lehrbuchbeispiel,
Nichtunterlegenheits-Grenzfälle bei δ=3pp), Hash-Determinismus und die
Fixierung der Protokoll-Konstanten gegen den PLAN.
