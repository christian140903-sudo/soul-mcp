// Verifier cr-01-semver-surface — deterministisch, Exit 0 = pass.
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
  { rule: "R1", symbol: "toCsv" },
  { rule: "R2", symbol: "parseRow" }
];
const EXPECTED_VERDICT = "reject";
const LOCKED = {
  "CONTRACT.md": "f3caae13ea9e9fc409cdfde761e8e159a81c30138a50d353a05ada95d5467453",
  "original/rows.mjs": "62da9271fb5638f4fe5c32c9173a3a6c0d0020c840bbf380d415fd429754691a",
  "proposed/rows.mjs": "767c9eacd15e39f77a563fa0fe7b087a0dd2ab8e1f2ab655c6ef7f2d2cec159f"
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
