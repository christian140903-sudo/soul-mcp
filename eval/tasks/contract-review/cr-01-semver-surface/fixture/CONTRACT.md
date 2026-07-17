# API-Kompatibilitätsvertrag (Minor-Releases)

Diese Regeln gelten für jede Änderung, die als Minor-Release ausgeliefert wird.

- **R1 — Kein Export verschwindet.** Jeder in der Vorversion exportierte Name
  muss weiterhin exportiert werden.
- **R2 — Keine neuen Pflicht-Parameter.** Bestehende exportierte Funktionen
  dürfen keine neuen Parameter erhalten, deren Fehlen einen Fehler auslöst.
  Neue OPTIONALE Parameter (mit Default) sind erlaubt.
- **R3 — Rückgabeformen nur erweitern.** Felder in zurückgegebenen Objekten
  dürfen hinzukommen, aber nie entfernt oder umbenannt werden.

Neue Exports sind ausdrücklich erlaubt (additiv).
