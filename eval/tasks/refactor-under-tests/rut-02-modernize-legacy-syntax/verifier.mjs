// Verifier rut-02-modernize-legacy-syntax — deterministisch, Exit 0 = pass.
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

const LIB = "lib/report.mjs";
const LOCKED = {
  "test/report.test.mjs": "57ca4645a777a15106d84d7ce7380b0a11a442669873f97bf7ce628061bf551e"
};

for (const [file, hash] of Object.entries(LOCKED)) {
  check(existsSync(join(wd, file)) && sha256(join(wd, file)) === hash, "unveraendert: " + file);
}
check(existsSync(join(wd, LIB)), LIB + " existiert");

if (existsSync(join(wd, LIB))) {
  const source = readFileSync(join(wd, LIB), "utf8");
  check(!/\bvar\b/.test(source), "keine var-Deklarationen mehr");
  check(!/\barguments\b/.test(source), "kein arguments-Objekt mehr");
}

if (fails.length === 0) {
  // env: {} — kein geerbter Test-Runner-Kontext (NODE_TEST_CONTEXT wuerde Exit-Codes maskieren)
  const run = spawnSync(process.execPath, ["--test"], { cwd: wd, encoding: "utf8", env: {} });
  check(run.status === 0, "Testsuite gruen nach Refactor");

  try {
    const mod = await import(pathToFileURL(join(wd, LIB)).href);
    const names = Object.keys(mod).sort();
    check(JSON.stringify(names) === JSON.stringify(["makeReport", "totalOf"]),
      "Export-Oberflaeche exakt unveraendert");
    check(typeof mod.totalOf === "function" && mod.totalOf(1, 2, 3, 4, 5) === 15,
      "totalOf bleibt variadisch");
  } catch (e) {
    check(false, "Modul importierbar (" + e.message + ")");
  }
}

if (fails.length) { console.log("VERDICT: fail (" + fails.length + ")"); process.exit(1); }
console.log("VERDICT: pass");
process.exit(0);
