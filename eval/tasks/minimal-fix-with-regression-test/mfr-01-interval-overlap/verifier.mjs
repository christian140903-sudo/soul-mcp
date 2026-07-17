// Verifier mfr-01-interval-overlap — deterministisch, Exit 0 = pass.
// Aufruf: node verifier.mjs <workdir>
import { readFileSync, existsSync, readdirSync, statSync, cpSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

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
function walk(dir, base) {
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p, base));
    else out.push(relative(base, p).split("\\").join("/"));
  }
  return out;
}

const FIX_FILE = "lib/interval.mjs";
const REG_TEST = "test/regression.test.mjs";
const ORIGINAL_B64 = "Ly8gSGFsYm9mZmVuZSBJbnRlcnZhbGxlIFtzdGFydCwgZW5kKTogZW5kIGdlaG9lcnQgbmljaHQgbWVociB6dW0gSW50ZXJ2YWxsLgpleHBvcnQgZnVuY3Rpb24gb3ZlcmxhcHMoYSwgYikgewogIHJldHVybiBhLnN0YXJ0IDw9IGIuZW5kICYmIGIuc3RhcnQgPD0gYS5lbmQ7Cn0KCmV4cG9ydCBmdW5jdGlvbiBsZW5ndGgoaW50ZXJ2YWwpIHsKICByZXR1cm4gaW50ZXJ2YWwuZW5kIC0gaW50ZXJ2YWwuc3RhcnQ7Cn0K";
const LOCKED = {
  "test/interval.test.mjs": "c62ab86235923951716d2703fe4cb077b1d7dfc8ef1e6303aef9eb6ea5e341ea"
};
const original = Buffer.from(ORIGINAL_B64, "base64").toString("utf8");

// 1. Bestehende Tests unveraendert
for (const [file, hash] of Object.entries(LOCKED)) {
  check(existsSync(join(wd, file)) && sha256(join(wd, file)) === hash, "unveraendert: " + file);
}

// 2. Minimalitaet: nur FIX_FILE (geaendert) + REG_TEST (neu) + gelockte Dateien
const allowed = new Set([...Object.keys(LOCKED), FIX_FILE, REG_TEST]);
for (const file of walk(wd, wd)) {
  check(allowed.has(file), "keine unerwartete Datei: " + file);
}

// 3. Fix vorhanden, Regressionstest vorhanden
check(existsSync(join(wd, FIX_FILE)) && readFileSync(join(wd, FIX_FILE), "utf8") !== original,
  FIX_FILE + " wurde geaendert (Fix)");
check(existsSync(join(wd, REG_TEST)), REG_TEST + " existiert");

if (fails.length === 0) {
  // 4. Volle Suite gruen auf dem gefixten Stand
  // env: {} — kein geerbter Test-Runner-Kontext (NODE_TEST_CONTEXT wuerde Exit-Codes maskieren)
  const full = spawnSync(process.execPath, ["--test"], { cwd: wd, encoding: "utf8", env: {} });
  check(full.status === 0, "volle Testsuite gruen nach Fix");

  // 5. Kontrafaktisch: Regressionstest MUSS auf dem Originalcode fehlschlagen
  const tmp = mkdtempSync(join(tmpdir(), "mfr-01-"));
  try {
    cpSync(wd, tmp, { recursive: true });
    writeFileSync(join(tmp, FIX_FILE), original);
    const reg = spawnSync(process.execPath, ["--test", REG_TEST], { cwd: tmp, encoding: "utf8", env: {} });
    check(reg.status !== 0, "Regressionstest schlaegt auf dem Originalcode fehl (war vorher rot)");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (fails.length) { console.log("VERDICT: fail (" + fails.length + ")"); process.exit(1); }
console.log("VERDICT: pass");
process.exit(0);
