# JSON-Format-Vertrag (serialisierte Events)

Konsumenten parsen das Format programmatisch. Für jede Änderung gilt:

- **R1 — Kein Feld verschwindet oder wird umbenannt.** Jedes Feld der
  Vorversion existiert unter demselben Namen weiter.
- **R2 — Kein Typwechsel.** Der JSON-Typ eines bestehenden Feldes
  (string/number/boolean/array/object) bleibt gleich.
- **R3 — Additionen nur mit stabilem Default.** Neue Felder sind erlaubt,
  wenn sie für jede Eingabe deterministisch belegt sind (z. B. leeres Array).
