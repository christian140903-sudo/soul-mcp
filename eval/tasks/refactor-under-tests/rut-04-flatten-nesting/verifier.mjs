// Verifier rut-04-flatten-nesting — deterministisch, Exit 0 = pass.
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
// Maximale {}-Verschachtelungstiefe, Strings/Kommentare ausgeblendet.
function maxBraceDepth(source) {
  let depth = 0;
  let max = 0;
  let state = "code"; // code | line-comment | block-comment | single | double | template
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];
    if (state === "line-comment") {
      if (c === "\n") state = "code";
    } else if (state === "block-comment") {
      if (c === "*" && next === "/") { state = "code"; i++; }
    } else if (state === "single") {
      if (c === "\\") i++;
      else if (c === "'") state = "code";
    } else if (state === "double") {
      if (c === "\\") i++;
      else if (c === '"') state = "code";
    } else if (state === "template") {
      if (c === "\\") i++;
      else if (c === "`") state = "code";
    } else {
      if (c === "/" && next === "/") { state = "line-comment"; i++; }
      else if (c === "/" && next === "*") { state = "block-comment"; i++; }
      else if (c === "'") state = "single";
      else if (c === '"') state = "double";
      else if (c === "`") state = "template";
      else if (c === "{") { depth++; if (depth > max) max = depth; }
      else if (c === "}") depth--;
    }
  }
  return max;
}

const LIB = "lib/access.mjs";
const LOCKED = {
  "test/access.test.mjs": "dda31ed7abc6e119b1ee51bbdabb0d76dfde7343fa6c42baced6b5b2274d07dc"
};
const MAX_DEPTH = 4;
const MAX_LINE = 100;

for (const [file, hash] of Object.entries(LOCKED)) {
  check(existsSync(join(wd, file)) && sha256(join(wd, file)) === hash, "unveraendert: " + file);
}
check(existsSync(join(wd, LIB)), LIB + " existiert");

if (existsSync(join(wd, LIB))) {
  const source = readFileSync(join(wd, LIB), "utf8");
  const depth = maxBraceDepth(source);
  check(depth <= MAX_DEPTH, "Verschachtelungstiefe " + depth + " <= " + MAX_DEPTH);
  const longLines = source.split("\n").filter((l) => l.length > MAX_LINE).length;
  check(longLines === 0, "keine Zeile laenger als " + MAX_LINE + " Zeichen (" + longLines + " zu lang)");
}

if (fails.length === 0) {
  // env: {} — kein geerbter Test-Runner-Kontext (NODE_TEST_CONTEXT wuerde Exit-Codes maskieren)
  const run = spawnSync(process.execPath, ["--test"], { cwd: wd, encoding: "utf8", env: {} });
  check(run.status === 0, "Testsuite gruen nach Refactor");

  try {
    const mod = await import(pathToFileURL(join(wd, LIB)).href);
    const names = Object.keys(mod).sort();
    check(JSON.stringify(names) === JSON.stringify(["canAccess"]), "Export-Oberflaeche exakt unveraendert");
  } catch (e) {
    check(false, "Modul importierbar (" + e.message + ")");
  }
}

if (fails.length) { console.log("VERDICT: fail (" + fails.length + ")"); process.exit(1); }
console.log("VERDICT: pass");
process.exit(0);
