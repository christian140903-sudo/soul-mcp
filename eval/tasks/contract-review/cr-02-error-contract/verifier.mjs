// Verifier cr-02-error-contract — deterministisch, Exit 0 = pass.
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

const EXPECTED_VIOLATIONS = [
  { rule: "R1", symbol: "readUser" },
  { rule: "R2", symbol: "saveUser" },
  { rule: "R3", symbol: "deleteUser" }
];
const EXPECTED_VERDICT = "reject";
const LOCKED = {
  "CONTRACT.md": "b9a6f7dca5d48d681f81f0e29cd415e6b74965efab377d3c48d6032290a20024",
  "errors.mjs": "388a8928e3594c9520ed38e74eda199a41b3bb74c87610ded941d4cf36dbd663",
  "original/users.mjs": "207499c88f2baa63887f5f2240b1efd807ed8d58106157d17f433b8868d5c10c",
  "proposed/users.mjs": "b9f0085db4fbd89af7b8fea2114edf82e0a0d28548296ad4b0f96713f9339174"
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
