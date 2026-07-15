# Restore-Probe (Phase-0-Deliverable) — 2026-07-16

**Ergebnis: PASS (16/16 Checks, Exit 0).** Der Backup→Restore-Pfad funktioniert
end-to-end auf der echten Live-Datenbank, inklusive Schema-Migration.

## Aufbau

Kopie der Live-DB (`~/.soul`, Schema v8, 51 Memories, 139 Events, WAL-sicher
via `VACUUM INTO` + `integrity_check`) → 3.2.0-Binary auf der Kopie gestartet
(Auto-Migration v8→v9 mit Backup) → `soul_export` → Import des Passports in
eine frische Soul (zweiter Serverprozess, leeres SOUL_DIR) → Re-Export →
Vergleich. Probe-Skript: MCP über stdio am echten Binary, keine Kernel-Shortcuts.

## Messwerte

| Bestand | Export A | nach Import in B |
|---|---|---|
| memories | 51 | 51 (0 skipped) |
| identity | 11 Facetten | 11 |
| goals | 6 | 6 |
| events | 139 | 139 |
| predictions | 3 | 3 |
| session_reflections | 0 | 0 |
| workbench_decisions | 0 | 0 |

ID-Mengen über alle Bestände identisch; Content- und source_type-Stichproben
identisch; Server A nach der v8→v9-Migration gesund.

## Befunde am Rand (kein Blocker)

1. **Ein `provenance_downgraded` beim Import** — das 3.2.0-Screening hat in
   der echten Live-DB genau ein `user_statement` ohne `source_ref` gefunden
   (`mem_0mrhy83g052539c25`, Patent-Stand vom 2026-07-12, erfasst vor dem
   v3.0.1-Provenienz-Guard). In der Restore-Kopie wird es ehrlich als
   `import` geführt. Heilung nur durch Chriso: `soul_confirm` mit
   `user_evidence` in der Live-Soul. Inhaltlich unstrittig.
2. **`session_reflections` ist in der Live-DB leer** — der laufende
   Live-Server war zum Probenzeitpunkt noch ein pre-3.1-Build bzw. Reflects
   liefen ohne summary. Erwartbar, aber erwähnenswert: das Diary-Feature
   greift erst, wenn der Live-Server auf ≥3.1 läuft.

## Einordnung

Damit ist von den Phase-0-Deliverables erledigt: Forensik-Audit (AUDIT-3.1.0.md),
P1/P2-Härtung (3.2.0), Client-Capability-Fakten (in SOUL4-VISION.md §Betriebsarten),
Restore-Probe (dieses Dokument). Offen: Threat Model, API-Matrix-Review.
