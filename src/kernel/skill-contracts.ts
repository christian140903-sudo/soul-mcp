/**
 * Runtime copies of the two Phase-3 contract schemas.
 *
 * WHY a copy exists: the published npm package ships only dist/src (see
 * package.json files[]), so design/contracts/*.schema.json is not available
 * at runtime. These constants are byte-for-byte copies of the committed
 * schema files; test/skills.test.mjs asserts deep equality with the
 * design/contracts originals, so the copy cannot drift silently.
 *
 * GENERATED from design/contracts — edit the schema files, then regenerate.
 */

export const SKILL_MANIFEST_SCHEMA: Record<string, unknown> = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://nextool.app/soul/contracts/SkillManifest@1.schema.json",
  "title": "SkillManifest@1",
  "description": "Declarative-only (THREAT-MODEL TB5.1): ein Skill ist Daten, nie Code. Positiv-Grammatik statt Deny-Heuristik (DECISIONS F07): erlaubte Blöcke sind AUSSCHLIESSLICH steps, rubric, verifier_hints, context_recipe, io_schema, references — mit Längenlimits pro Feld; 'alles außerhalb der Grammatik ist invalid, nicht verdächtig'. Invariante (THREAT-MODEL §5.5): 'Skills sind untrusted data und können Tool-/Netz-/Dateirechte nie erweitern' (Monotonie-Gesetz F06/TB9) — deshalb existiert in diesem Schema strukturell KEIN Grant-/Capability-/Authority-Feld. URLs/Pfade nur in deklarierten Referenzfeldern, die NIE automatisch geladen werden. Ein Skill kann seine eigene Promotion nicht beeinflussen: Promotion-Logik liest Receipts/Evals, nie Skill-Text (TB5.5).",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "contract",
    "name",
    "version",
    "description",
    "lifecycle",
    "origin",
    "compatibility",
    "body"
  ],
  "properties": {
    "contract": {
      "const": "SkillManifest@1"
    },
    "name": {
      "type": "string",
      "pattern": "^[a-z0-9][a-z0-9-]{0,63}$"
    },
    "version": {
      "$ref": "#/$defs/semver",
      "description": "Skill-SemVer; Dependencies/Konfliktauflösung/SemVer-Regeln werden in Phase 3 spezifiziert (DECISIONS F10)."
    },
    "description": {
      "type": "string",
      "minLength": 1,
      "maxLength": 500
    },
    "lifecycle": {
      "enum": [
        "shadow",
        "canary",
        "promoted",
        "deprecated",
        "revoked"
      ],
      "description": "Lifecycle Shadow→Canary→Promoted→Deprecated→Revoked (SOUL4-PLAN Phase 3). Importierte Skills starten IMMER als shadow — nie direkt promoted (TB5.4). Shadow-Skills werden ausschließlich in isolierten Eval-/Canary-Runs exponiert, nie in normalen Kapseln (TB5.3/F07)."
    },
    "origin": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "type"
      ],
      "properties": {
        "type": {
          "enum": [
            "local",
            "imported",
            "pack"
          ]
        },
        "pack_signature": {
          "type": "string",
          "maxLength": 500,
          "description": "Signatur gemäß SignedPackEnvelope (Spez 1A, Implementierung Phase 3 VOR erster Fremd-Pack-Annahme, F10)."
        },
        "imported_at": {
          "$ref": "#/$defs/isoDateTime"
        }
      },
      "description": "Herkunft am Skill sichtbar: local / imported / pack+Signatur ab Phase 3+ (TB5.4)."
    },
    "compatibility": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "models"
      ],
      "properties": {
        "models": {
          "type": "array",
          "minItems": 1,
          "maxItems": 20,
          "items": {
            "type": "string",
            "maxLength": 100
          }
        },
        "os": {
          "type": "array",
          "maxItems": 10,
          "items": {
            "type": "string",
            "maxLength": 50
          }
        },
        "required_tools": {
          "type": "array",
          "maxItems": 20,
          "items": {
            "type": "string",
            "maxLength": 200
          }
        },
        "min_context_tokens": {
          "type": "integer",
          "minimum": 0
        }
      },
      "description": "Compatibility Vector (Modell, OS, Tools, Kontextbudget — SOUL4-PLAN Phase 3). required_tools ist eine ANFORDERUNGS-Deklaration an die Umgebung, nie ein Grant (Monotonie-Gesetz)."
    },
    "environment_fingerprint": {
      "type": "string",
      "maxLength": 200,
      "description": "Environment-Fingerprint je Messung (SOUL4-PLAN Phase 3)."
    },
    "dependencies": {
      "type": "array",
      "maxItems": 10,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "name",
          "version_range"
        ],
        "properties": {
          "name": {
            "type": "string",
            "pattern": "^[a-z0-9][a-z0-9-]{0,63}$"
          },
          "version_range": {
            "type": "string",
            "maxLength": 50
          }
        }
      },
      "description": "Platzhalter — Skill-Dependencies + Konfliktauflösung werden erst in Phase 3 spezifiziert (F10); bis dahin leer lassen."
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "steps"
      ],
      "properties": {
        "steps": {
          "type": "array",
          "minItems": 1,
          "maxItems": 20,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "id",
              "instruction"
            ],
            "properties": {
              "id": {
                "$ref": "#/$defs/id"
              },
              "instruction": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              }
            }
          }
        },
        "rubric": {
          "type": "array",
          "maxItems": 10,
          "items": {
            "type": "string",
            "maxLength": 500
          }
        },
        "verifier_hints": {
          "type": "array",
          "maxItems": 10,
          "items": {
            "type": "string",
            "maxLength": 500
          }
        },
        "context_recipe": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "memory_types": {
              "type": "array",
              "maxItems": 10,
              "items": {
                "type": "string",
                "maxLength": 50
              }
            },
            "token_budget": {
              "type": "integer",
              "minimum": 0
            }
          }
        },
        "io_schema": {
          "type": "object",
          "description": "JSON-Schema der erwarteten Artefakte — Grundlage der deterministischen Teilverifikation der Fähigkeitsleiter (DECISIONS F04)."
        },
        "references": {
          "type": "array",
          "maxItems": 10,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "label",
              "target"
            ],
            "properties": {
              "label": {
                "type": "string",
                "minLength": 1,
                "maxLength": 100
              },
              "target": {
                "type": "string",
                "minLength": 1,
                "maxLength": 500
              },
              "note": {
                "type": "string",
                "maxLength": 300
              }
            }
          },
          "description": "Deklarierte Referenzfelder — werden NIE automatisch geladen (F07/TB5.2). Ein Zugriff erfolgt nur innerhalb des AuthorityEnvelope-Scopes des jeweiligen Runs."
        }
      },
      "description": "Die Positiv-Grammatik (F07). Jeder Block außerhalb von steps/rubric/verifier_hints/context_recipe/io_schema/references macht das Manifest invalid."
    },
    "created_at": {
      "$ref": "#/$defs/isoDateTime"
    }
  },
  "$defs": {
    "id": {
      "type": "string",
      "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
    },
    "semver": {
      "type": "string",
      "pattern": "^\\d+\\.\\d+\\.\\d+(-[0-9A-Za-z.-]+)?$"
    },
    "isoDateTime": {
      "type": "string",
      "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})$"
    }
  },
  "examples": [
    {
      "contract": "SkillManifest@1",
      "name": "minimal-fix-with-regression-test",
      "version": "1.0.0",
      "description": "Stufe 3 der Code-Fähigkeitsleiter (F04): minimaler Fix plus Regression-Test, der vorher rot war.",
      "lifecycle": "shadow",
      "origin": {
        "type": "local"
      },
      "compatibility": {
        "models": [
          "claude-*"
        ],
        "os": [
          "darwin",
          "linux"
        ],
        "required_tools": [
          "bash:npm-test"
        ],
        "min_context_tokens": 30000
      },
      "body": {
        "steps": [
          {
            "id": "s1",
            "instruction": "Reproduziere den roten Test lokal; halte die exakte Fehlermeldung fest."
          },
          {
            "id": "s2",
            "instruction": "Schreibe zuerst den Regression-Test, der das Fehlverhalten nachweist (muss rot sein)."
          },
          {
            "id": "s3",
            "instruction": "Implementiere den minimalen Fix; keine Drive-by-Refactorings."
          },
          {
            "id": "s4",
            "instruction": "Führe die volle Suite aus; alle Tests müssen grün sein."
          }
        ],
        "rubric": [
          "Regression-Test war vor dem Fix nachweislich rot",
          "Diff enthält keine Änderungen außerhalb des Fehlerpfads"
        ],
        "verifier_hints": [
          "node --test Exit-Code",
          "git diff --stat gegen Scope prüfen"
        ],
        "context_recipe": {
          "memory_types": [
            "error",
            "solution"
          ],
          "token_budget": 2000
        },
        "io_schema": {
          "type": "object",
          "required": [
            "fixed_files",
            "regression_test"
          ]
        },
        "references": [
          {
            "label": "Testkonventionen",
            "target": "docs/API-MATRIX.md",
            "note": "wird nie automatisch geladen"
          }
        ]
      },
      "created_at": "2026-07-16T12:00:00Z"
    }
  ]
} as Record<string, unknown>;

export const SIGNED_PACK_ENVELOPE_SCHEMA: Record<string, unknown> = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://nextool.app/soul/contracts/SignedPackEnvelope@1.schema.json",
  "title": "SignedPackEnvelope@1",
  "description": "Authentizitäts-Hülle für Skill-Packs (DECISIONS F10, THREAT-MODEL TB3/R3: 'Checksum ist Integrität, NICHT Authentizität'). Sektionen-Tupel-Prinzip von F01 wiederverwendet: jede Sektion ist ein (name,version)-Tupel mit eigenem SHA-256 über ihren kanonischen JSON-Inhalt; signiert wird der KANONISCHE SIGNING-HEADER (pack_name, pack_version, publisher, sections, created_at, min_soul_version — rekursiv sortierte Keys, UTF-8, sections VERBINDLICH nach (name,version) sortiert und duplikatfrei, F07/TRUST §2), NICHT die Roh-Bytes der Payloads. Trust-Anchor ist der Publisher-Ed25519-Key (key_id = SHA-256-Fingerprint der rohen Pubkey-Bytes); unbekannter Key ⇒ refuse fail-closed; Key-Pinning per TOFU + empfohlene Fingerprint-Verifikation; Downgrade-Schutz: monotone pack_version pro (publisher.key_id, pack_name); Revocation als publisher-signierte Deny-Liste. Vollständiges Trust-Root-Design: design/SIGNED-PACK-TRUST.md. Importierte Pack-Skills starten IMMER als shadow (TB5.4). Spez 1A — Implementierung Phase 3 VOR erster Fremd-Pack-Annahme; bis dahin: keine fremden Packs importieren.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "contract",
    "pack_name",
    "pack_version",
    "publisher",
    "sections",
    "signature",
    "created_at",
    "min_soul_version"
  ],
  "properties": {
    "contract": {
      "const": "SignedPackEnvelope@1"
    },
    "pack_name": {
      "type": "string",
      "pattern": "^[a-z0-9][a-z0-9-]{0,63}$",
      "description": "Teil des Downgrade-Schutz-Schlüssels (publisher.key_id, pack_name) — liegt deshalb UNTER der Signatur (SIGNED-PACK-TRUST §2/§3)."
    },
    "pack_version": {
      "$ref": "#/$defs/semver",
      "description": "Monoton pro (publisher.key_id, pack_name): gleiche oder niedrigere Version als der gepinnte Stand ⇒ refuse (SIGNED-PACK-TRUST §3). Liegt unter der Signatur — sonst wäre Replay einer alt-signierten Section-Liste unter neuer Version möglich."
    },
    "publisher": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "key_id",
        "algo",
        "pubkey"
      ],
      "properties": {
        "key_id": {
          "type": "string",
          "pattern": "^sha256:[0-9a-f]{64}$",
          "description": "SHA-256-Fingerprint der rohen 32 Pubkey-Bytes — die out-of-band vergleichbare Kurzform (empfohlener Verifikationspfad statt reinem TOFU)."
        },
        "algo": {
          "const": "ed25519",
          "description": "Genau EIN Algorithmus. Kein Algorithmus-Agilitäts-Feld — ein zweiter Wert wäre eine Downgrade-Angriffsfläche; ein Wechsel ist ein neuer Contract-Major."
        },
        "pubkey": {
          "type": "string",
          "pattern": "^ed25519:[A-Za-z0-9+/]{43}=$",
          "description": "Roher 32-Byte-Ed25519-Pubkey, base64. Der Key im Envelope ist nur Transport — Vertrauen entsteht AUSSCHLIESSLICH durch Abgleich mit dem lokal gepinnten Keyring-Eintrag; unbekannter Key ⇒ refuse, fail-closed (SIGNED-PACK-TRUST §1)."
        }
      },
      "description": "Publisher-Key als Trust-Anchor. Keine zentrale PKI, keine Delegation, keine Multi-Sig (bewusst NICHT gebaut in 4.0 — SIGNED-PACK-TRUST §6)."
    },
    "sections": {
      "type": "array",
      "minItems": 1,
      "maxItems": 20,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "name",
          "version",
          "hash",
          "required"
        ],
        "properties": {
          "name": {
            "type": "string",
            "pattern": "^[a-z0-9][a-z0-9_-]{0,63}$"
          },
          "version": {
            "type": "string",
            "minLength": 1,
            "maxLength": 20
          },
          "hash": {
            "type": "string",
            "pattern": "^sha256:[0-9a-f]{64}$",
            "description": "SHA-256 über den kanonischen JSON-Inhalt der Sektion (F01-Tupel-Prinzip)."
          },
          "required": {
            "type": "boolean",
            "description": "Reader-Regel wie PassportEnvelope@3 (F01): unbekannte Sektion mit required:true ⇒ refuse fail-closed; unbekannte optionale Sektion ⇒ überspringen, ihr Hash bleibt in der signierten Liste beweisbar."
          }
        }
      },
      "description": "Section-Grammatik (F07, normativ — Reader-Pflicht in SIGNED-PACK-TRUST §2, im Schema dokumentiert weil JSON Schema Eindeutigkeit/Ordnung über Objektfelder nicht ausdrücken kann): (1) VERBINDLICH sortiert nach dem Tupel (name, version) aufsteigend — ein Envelope mit unsortierter Liste ist zu REFUSEN, nie stillschweigend zu normalisieren (zwei Byte-Darstellungen desselben signierten Inhalts wären sonst beide akzeptabel — Mehrdeutigkeit ist Angriffsfläche). (2) Duplikate — zwei Sections mit gleichem (name, version) — sind zu REFUSEN, fail-closed (ein Reader, der 'die erste nimmt', und einer, der 'die letzte nimmt', sähen verschiedene Inhalte unter derselben Signatur). Beides enforced der Phase-3-Reader VOR der Signaturprüfung. DIES ist die Liste, die — als Teil des Signing-Headers — unter der Signatur liegt."
    },
    "signature": {
      "type": "string",
      "pattern": "^ed25519:[A-Za-z0-9+/]{86}==$",
      "description": "64-Byte-Ed25519-Signatur (base64) über den kanonischen Signing-Header: canonical({pack_name, pack_version, publisher, sections, created_at, min_soul_version}) — rekursiv sortierte Keys, UTF-8, sections VERBINDLICH nach (name, version) sortiert und duplikatfrei (Kanonisierung wie PassportEnvelope@3, DECISIONS Anhang A; Section-Grammatik F07 / TRUST §2). NICHT über Roh-Bytes: Section-Inhalte sind via sections[].hash gebunden."
    },
    "created_at": {
      "$ref": "#/$defs/isoDateTime"
    },
    "min_soul_version": {
      "$ref": "#/$defs/semver",
      "description": "Mindest-Soul-Version des Lesers. Liegt unter der Signatur, damit ein Angreifer die Kompatibilitätsanforderung nicht abschwächen kann."
    }
  },
  "$defs": {
    "semver": {
      "type": "string",
      "pattern": "^\\d+\\.\\d+\\.\\d+(-[0-9A-Za-z.-]+)?$"
    },
    "isoDateTime": {
      "type": "string",
      "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})$"
    }
  },
  "examples": [
    {
      "contract": "SignedPackEnvelope@1",
      "pack_name": "code-ladder-fixes",
      "pack_version": "1.0.0",
      "publisher": {
        "key_id": "sha256:3ce1df99c8463c2921b1f2bd74cb3ec1cd101520131f60b8a3d9b861f3452db8",
        "algo": "ed25519",
        "pubkey": "ed25519:PzVsO31KfyhSPQB3hAl4PRBpKjnF8Uwnh5q7dJCFQzs="
      },
      "sections": [
        {
          "name": "docs",
          "version": "1",
          "hash": "sha256:ffb1e67eeda39429767f8398ab9809b5a81e689f4cec1808ff240f08128dbe1c",
          "required": false
        },
        {
          "name": "skills",
          "version": "1",
          "hash": "sha256:bdadd2a9d824e8935db6c7d5324c377a1ef978a43374a2f409453bbefe4be191",
          "required": true
        }
      ],
      "created_at": "2026-07-16T12:00:00Z",
      "min_soul_version": "4.0.0",
      "signature": "ed25519:zSU7rXnDX+zKekHJhiW9mQ7RNo3qfKNxN5LBll3jxkea39izRktLj8obFHPqQHpooWLTbIpuKYua6+8uPJaCAA=="
    }
  ]
} as Record<string, unknown>;
