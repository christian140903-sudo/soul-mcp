// Soul 4.0 Phase 1A — Vertragstests für SignedPackEnvelope@1 (DECISIONS F10).
// NUR der Vertrag: keine Krypto-Implementierung — Signaturprüfung, Keyring,
// TOFU-Pinning und Revocation kommen in Phase 3 mit der Registry
// (VOR erster Fremd-Pack-Annahme). Trust-Root-Design: design/SIGNED-PACK-TRUST.md.
// Hinweis: Das Golden-Beispiel trägt eine ECHTE Ed25519-Signatur über den
// kanonischen Signing-Header (der skills-Section-Hash deckt das
// SkillManifest@1-Golden-Beispiel) — nachrechenbar, aber hier nicht geprüft.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import AjvModule from 'ajv/dist/2020.js';

const Ajv2020 = AjvModule.default ?? AjvModule;
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });

const schemaPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', 'design', 'contracts', 'SignedPackEnvelope@1.schema.json'
);
const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
const validate = ajv.compile(schema);

function mutated(fn) {
  const doc = structuredClone(schema.examples[0]);
  fn(doc);
  return doc;
}

function assertValid(doc, label) {
  const ok = validate(doc);
  assert.ok(ok, `SignedPackEnvelope@1 ${label} should be VALID, errors: ${JSON.stringify(validate.errors)}`);
}

function assertInvalid(doc, label) {
  const ok = validate(doc);
  assert.equal(ok, false, `SignedPackEnvelope@1 ${label} should be INVALID but validated`);
}

test('SignedPackEnvelope@1: golden example validates', () => {
  assertValid(schema.examples[0], 'golden example');
});

test('SignedPackEnvelope@1: missing signature is invalid (unsignierte Packs gibt es nicht — Authentizität ist der Existenzgrund des Envelopes, TB3/R3)', () => {
  assertInvalid(mutated((d) => { delete d.signature; }), 'no signature');
});

test('SignedPackEnvelope@1: algo "rsa" is invalid (genau EIN Algorithmus, keine Downgrade-Angriffsfläche)', () => {
  assertInvalid(mutated((d) => { d.publisher.algo = 'rsa'; }), 'algo rsa');
});

test('SignedPackEnvelope@1: section without hash is invalid (F01-Tupel: jede Sektion trägt ihren SHA-256)', () => {
  assertInvalid(mutated((d) => { delete d.sections[0].hash; }), 'section w/o hash');
});

test('SignedPackEnvelope@1: additional top-level field is invalid (alles außerhalb des Vertrags ist invalid, nicht "verdächtig")', () => {
  assertInvalid(mutated((d) => { d.trusted = true; }), 'extra top-level field');
});

test('SignedPackEnvelope@1: hash without sha256-prefix / wrong format is invalid', () => {
  assertInvalid(mutated((d) => { d.sections[1].hash = 'bdadd2a9d824e8935db6c7d5324c377a'; }), 'bare hash');
  assertInvalid(mutated((d) => { d.publisher.key_id = 'md5:bdadd2a9d824e8935db6c7d5324c377a'; }), 'md5 key_id');
});

test('SignedPackEnvelope@1: non-semver pack_version is invalid (Downgrade-Schutz braucht vergleichbare Versionen, TRUST §3)', () => {
  assertInvalid(mutated((d) => { d.pack_version = 'latest'; }), 'pack_version latest');
});

test('SignedPackEnvelope@1: empty sections list is invalid (ein Pack ohne Inhalt ist kein Pack)', () => {
  assertInvalid(mutated((d) => { d.sections = []; }), 'no sections');
});

// ---------- Section-Grammatik (F07): dokumentierte Reader-Refuse-Fälle ------
//
// JSON Schema kann Eindeutigkeit über Objektfelder ((name,version)-Tupel) und
// eine Sortier-Ordnung NICHT ausdrücken — beide Fixtures unten sind deshalb
// schema-VALID, aber normativ vom Reader zu REFUSEN (fail-closed), BEVOR die
// Signatur geprüft wird. Normative Quelle: SIGNED-PACK-TRUST §2
// (Section-Grammatik) + die sections-description im Schema. Der Reader
// existiert erst als Phase-3-Code; diese Tests pinnen (a) die Fixtures, die
// seine Tamper-Suite refusen MUSS, und (b) die normative Dokumentation, damit
// sie nicht stillschweigend wegdriftet.

test('SignedPackEnvelope@1 F07: doppelte Section (gleiches name+version) — schema-valid, aber DOKUMENTIERTER Reader-Refuse-Fall', () => {
  // Fixture: dieselbe (name,version) zweimal — einmal mit abweichendem Hash.
  // Ein "nimm die erste"-Reader und ein "nimm die letzte"-Reader sähen unter
  // derselben Signatur verschiedene Inhalte. Der Phase-3-Reader MUSS refusen.
  const duplicate = mutated((d) => {
    d.sections = [
      { name: 'skills', version: '1', hash: 'sha256:bdadd2a9d824e8935db6c7d5324c377a1ef978a43374a2f409453bbefe4be191', required: true },
      { name: 'skills', version: '1', hash: 'sha256:ffb1e67eeda39429767f8398ab9809b5a81e689f4cec1808ff240f08128dbe1c', required: true },
    ];
  });
  assertValid(duplicate, 'duplicate section (JSON-Schema-Grenze — Reader-Refuse normativ)');
});

test('SignedPackEnvelope@1 F07: unsortierte Sections — schema-valid, aber DOKUMENTIERTER Reader-Refuse-Fall (nie stillschweigend re-sortieren)', () => {
  // Fixture: 'skills' vor 'docs' — verletzt die verbindliche
  // (name,version)-Sortierung. Der Reader refust statt zu normalisieren:
  // sonst wären zwei Byte-Darstellungen desselben signierten Headers beide
  // akzeptabel (Kanonisierungs-Mehrdeutigkeit = Angriffsfläche).
  const unsorted = mutated((d) => {
    d.sections = [d.sections[1], d.sections[0]];
  });
  assert.equal(unsorted.sections[0].name, 'skills', 'fixture is really unsorted');
  assert.equal(unsorted.sections[1].name, 'docs');
  assertValid(unsorted, 'unsorted sections (JSON-Schema-Grenze — Reader-Refuse normativ)');
});

test('SignedPackEnvelope@1 F07: die Section-Grammatik ist normativ dokumentiert (Schema-description + TRUST §2)', () => {
  const desc = schema.properties.sections.description;
  assert.ok(desc.includes('(name, version)'), 'Sortierung nach (name, version) steht in der sections-description');
  assert.ok(desc.toLowerCase().includes('duplikate'), 'Duplikat-Refuse steht in der sections-description');
  assert.ok(desc.includes('REFUSE'), 'refuse fail-closed ist ausdrücklich');
  const trust = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'design', 'SIGNED-PACK-TRUST.md'),
    'utf8'
  );
  assert.ok(trust.includes('Section-Grammatik'), 'TRUST.md trägt die normative Section-Grammatik');
  assert.ok(trust.includes('Duplikate sind zu refusen'), 'TRUST.md verbietet Duplikate normativ');
  assert.ok(trust.includes('Sortierung ist verbindlich'), 'TRUST.md macht die Sortierung verbindlich');
});
