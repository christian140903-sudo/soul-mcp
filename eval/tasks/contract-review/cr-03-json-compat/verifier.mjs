// Verifier cr-03-json-compat — deterministisch, Exit 0 = pass.
// Aufruf: node verifier.mjs <workdir>
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

// R1: created -> createdAt (Rename) · R2: id number -> string. tags mit Default [] ist per R3 erlaubt.
const EXPECTED_VIOLATIONS = [
  { rule: "R1", symbol: "serializeEvent" },
  { rule: "R2", symbol: "serializeEvent" }
];
const EXPECTED_VERDICT = "reject";
const LOCKED = {
  "CONTRACT.md": "e5b82ded8bc06ee5041ad59a348866b4f54d61ccc23783dcd0308c36be5da85b",
  "original/event.mjs": "6a7da51b236a943487fea31ed6058e4fb358f06a45871fd176801663a8eba915",
  "proposed/event.mjs": "3562efdb4b653e540da561542ce75efb21bfb3679e00843631052a6b3c421e36"
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
