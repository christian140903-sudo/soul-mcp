# Fehler-Vertrag

Alle exportierten Funktionen dieses Pakets müssen sich an diese Regeln halten:

- **R1 — Typisierte Fehler.** Jeder geworfene Fehler ist eine Instanz von
  `AppError` (aus `errors.mjs`). Nackte `Error`/`TypeError` sind verboten.
- **R2 — Stabile Fehler-Codes.** Jeder Fehler trägt ein `code`-Feld, dessen
  Wert in der Liste `CODES` (aus `errors.mjs`) enthalten ist.
- **R3 — Keine Eingabewerte in Fehlermeldungen.** Fehlermeldungen dürfen die
  rohen Eingabewerte (z. B. IDs, Namen) NICHT enthalten — sie landen in Logs.
  Eingaben gehören ausschließlich in strukturierte Felder, nie in `message`.
