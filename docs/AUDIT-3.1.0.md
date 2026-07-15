# Forensik-Audit soul-mcp 3.1.0 (2026-07-16)

> Durchgeführt von einem isolierten Audit-Agenten (voller Kernel-Read, Tests als
> Verhaltens-Referenz). Jede von extern (GPT-Dump) behauptete Schwäche wurde
> verifiziert oder widerlegt, nichts ungeprüft übernommen.

## BEFUNDE

[P1] src/kernel/transfer.ts:207-222 — `importAll` umgeht die komplette Capture-Pipeline. Der v2-Import schreibt Memories per rohem `insertMem.run(...)` direkt in die Tabelle; detectSecret, detectInjection, classifySensitiveCategory und storeRuleFor laufen nie. Failure-Case: Ein Passport-JSON mit `status:'active'` und Injection-Content landet als normal recallbare aktive Memory. Der v1-Pfad (importV1Export) geht durch capture; die Asymmetrie ist im Test zementiert (transfer.test.mjs:163-166 prüft nur v1-Reject). Fix: Importierte Memories mit status IN ('active','confirmed') vor Live-Gang durch detectSecret/detectInjection (Secret → skip+Ledger, Injection → quarantined erzwingen).

[P1] src/kernel/transfer.ts:114-134 — Checksum-Mismatch blockiert Import nicht, Provenienz frei fälschbar. checksumValid nur Flag; Import läuft voll durch (server.ts:778-780 wertet nicht aus). source_type/sourceRef/status/id 1:1 übernommen → handgeschriebener Passport kann user_statement mit confidence 1.0 einschleusen; Constitution (store.X=never) wird umgangen. Fix: Bei checksumValid===false abbrechen (oder expliziter force-Pfad); importierte user_statement-Provenienz ohne verifizierbaren Beleg auf 'import' downgraden.

[P1] src/kernel/memory.ts:469-494 / src/kernel/db.ts:230-239 — `soul_forget` soft-delete lässt Inhalt im FTS-Index und in den Vektoren. status='deleted' reicht nicht: memories_au-Trigger reindexiert weiter, Vektor bleibt (nur hard-Pfad ruft deleteVector). FTS-Match/Semantic-Candidates feuern auf gelöschtem Content; memoriesAsOf/relatedMemories können ihn re-exponieren. Fix: Beim Soft-delete Vektor löschen und FTS-Eintrag per FTS-'delete'-Command entfernen.

[P2] src/kernel/context.ts:150-183 — disputed Memories mit vollem Content in der Kapsel (nur geflaggt); Garantie hängt an Modell-Disziplin, nicht Code. Fix: dokumentieren oder auf Konflikt-Notiz reduzieren.

[P2] src/kernel/context.ts:130 / src/kernel/memory.ts:125 — kein Cap auf einzelne Memory-Größe; Riesen-Memory frisst Kapsel-Budget, bläht DB/Vektoren. Fix: harte content-Grenze in capture (8-16 KB) mit Ledger-Vermerk.

[P2] src/kernel/policy.ts:168-177 — Secret-Regexes lückenhaft: AIza…, Bearer ohne JWT, 64-hex, "passwort lautet" matchen nicht. Fix: Patterns ergänzen.

[P2] src/kernel/retrieval.ts:161-166 — bm25-Normalisierung sättigt (|bm25|/10, clamp 1.0), kein deterministisches Tie-Breaking. Fix: min-max im Kandidatenset; Sekundärsort importance, dann id.

## GEPRÜFT & NICHT BESTÄTIGT

- Zwei-Prozess-Commit-Races: widerlegt (WAL+busy_timeout, tx.immediate() in commitDeliberation, Feedback-Übergänge idempotent).
- Freshness/Timezone/"same day": widerlegt — alles ms-genau UTC via nowIso(), lexikografisch konsistent.
- quarantined im Export als Leck: widerlegt — Export ist User-Backup by design; quarantined nie embedded/recalled.
- mark_useful ohne Ranking-Wirkung: widerlegt (useful_count → usage-Komponente, Gewicht 0.10/0.05).
- catch+ignore versteckt Schreibfehler: nein — nur embed-Backfill und FTS-Fallback, beides dokumentiert.
- SQL-Injection: widerlegt — durchgängig prepared statements, sanitizeFtsQuery.
- unbounded Growth: retrieval_impressions 90d gekappt; events append-only (gewollt, Skalierungspunkt für 4.0).

## GESAMTURTEIL

Fundament überdurchschnittlich solide: event-sourced, parametrisiert, Provenienz-Guards im Kernel, Migrationen transaktional. Scharfe Schwäche am Vertrauensrand: soul_import umgeht die gesamte Provenienz-/Secret-/Injection-Politik, soul_forget löscht weniger als versprochen. Architektur für 4.0 tragfähig — Import-Validierung und Lösch-Semantik müssen ZUERST geschlossen werden.
