// Verifier rr-03-env-surface — deterministisch, Exit 0 = pass.
// Aufruf: node verifier.mjs <workdir>
import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

const workdir = process.argv[2];
if (!workdir) { console.error("usage: node verifier.mjs <workdir>"); process.exit(2); }
const wd = resolve(workdir);

const fails = [];
function check(cond, msg) {
  if (cond) console.log("ok: " + msg);
  else { fails.push(msg); console.log("FAIL: " + msg); }
}
function normalize(v) {
  if (Array.isArray(v)) {
    return v.map(normalize).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  }
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, normalize(v[k])]));
  }
  return v;
}
function deepEqual(a, b) {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

const EXPECTED_ENV_KEYS = [
  { name: "PORT", required: false, default: "3000" },
  { name: "LOG_LEVEL", required: false, default: "info" },
  { name: "DATA_DIR", required: true, default: null },
  { name: "CACHE_TTL_S", required: false, default: "60" }
];

const reportPath = join(wd, "artifact", "report.json");
check(existsSync(reportPath), "artifact/report.json existiert");
let report = null;
if (existsSync(reportPath)) {
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch (e) {
    check(false, "artifact/report.json ist valides JSON (" + e.message + ")");
  }
}
if (report) {
  check(Array.isArray(report.env_keys), "env_keys ist eine Liste");
  check(deepEqual(report.env_keys, EXPECTED_ENV_KEYS), "env_keys vollstaendig und korrekt (name/required/default)");
}

if (fails.length) { console.log("VERDICT: fail (" + fails.length + ")"); process.exit(1); }
console.log("VERDICT: pass");
process.exit(0);
