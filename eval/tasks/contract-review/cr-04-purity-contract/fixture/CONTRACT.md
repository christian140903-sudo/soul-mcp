# Purity-Vertrag (metrics-Modul)

Alle exportierten Funktionen dieses Moduls sind als PURE dokumentiert und
werden von Aufrufern entsprechend behandelt (Caching, Parallelisierung,
Replay). Für jede Änderung gilt:

- **R1 — Keine Argument-Mutation.** Übergebene Objekte/Arrays werden nie
  verändert (auch nicht sortiert).
- **R2 — Kein modulwelter veränderlicher Zustand.** Exportierte Funktionen
  lesen oder schreiben keinen veränderlichen Modul-Zustand (Caches, Zähler).
- **R3 — Gleiche Eingabe, gleiche Ausgabe.** Keine Uhrzeit, kein Zufall,
  keine sonstige umgebungsabhängige Quelle im Ergebnis.

Rein interne Umstellungen (z. B. andere Schleifenform) sind erlaubt.
