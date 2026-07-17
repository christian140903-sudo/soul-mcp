// Verifier rut-03-decompose-pipeline — deterministisch, Exit 0 = pass.
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

const LIB = "lib/records.mjs";
const LOCKED = {
  "test/records.test.mjs": "6058810fa91ab2c26af1db1c7a7c73275a5cb8277785aeebc360af5510268a20"
};
const VALID_SAMPLES = ["Widget; 4 ;pcs", "Bolt;10;box", "  Nagel ;0; stk "];
const INVALID_SAMPLES = ["Widget;4", ";4;pcs", "Widget;-1;pcs", "Widget;2.5;pcs", "Widget;4; "];

for (const [file, hash] of Object.entries(LOCKED)) {
  check(existsSync(join(wd, file)) && sha256(join(wd, file)) === hash, "unveraendert: " + file);
}
check(existsSync(join(wd, LIB)), LIB + " existiert");

if (fails.length === 0) {
  // env: {} — kein geerbter Test-Runner-Kontext (NODE_TEST_CONTEXT wuerde Exit-Codes maskieren)
  const run = spawnSync(process.execPath, ["--test"], { cwd: wd, encoding: "utf8", env: {} });
  check(run.status === 0, "Testsuite gruen nach Refactor");

  try {
    const mod = await import(pathToFileURL(join(wd, LIB)).href);
    for (const name of ["processRecord", "parseRecord", "validateRecord", "formatRecord"]) {
      check(typeof mod[name] === "function", "Export vorhanden: " + name);
    }
    if (["processRecord", "parseRecord", "validateRecord", "formatRecord"].every((n) => typeof mod[n] === "function")) {
      for (const sample of VALID_SAMPLES) {
        const composed = mod.formatRecord(mod.validateRecord(mod.parseRecord(sample)));
        const direct = mod.processRecord(sample);
        check(composed === direct,
          "Komposition == processRecord fuer " + JSON.stringify(sample) + " (" + composed + " vs " + direct + ")");
      }
      for (const sample of INVALID_SAMPLES) {
        let directErr = null;
        let composedErr = null;
        try { mod.processRecord(sample); } catch (e) { directErr = e.message; }
        try { mod.formatRecord(mod.validateRecord(mod.parseRecord(sample))); } catch (e) { composedErr = e.message; }
        check(directErr !== null && composedErr === directErr,
          "identische Fehlermeldung fuer " + JSON.stringify(sample) + " (" + composedErr + " vs " + directErr + ")");
      }
    }
  } catch (e) {
    check(false, "Modul importierbar (" + e.message + ")");
  }
}

if (fails.length) { console.log("VERDICT: fail (" + fails.length + ")"); process.exit(1); }
console.log("VERDICT: pass");
process.exit(0);
