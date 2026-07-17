# SignedPackEnvelope@1 — Trust-Root-Design (Phase-1A-Spez, F10)

> Schließt das TB3-Restrisiko R3: "Checksum ist Integrität, NICHT Authentizität."
> Dies ist die 1A-**Spezifikation**; Implementierung kommt in Phase 3 VOR der
> ersten Fremd-Pack-Annahme (SOUL4-PLAN Phase 3, DECISIONS F10). Bis dahin gilt
> unverändert: keine fremden Packs importieren.

## 1. Trust-Modell — ehrlich und minimal

Zielgruppe ist ein **Ein-Personen-Publisher** (Chriso/Miguel teilt Skill-Packs
mit sich selbst über Maschinen hinweg, später vielleicht mit wenigen Bekannten).
Deshalb:

- **Trust-Anchor = Publisher-Key.** Ein Ed25519-Schlüsselpaar pro Publisher.
  `key_id` ist der SHA-256-Fingerprint der rohen 32 Pubkey-Bytes — kurz,
  vergleichbar, fälschungsfest.
- **Keine zentrale PKI.** Es gibt keine CA, keinen Key-Server, kein Web of
  Trust. Wer das behauptet, würde performen — die Infrastruktur existiert nicht
  und wird für 4.0 nicht gebaut.
- **Key-Pinning beim ersten Import (TOFU):** Beim ersten Pack eines unbekannten
  Publishers wird der Key nach expliziter User-Bestätigung in den lokalen
  Keyring gepinnt (`verified: "tofu"`). **Empfohlener Pfad:** Fingerprint
  out-of-band prüfen (Publisher nennt seinen `key_id` über einen zweiten Kanal)
  → `verified: "fingerprint_verified"`. TOFU ist der ehrlich benannte
  Kompromiss, nicht der Goldstandard.
- **Unbekannter Key ⇒ refuse, fail-closed.** Kein Auto-Trust, kein "trotzdem
  importieren"-Default. Der Import bricht mit Fehlermeldung + Fingerprint ab;
  Pinnen ist eine separate, explizite User-Aktion (Ring 2: Chriso bestätigt).

## 2. Was ist signiert

Signiert wird der **kanonische Signing-Header**, NICHT die Roh-Bytes der
Section-Payloads:

```
sign_payload = canonical({ pack_name, pack_version, publisher, sections,
                           created_at, min_soul_version })
```

- Kanonisierung wie PassportEnvelope@3 (DECISIONS Anhang A): JSON mit rekursiv
  sortierten Keys, UTF-8; `sections` VERBINDLICH sortiert nach dem Tupel
  `(name, version)` aufsteigend (erst `name`, bei gleichem `name` nach
  `version`).
- **Section-Grammatik (F07, normative Reader-Pflichten — VOR der
  Signaturprüfung enforced, fail-closed):**
  1. **Sortierung ist verbindlich.** Ein Envelope, dessen `sections`-Array
     nicht nach `(name, version)` sortiert vorliegt, wird REFUSED — nie
     stillschweigend normalisiert. Würde der Reader unsortierte Eingaben
     re-sortieren, wären zwei verschiedene Byte-Darstellungen desselben
     signierten Headers beide akzeptabel; diese Mehrdeutigkeit ist
     Angriffsfläche (Kanonisierungs-Diffusion).
  2. **Duplikate sind zu refusen.** Zwei Sections mit gleichem
     `(name, version)` — auch mit identischem Hash — machen den Envelope
     ungültig: ein Reader, der "die erste nimmt", und einer, der "die letzte
     nimmt", sähen unter derselben Signatur verschiedene Inhalte.
  3. JSON Schema kann Eindeutigkeit und Ordnung über Objektfelder nicht
     ausdrücken (`uniqueItems` prüft nur ganze Objekte, keine Tupel-Schlüssel;
     eine Ordnungsrelation ist gar nicht formulierbar). Diese beiden Regeln
     sind deshalb HIER normativ und in der `sections`-description des Schemas
     dokumentiert; der Phase-3-Reader implementiert sie als ersten Check.
- Die Section-Inhalte sind über ihre `sha256`-Hashes in der signierten Liste
  gebunden (F01-Prinzip: (name, version)-Tupel + eigener Hash pro Sektion).
  Reader-Regel wie beim Passport: Section-Grammatik prüfen (oben) → Signatur
  verifizieren → Hashes aller BEKANNTEN Sektionen verifizieren → unbekannte
  Sektion mit `required:true` → refuse; unbekannte optionale Sektion →
  überspringen, Manipulation bleibt über den signierten Hash für jeden
  fähigeren Reader beweisbar.
- **Warum der ganze Header und nicht nur die Section-Liste:** Wäre nur die
  Liste signiert, ließe sich eine alte, gültig signierte Liste unter neuem
  `pack_version`/`pack_name` wiederverwenden (Replay/Umettikettierung).
  `pack_name`, `pack_version`, `created_at` und `min_soul_version` müssen
  unter der Signatur liegen, sonst ist der Downgrade-Schutz wertlos.

## 3. Downgrade-Schutz

Monotone Versionen pro `(publisher.key_id, pack_name)`: Der Keyring merkt sich
die höchste je importierte `pack_version` (semver). Ein Pack mit gleicher oder
niedrigerer Version als der gemerkte Stand wird refused (fail-closed) — ein
Angreifer mit einer alten, gültig signierten Pack-Datei kann keine gefixte
Version verdrängen. Re-Import derselben Version ist nur als expliziter,
geloggter User-Override möglich (M6-Bedienfehler vs. Replay unterscheidbar
im Ledger).

## 4. Revocation — signierte Deny-Liste

- Der Publisher kann eine **Revocation-Liste** veröffentlichen: Einträge
  `{pack_name, version_range}` oder `{key_id}` (Key-Selbst-Widerruf), signiert
  mit demselben Publisher-Key.
- Lokal: Datei im Keyring-Verzeichnis; wird bei JEDEM Pack-Import geprüft
  (revoked ⇒ refuse). Distribution der Liste ist manuell (Datei mitgeben) —
  es gibt keinen Online-Abruf, also auch keine Frische-Garantie. Das ist ein
  deklariertes Restrisiko, kein Kleingedrucktes: Revocation wirkt erst, wenn
  die Liste den Importeur erreicht hat.
- Revozierte Packs, die bereits importiert sind: Registry setzt die
  betroffenen Skills auf `revoked` (Lifecycle existiert in SkillManifest@1).

## 5. Keyring (lokale Spez)

`~/.soul/keyring.json` — Einträge:

```jsonc
{
  "publishers": [{
    "key_id": "sha256:…",              // Fingerprint der rohen Pubkey-Bytes
    "pubkey": "ed25519:<base64>",
    "verified": "tofu" | "fingerprint_verified",
    "pinned_at": "…",
    "packs": { "<pack_name>": { "highest_version": "1.2.0" } }  // Monotonie §3
  }],
  "revocations": [ /* signierte Deny-Listen-Einträge, §4 */ ]
}
```

**Rotation (minimal):** Ein neuer Key ist eine NEUE Trust-Entscheidung —
gleicher Ablauf wie Erst-Pinning (TOFU bzw. Fingerprint-Verifikation), alter
Key wird via Revocation-Eintrag stillgelegt. Ein kreuzsigniertes
Rotations-Statement ("alter Key beglaubigt neuen") ist als Ziel notiert,
wird in 4.0 aber NICHT gebaut.

## 6. Ziel vs. Ist — was 4.0 ausdrücklich NICHT baut

| Nicht gebaut | Warum ehrlich weggelassen |
|---|---|
| Key-Server / Verzeichnisdienst | Ein-Personen-Publisher; Infrastruktur ohne Nutzer wäre Theater. |
| Delegation / Sub-Keys | Kein Delegationsbedarf; jede Stufe wäre ungeprüfte Angriffsfläche. |
| Multi-Sig / Schwellensignaturen | Es gibt genau einen Signierenden. |
| Zentrale PKI / CA-Ketten | Behauptete Autorität ohne reale Instanz dahinter. |
| Online-Revocation / Transparency-Log | Keine Server-Komponente in Soul (local-first, THREAT-MODEL Scope). |
| Kreuzsignierte Key-Rotation | Ziel notiert (§5), nicht implementiert. |

Verbleibende Wahrheit: Dieses Design authentifiziert **"dasselbe Schlüsselpaar
wie beim Pinning"**, nicht eine reale Identität. Wer den ersten Import
kompromittiert (TOFU) oder den Rechner des Publishers besitzt, gewinnt —
Letzteres ist laut Threat Model ohnehin out of scope.

---
*Spez-Status: Phase 1A eingefroren mit SignedPackEnvelope@1.schema.json;
Implementierung + Tamper-/Revocation-Tests: Phase 3 (F10-Disposition).*
