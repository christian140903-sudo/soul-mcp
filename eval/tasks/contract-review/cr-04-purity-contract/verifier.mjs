// Verifier cr-04-purity-contract — deterministisch, Exit 0 = pass.
// Aufruf: node verifier.mjs <workdir>
// Hinweis: Das Date-now-Vorkommen ist Inhalt des GEPRUEFTEN Fixtures (proposed/),
// das nie ausgefuehrt wird — dieser Verifier selbst liest keine Uhr.
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";

const workdir = process.argv[2];
if (!workdir) { console.error("usage: node verifier.mjs <workdir>"); process.exit(2); }
const wd = resolve(workdir);

const fails = [];
function check(cond, msg) {
  if (cond) console.log("ok: " + msg);
  else { fails.push(msg); console.log("FAIL: " + msg); }
}
function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function pairSet(violations) {
  return violations.map((v) => String(v.rule) + "::" + String(v.symbol)).sort();
}

// R2: computeStats nutzt Modul-Cache · R1: topN sortiert das Argument in place ·
// R3: summarize haengt eine Uhrzeit ins Ergebnis.
const EXPECTED_VIOLATIONS = [
  { rule: "R1", symbol: "topN" },
  { rule: "R2", symbol: "computeStats" },
  { rule: "R3", symbol: "summarize" }
];
const EXPECTED_VERDICT = "reject";
const LOCKED = {
  "CONTRACT.md": "e349fb92224b2bdfff8fd5a789af8aae2c7e64bbdee0ccb2acbc51586cb140cf",
  "original/metrics.mjs": "ce0053198cdd69bafdb102ace1da45e5c599c83043e9ccfdec74c3a7661f667d",
  "proposed/metrics.mjs": "c6618e6bd8c4175526c23c7c477d9938aa16ad5c3bc74532899e2fbe4e2e52af"
};

for (const [file, hash] of Object.entries(LOCKED)) {
  check(existsSync(join(wd, file)) && sha256(join(wd, file)) === hash, "unveraendert: " + file);
}

const reviewPath = join(wd, "artifact", "review.json");
check(existsSync(reviewPath), "artifact/review.json existiert");
let review = null;
if (existsSync(reviewPath)) {
  try { review = JSON.parse(readFileSync(reviewPath, "utf8")); }
  catch (e) { check(false, "review.json ist valides JSON (" + e.message + ")"); }
}
if (review) {
  check(review.verdict === EXPECTED_VERDICT, "verdict = " + EXPECTED_VERDICT);
  check(Array.isArray(review.violations), "violations ist eine Liste");
  if (Array.isArray(review.violations)) {
    const got = pairSet(review.violations);
    const want = pairSet(EXPECTED_VIOLATIONS);
    check(JSON.stringify(got) === JSON.stringify(want),
      "Verletzungsliste exakt (keine fehlende, keine erfundene): " + want.join(", "));
  }
}

if (fails.length) { console.log("VERDICT: fail (" + fails.length + ")"); process.exit(1); }
console.log("VERDICT: pass");
process.exit(0);
