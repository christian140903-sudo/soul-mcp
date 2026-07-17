# eval/tasks/ — Offenes Baseline-Aufgabenset (Phase 1B)

Dieses Verzeichnis ist das **offene** Baseline-Set der Soul-4.0-Eval
(SOUL4-PLAN Phase 1B: 20–30 hermetische Code-Aufgaben, klein, versioniert).
Es dient den Baseline-Messungen (Arme A/B), dem Varianz-Piloten (F15) und der
Entwicklung. Es ist **nie** ein konfirmatorisches Gate-Set — dafür gilt der
Held-out-Prozess unten (F08), dessen Sets hier bewusst NICHT liegen.

Herkunft der Regeln: `eval/protocol/EVAL-PROTOCOL.md` + `protocol.json`
(Preregistration als Code), `docs/SOUL4-DECISIONS.md` F04/F08,
`docs/THREAT-MODEL.md` TB7 + §5. Dieses Verzeichnis liegt **außerhalb** von
`eval/protocol/` und ändert den Protokoll-Hash nicht.

## Cluster-Struktur — die Code-Fähigkeitsleiter (F04)

Die Aufgaben sind exakt nach den 5 Stufen der Fähigkeitsleiter gruppiert.
Jede Stufe = ein Cluster-Verzeichnis; jeder Task ein Unterverzeichnis.
**Task = Analyseeinheit** (Task-Cluster im Sinn des Protokolls §2: pass@1 wird
task-weise aggregiert, Läufe sind im Task genestet).

| Stufe | Cluster | misst |
|---|---|---|
| 1 | `repo-recon` | Struktur + Tests erfassen → strukturierter Report |
| 2 | `failing-test-diagnosis` | Symptom → belegte Defekt-Diagnose (ohne Fix) |
| 3 | `minimal-fix-with-regression-test` | minimaler Fix + Test, der vorher rot war |
| 4 | `contract-review` | Änderung gegen explizite Verträge prüfen |
| 5 | `refactor-under-tests` | Verhalten konstant, Struktur messbar besser |

## Aufbau eines Tasks

```
eval/tasks/<cluster>/<task-id>/
  task.json      # Beschreibung, Stufe, erwartete Artefakte, Budget, task_slice
  fixture/       # das Start-Arbeitsverzeichnis des Runners (in sich geschlossen)
  verifier.mjs   # deterministischer Grader (Exit 0 = pass)
  solution/      # Referenzlösung als Overlay (NUR für Meta-Tests, nie für Runner)
```

### task.json (`EvalTask@1`, einheitlich, von test/eval-tasks.test.mjs erzwungen)

| Feld | Bedeutung |
|---|---|
| `task_schema` | konstant `"EvalTask@1"` |
| `task_id` | = Verzeichnisname, global eindeutig |
| `cluster` | = Eltern-Verzeichnis, eine der 5 Leiter-Stufen |
| `skill_stage` | 1–5, deterministisch aus dem Cluster |
| `title`, `description` | Auftrag an den Runner inkl. exakter Artefakt-Struktur |
| `task_slice` | `{kind, risk}` mit den Enums aus `Episode@1.schema.json` |
| `expected_artifacts` | Pfade + Art (`json`/`source`/`test`) der geforderten Ergebnisse |
| `budget_hint` | exakt die `budget`-Form aus `TaskContract@1` (`max_tokens`, `max_wall_clock_s`, `max_cost_eur`, `max_attempts`) |
| `verifier` | `{entry, invocation, pass_exit_code}` |
| `hermetic` | `{network:false, clock_dependency:false, machine_dependency:false}` — alle drei müssen false sein |
| `category_options` | (nur Stufe 2) die erlaubten Defekt-Kategorien, aus denen genau eine korrekt ist |

## Hermetik-Regeln (bindend)

1. **Kein Netz.** Fixtures und Verifier importieren nie `http(s)`/`net`/`dns`/
   `tls`/`undici` und rufen nie `fetch` auf. Statisch gelintet in
   `test/eval-tasks.test.mjs`.
2. **Keine Uhrzeit-Abhängigkeit.** Kein `Date.now`, `new Date(...)` oder Timer
   als Entscheidungsgrundlage in Verifiern. (Fixtures, die Zeit-APIs nur als
   *Review-Gegenstand* enthalten — z. B. eine Purity-Verletzung, die der Runner
   finden soll — werden nie ausgeführt.)
3. **Keine Maschinen-Abhängigkeit.** Verifier nutzen ausschließlich
   `process.execPath` (denselben Node), relative Pfade im Workdir und
   `os.tmpdir()` nur als Scratch. Kein `process.env`-Lesen in Verifiern;
   Kind-Prozesse (`node --test`) starten mit **leerem env** (`env: {}`) —
   sonst würde ein geerbter Test-Runner-Kontext (`NODE_TEST_CONTEXT`)
   Exit-Codes maskieren.
4. **Deterministische Verifier.** Kein `Math.random`. Gleicher Workdir-Inhalt
   ⇒ gleiches Verdict, auf jeder Maschine mit derselben Node-Major.
5. **Selbst-enthalten.** Jeder Verifier ist bewusst standalone (duplizierte
   Helfer statt shared import), damit ein Task einzeln kopierbar/pensionierbar
   bleibt (Set-Pensionierung, F08).

## Wie Läufe die Aufgaben konsumieren

1. Der Harness kopiert `fixture/` in ein frisches, isoliertes Workdir
   (attempt-scoped, TB8). Der Runner (Arm A: Modell roh, Arm B: + v3-Kapsel, …)
   erhält `description` aus `task.json` plus den Workdir-Inhalt — **nie**
   `verifier.mjs`, **nie** `solution/`.
2. Der Runner arbeitet im Budget (`budget_hint` → `TaskContract@1.budget`)
   und hinterlässt die `expected_artifacts` im Workdir.
3. Der Grader führt aus: `node <task>/verifier.mjs <workdir>` —
   Exit 0 = `pass`, alles andere = `fail`. Das Ergebnis wird als
   `VerifierResult@1` (`checks[]` aus den FAIL/ok-Zeilen, deterministisch)
   verbucht. Intention-to-treat gilt: Abbruch/Timeout/Fehler = Fehlschlag
   (Protokoll §2), pass@1 wird task-weise gemittelt.
4. Für dieses OFFENE Set gilt ehrlich: die Verifier enthalten die Ground
   Truth (bei Report-/Review-Aufgaben also die Antwort). Deshalb ist dieses
   Set für Entwicklung/Baseline brauchbar, aber als konfirmatorisches
   Gate-Set wertlos — dafür existiert der Held-out-Prozess.

## Referenzlösungen (`solution/`)

Jeder Task trägt eine Referenzlösung als **Overlay**: Meta-Tests kopieren
`fixture/` → Workdir, kopieren `solution/` darüber und erwarten Verifier-pass.
Zusätzlich wird bewiesen, dass das **unveränderte** Fixture den Verifier NICHT
besteht — sonst misst die Aufgabe nichts. Beide Beweise laufen für **alle**
Tasks in `test/eval-tasks.test.mjs` (End-to-End, echte Prozesse).

## Held-out-Prozess (F08) — dokumentiert, absichtlich NICHT angelegt

Das konfirmatorische Gegenstück zu diesem offenen Set entsteht so — und erst
dann, wenn die erste konfirmatorische Welle ansteht:

1. **Getrennte Generierung:** Ein separater Agent erzeugt Hidden-Varianten
   pro Cluster (gleiche Task-Form, andere Fixtures/Ground-Truth). Der
   Betreiber sieht bis nach dem Gate nur Metadaten (Cluster, Anzahl, Hashes).
2. **Two-Key:** Hidden-Verifier + Ground-Truth liegen `age`-verschlüsselt im
   Repo (`eval/hidden/…`, existiert absichtlich noch nicht); den Key besitzt
   ausschließlich der Grader-Prozess (Env-File außerhalb jedes
   Agent-/Optimierer-Kontexts). Runner erhalten nur öffentliche Fixtures.
3. **Taint:** Der Wrapper taintet jeden Lauf, dessen Prozess Key oder
   Klartext-Pfad je sah; Taint steht im Receipt; getaintete Läufe sind
   ungültig, die Welle wird verworfen — nicht bereinigt (Protokoll §2).
4. **Fixierung:** Manifeste + Splits werden VOR Gebrauch gehasht und
   committed (analog `eval/protocol/hash.mjs`-Disziplin).
5. **Pensionierung:** Nach jedem konfirmatorischen Gebrauch wandert das
   Gate-Set nach `eval/tasks/spent/` (bzw. `eval/hidden/spent/`); das nächste
   Gate zieht ein frisches Set.
6. **Restrisiko:** R7 (THREAT-MODEL) bleibt ehrlich deklariert — vollständige
   Selbst-Verblindung ist solo nicht erreichbar; Messaussagen tragen diesen
   Vorbehalt.

## Meta-Tests

`node --test test/eval-tasks.test.mjs` prüft: Schema-Konsistenz aller
`task.json`, Syntax jedes Verifiers (`node --check`), Hermetik-Lint
(statisch), Cluster-Zählung (20–30 gesamt, ≥4 pro Stufe), und die
End-to-End-Beweise (Referenzlösung pass / unverändertes Fixture fail) für
jeden Task.
