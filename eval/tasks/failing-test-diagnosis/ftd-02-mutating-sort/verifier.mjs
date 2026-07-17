// Verifier ftd-02-mutating-sort — deterministisch, Exit 0 = pass.
// Aufruf: node verifier.mjs <workdir>
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const workdir = process.argv[2];
if (!workdir) { console.error("usage: node verifier.mjs <workdir>"); process.exit(2); }
const wd = resolve(workdir);

const fails = [];
function check(cond, msg) {
  if (cond) console.log("ok: " + msg);
  else { fails.push(msg); console.log("FAIL: " + msg); }
}
function normalize(v) {
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, normalize(v[k])]));
  }
  return v;
}
function deepEqual(a, b) {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}
function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const DEFECT_FILE = "lib/ranking.mjs";
const DEFECT_FUNCTION = "topScores";
const CATEGORY = "input_mutation";
const OBSERVED = "first_arg_after_call";
const DEFECT_FILE_SHA256 = "404ed0f1197931568a061c0581c8fcf2aca73e901360c31f975e2f7851a83d03";

check(existsSync(join(wd, DEFECT_FILE)) && sha256(join(wd, DEFECT_FILE)) === DEFECT_FILE_SHA256,
  "Fixture unveraendert (" + DEFECT_FILE + ") — Diagnose-Aufgabe, kein Fix");

const diagPath = join(wd, "artifact", "diagnosis.json");
check(existsSync(diagPath), "artifact/diagnosis.json existiert");
let diag = null;
if (existsSync(diagPath)) {
  try { diag = JSON.parse(readFileSync(diagPath, "utf8")); }
  catch (e) { check(false, "diagnosis.json ist valides JSON (" + e.message + ")"); }
}

if (diag && fails.length === 0) {
  check(diag.defect_file === DEFECT_FILE, "defect_file = " + DEFECT_FILE);
  check(diag.defect_function === DEFECT_FUNCTION, "defect_function = " + DEFECT_FUNCTION);
  check(diag.category === CATEGORY, "category = " + CATEGORY);
  const t = diag.trigger;
  check(t && Array.isArray(t.args), "trigger.args ist eine JSON-Argumentliste");
  check(t && t.observed === OBSERVED, "trigger.observed = " + OBSERVED);
  if (t && Array.isArray(t.args)) {
    try {
      const mod = await import(pathToFileURL(join(wd, DEFECT_FILE)).href);
      const fn = mod[DEFECT_FUNCTION];
      check(typeof fn === "function", "defekte Funktion importierbar");
      const liveArgs = JSON.parse(JSON.stringify(t.args));
      // Korrektes Verhalten: das erste Argument bleibt nach dem Aufruf unveraendert.
      const oracleObs = JSON.parse(JSON.stringify(t.args[0]));
      fn(...liveArgs);
      const actualObs = liveArgs[0];
      check(deepEqual(t.actual, actualObs), "trigger.actual entspricht dem realen (mutierten) Zustand");
      check(deepEqual(t.expected, oracleObs), "trigger.expected entspricht dem korrekten (unveraenderten) Zustand");
      check(!deepEqual(actualObs, oracleObs), "Trigger demonstriert die Mutation (actual != expected)");
    } catch (e) {
      check(false, "Trigger-Ausfuehrung ohne Fehler (" + e.message + ")");
    }
  }
}

if (fails.length) { console.log("VERDICT: fail (" + fails.length + ")"); process.exit(1); }
console.log("VERDICT: pass");
process.exit(0);
