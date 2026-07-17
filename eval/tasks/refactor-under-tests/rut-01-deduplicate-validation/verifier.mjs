// Verifier rut-01-deduplicate-validation — deterministisch, Exit 0 = pass.
// Aufruf: node verifier.mjs <workdir>
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

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
function countTrimmedLine(source, marker) {
  return source.split("\n").filter((line) => line.trim() === marker).length;
}

const LIB = "lib/validate.mjs";
const LOCKED = {
  "test/validate.test.mjs": "e764e6eec2ce8aefaf4549c4430ba22f70575ce727ff1ea43484e9c9d1bfd434"
};
// Die charakteristischen Zeilen des duplizierten Basis-Blocks:
const MARKERS = [
  'if (typeof input.id !== "string" || input.id.trim() === "") {',
  'if (!Number.isInteger(input.revision) || input.revision < 0) {'
];

for (const [file, hash] of Object.entries(LOCKED)) {
  check(existsSync(join(wd, file)) && sha256(join(wd, file)) === hash, "unveraendert: " + file);
}
check(existsSync(join(wd, LIB)), LIB + " existiert");

if (existsSync(join(wd, LIB))) {
  const source = readFileSync(join(wd, LIB), "utf8");
  for (const marker of MARKERS) {
    const n = countTrimmedLine(source, marker);
    check(n <= 1, "Basis-Block dedupliziert (Zeile hoechstens 1x statt " + n + "x): " + marker.slice(0, 40) + "...");
  }
}

if (fails.length === 0) {
  // env: {} — kein geerbter Test-Runner-Kontext (NODE_TEST_CONTEXT wuerde Exit-Codes maskieren)
  const run = spawnSync(process.execPath, ["--test"], { cwd: wd, encoding: "utf8", env: {} });
  check(run.status === 0, "Testsuite gruen nach Refactor");

  try {
    const mod = await import(pathToFileURL(join(wd, LIB)).href);
    const names = Object.keys(mod).sort();
    check(JSON.stringify(names) === JSON.stringify(["validateOrder", "validateProduct", "validateUser"]),
      "Export-Oberflaeche exakt unveraendert (keine neuen Exports)");
  } catch (e) {
    check(false, "Modul importierbar (" + e.message + ")");
  }
}

if (fails.length) { console.log("VERDICT: fail (" + fails.length + ")"); process.exit(1); }
console.log("VERDICT: pass");
process.exit(0);
