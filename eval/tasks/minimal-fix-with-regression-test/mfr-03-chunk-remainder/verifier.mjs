// Verifier mfr-03-chunk-remainder — deterministisch, Exit 0 = pass.
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

const FIX_FILE = "lib/chunk.mjs";
const REG_TEST = "test/regression.test.mjs";
const ORIGINAL_B64 = "ZXhwb3J0IGZ1bmN0aW9uIGNodW5rKGl0ZW1zLCBzaXplKSB7CiAgaWYgKCFOdW1iZXIuaXNJbnRlZ2VyKHNpemUpIHx8IHNpemUgPD0gMCkgewogICAgdGhyb3cgbmV3IEVycm9yKCJzaXplIG11c3QgYmUgYSBwb3NpdGl2ZSBpbnRlZ2VyIik7CiAgfQogIGNvbnN0IG91dCA9IFtdOwogIGNvbnN0IGZ1bGxDaHVua3MgPSBNYXRoLmZsb29yKGl0ZW1zLmxlbmd0aCAvIHNpemUpOwogIGZvciAobGV0IGkgPSAwOyBpIDwgZnVsbENodW5rczsgaSsrKSB7CiAgICBvdXQucHVzaChpdGVtcy5zbGljZShpICogc2l6ZSwgKGkgKyAxKSAqIHNpemUpKTsKICB9CiAgcmV0dXJuIG91dDsKfQo=";
const LOCKED = {
  "test/chunk.test.mjs": "1eddc0f50ce4a62e21d43c68b250a4e58d3b0ed9a4933496e09e6d1b8a6cfacc"
};
const original = Buffer.from(ORIGINAL_B64, "base64").toString("utf8");

for (const [file, hash] of Object.entries(LOCKED)) {
  check(existsSync(join(wd, file)) && sha256(join(wd, file)) === hash, "unveraendert: " + file);
}

const allowed = new Set([...Object.keys(LOCKED), FIX_FILE, REG_TEST]);
for (const file of walk(wd, wd)) {
  check(allowed.has(file), "keine unerwartete Datei: " + file);
}

check(existsSync(join(wd, FIX_FILE)) && readFileSync(join(wd, FIX_FILE), "utf8") !== original,
  FIX_FILE + " wurde geaendert (Fix)");
check(existsSync(join(wd, REG_TEST)), REG_TEST + " existiert");

if (fails.length === 0) {
  // env: {} — kein geerbter Test-Runner-Kontext (NODE_TEST_CONTEXT wuerde Exit-Codes maskieren)
  const full = spawnSync(process.execPath, ["--test"], { cwd: wd, encoding: "utf8", env: {} });
  check(full.status === 0, "volle Testsuite gruen nach Fix");

  const tmp = mkdtempSync(join(tmpdir(), "mfr-03-"));
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
