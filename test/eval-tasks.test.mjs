// Meta-Tests ueber das offene Baseline-Aufgabenset (Phase 1B, eval/tasks/).
// Prueft: Schema-Konsistenz, Verifier-Syntax, Hermetik-Lint, Cluster-Zaehlung,
// und End-to-End-Beweise (Referenzloesung pass / unveraendertes Fixture fail)
// fuer JEDEN Task. Laeuft standalone: node --test test/eval-tasks.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync, mkdtempSync, cpSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TASKS_DIR = join(ROOT, "eval", "tasks");

// Die 5 Stufen der Code-Faehigkeitsleiter (SOUL4-DECISIONS F04)
const LADDER = {
  "repo-recon": 1,
  "failing-test-diagnosis": 2,
  "minimal-fix-with-regression-test": 3,
  "contract-review": 4,
  "refactor-under-tests": 5
};
// task_slice-Enums aus design/contracts/Episode@1.schema.json
const SLICE_KINDS = ["code_fix", "code_review", "research", "decision", "estimate", "content", "ops", "other"];
const SLICE_RISKS = ["low", "high"];
const ARTIFACT_KINDS = ["json", "source", "test"];
const BUDGET_KEYS = ["max_tokens", "max_wall_clock_s", "max_cost_eur", "max_attempts"];

// Hermetik-Lint: verbotene Muster in Verifier-Quelltext (statisch)
const FORBIDDEN_IN_VERIFIER = [
  [/\bfetch\s*\(/, "fetch()"],
  [/["'](?:node:)?https?["']/, "http/https-Modul"],
  [/["'](?:node:)?net["']/, "net-Modul"],
  [/["'](?:node:)?dns["']/, "dns-Modul"],
  [/["'](?:node:)?tls["']/, "tls-Modul"],
  [/undici/, "undici"],
  [/Date\s*\.\s*now/, "Date.now"],
  [/new\s+Date\s*\(/, "new Date()"],
  [/Math\s*\.\s*random/, "Math.random"],
  [/process\s*\.\s*env\b/, "process.env"],
  [/setInterval/, "setInterval"]
];

function listDirs(dir) {
  return readdirSync(dir)
    .filter((e) => statSync(join(dir, e)).isDirectory())
    .sort();
}

function discoverTasks() {
  const tasks = [];
  for (const cluster of listDirs(TASKS_DIR)) {
    for (const taskId of listDirs(join(TASKS_DIR, cluster))) {
      tasks.push({ cluster, taskId, dir: join(TASKS_DIR, cluster, taskId) });
    }
  }
  return tasks;
}

function runVerifier(taskDir, workdir) {
  return spawnSync(process.execPath, [join(taskDir, "verifier.mjs"), workdir], {
    encoding: "utf8",
    timeout: 120000
  });
}

const tasks = discoverTasks();

test("Cluster-Struktur: nur die 5 Leiter-Stufen, 20-30 Tasks, >=4 pro Stufe", () => {
  const clusters = listDirs(TASKS_DIR);
  for (const c of clusters) {
    assert.ok(c in LADDER, "unbekanntes Cluster-Verzeichnis: " + c);
  }
  assert.equal(clusters.length, 5, "alle 5 Leiter-Stufen vorhanden");
  assert.ok(tasks.length >= 20 && tasks.length <= 30, "20-30 Tasks (ist: " + tasks.length + ")");
  for (const cluster of Object.keys(LADDER)) {
    const n = tasks.filter((t) => t.cluster === cluster).length;
    assert.ok(n >= 4, "Cluster " + cluster + " hat >=4 Tasks (ist: " + n + ")");
    assert.ok(n >= 1, "mindestens 1 Task pro Faehigkeitsstufe: " + cluster);
  }
});

test("task_ids sind global eindeutig", () => {
  const ids = tasks.map((t) => t.taskId);
  assert.equal(new Set(ids).size, ids.length);
});

for (const t of tasks) {
  test("task.json schema-konsistent: " + t.taskId, () => {
    const raw = readFileSync(join(t.dir, "task.json"), "utf8");
    const tj = JSON.parse(raw);

    assert.equal(tj.task_schema, "EvalTask@1");
    assert.equal(tj.task_id, t.taskId, "task_id == Verzeichnisname");
    assert.match(tj.task_id, /^[a-z0-9][a-z0-9-]{2,63}$/);
    assert.equal(tj.cluster, t.cluster, "cluster == Eltern-Verzeichnis");
    assert.equal(tj.skill_stage, LADDER[t.cluster], "skill_stage passt zur Leiter-Stufe");

    assert.ok(typeof tj.title === "string" && tj.title.length > 0 && tj.title.length <= 120, "title");
    assert.ok(typeof tj.description === "string" && tj.description.length >= 50, "description substanziell");

    assert.deepEqual(Object.keys(tj.task_slice).sort(), ["kind", "risk"], "task_slice exakt {kind, risk}");
    assert.ok(SLICE_KINDS.includes(tj.task_slice.kind), "task_slice.kind aus Episode@1-Enum");
    assert.ok(SLICE_RISKS.includes(tj.task_slice.risk), "task_slice.risk aus Episode@1-Enum");

    assert.ok(Array.isArray(tj.expected_artifacts) && tj.expected_artifacts.length >= 1, "expected_artifacts");
    for (const a of tj.expected_artifacts) {
      assert.ok(typeof a.path === "string" && !a.path.startsWith("/") && !a.path.includes(".."), "Artefakt-Pfad relativ");
      assert.ok(ARTIFACT_KINDS.includes(a.kind), "Artefakt-kind");
    }

    assert.deepEqual(Object.keys(tj.budget_hint).sort(), [...BUDGET_KEYS].sort(), "budget_hint = TaskContract@1-Budget-Form");
    assert.ok(Number.isInteger(tj.budget_hint.max_tokens) && tj.budget_hint.max_tokens >= 1);
    assert.ok(Number.isInteger(tj.budget_hint.max_wall_clock_s) && tj.budget_hint.max_wall_clock_s >= 1);
    assert.ok(typeof tj.budget_hint.max_cost_eur === "number" && tj.budget_hint.max_cost_eur >= 0);
    assert.ok(Number.isInteger(tj.budget_hint.max_attempts) && tj.budget_hint.max_attempts >= 1);

    assert.equal(tj.verifier.entry, "verifier.mjs");
    assert.ok(tj.verifier.invocation.includes("<workdir>"), "invocation dokumentiert <workdir>");
    assert.equal(tj.verifier.pass_exit_code, 0);

    assert.deepEqual(tj.hermetic, { network: false, clock_dependency: false, machine_dependency: false });

    if (t.cluster === "failing-test-diagnosis") {
      assert.ok(Array.isArray(tj.category_options) && tj.category_options.length >= 2, "category_options fuer Stufe 2");
      assert.ok(tj.category_options.every((c) => typeof c === "string"));
    } else {
      assert.ok(!("category_options" in tj), "category_options nur in Stufe 2");
    }

    // Struktur auf der Platte
    assert.ok(existsSync(join(t.dir, "fixture")) && listOrFail(join(t.dir, "fixture")), "fixture/ existiert und ist nicht leer");
    assert.ok(existsSync(join(t.dir, "solution")) && listOrFail(join(t.dir, "solution")), "solution/ existiert und ist nicht leer");
    assert.ok(existsSync(join(t.dir, "verifier.mjs")), "verifier.mjs existiert");
  });
}

function listOrFail(dir) {
  return readdirSync(dir).length > 0;
}

for (const t of tasks) {
  test("verifier syntaktisch valide (node --check): " + t.taskId, () => {
    const res = spawnSync(process.execPath, ["--check", join(t.dir, "verifier.mjs")], { encoding: "utf8" });
    assert.equal(res.status, 0, "node --check: " + (res.stderr || ""));
  });

  test("verifier Hermetik-Lint (kein Netz, keine Uhr, kein Zufall, kein env): " + t.taskId, () => {
    const src = readFileSync(join(t.dir, "verifier.mjs"), "utf8");
    for (const [pattern, label] of FORBIDDEN_IN_VERIFIER) {
      assert.ok(!pattern.test(src), "verboten in Verifier (" + t.taskId + "): " + label);
    }
    assert.ok(!src.includes("@@SHA(") && !src.includes("@@B64("), "keine unaufgeloesten Platzhalter");
  });
}

// End-to-End-Beweis fuer JEDEN Task (Brief verlangt >=3; wir beweisen alle):
// (a) unveraendertes Fixture besteht den Verifier NICHT — sonst misst die Aufgabe nichts.
// (b) Referenzloesung (solution/ als Overlay) besteht den Verifier.
for (const t of tasks) {
  test("E2E-Negativbeweis (Fixture allein failt): " + t.taskId, () => {
    const tmp = mkdtempSync(join(tmpdir(), "evaltask-neg-"));
    try {
      cpSync(join(t.dir, "fixture"), tmp, { recursive: true });
      const res = runVerifier(t.dir, tmp);
      assert.notEqual(res.status, 0,
        "unveraendertes Fixture darf nicht bestehen\n--- verifier stdout ---\n" + res.stdout);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("E2E-Positivbeweis (Referenzloesung besteht): " + t.taskId, () => {
    const tmp = mkdtempSync(join(tmpdir(), "evaltask-pos-"));
    try {
      cpSync(join(t.dir, "fixture"), tmp, { recursive: true });
      cpSync(join(t.dir, "solution"), tmp, { recursive: true, force: true });
      const res = runVerifier(t.dir, tmp);
      assert.equal(res.status, 0,
        "Referenzloesung muss bestehen\n--- verifier stdout ---\n" + res.stdout + "\n--- stderr ---\n" + res.stderr);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}
