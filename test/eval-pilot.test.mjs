// Tests fuer den mechanischen A/B-Dry-Run + Varianz-Pilot-Harness
// (eval/pilot/, SOUL4-PLAN 1A-Akzeptanz). Laeuft standalone:
//   node --test test/eval-pilot.test.mjs
//
// Alles hier ist EHRLICH MECHANISCH: Arm A = Fixture (fail), Arm B =
// Referenzloesung (pass). Kein Modell, keine konfirmatorische Aussage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  PILOT_TASKS,
  PILOT_REPEATS,
  PROTOCOL_DIR,
  runDry,
  runPilot,
  varianceComponents,
  requiredTasks,
  DRY_RUN_DISCLAIMER,
  PILOT_DISCLAIMER,
} from '../eval/pilot/harness.mjs';
import { hashProtocolDir, registerProtocolHash } from '../eval/protocol/hash.mjs';
import { normInv } from '../eval/protocol/statistics.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function scratch(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// Pilot-Task-Auswahl: eine Aufgabe je Stufe 1, 3, 5 — und sie existieren.
// ---------------------------------------------------------------------------

test('Pilot-Tasks: 3 Stueck, Stufen 1/3/5, auf der Platte vorhanden', () => {
  assert.equal(PILOT_TASKS.length, 3);
  assert.deepEqual(PILOT_TASKS.map((t) => t.stage), [1, 3, 5]);
  for (const t of PILOT_TASKS) {
    const dir = join(ROOT, 'eval', 'tasks', t.cluster, t.task_id);
    assert.ok(existsSync(join(dir, 'verifier.mjs')), 'verifier fehlt: ' + t.task_id);
    assert.ok(existsSync(join(dir, 'fixture')), 'fixture fehlt: ' + t.task_id);
    assert.ok(existsSync(join(dir, 'solution')), 'solution fehlt: ' + t.task_id);
  }
  assert.equal(PILOT_REPEATS, 5, 'protocol.json variance_pilot.runs_per_task = 5');
});

// ---------------------------------------------------------------------------
// Hash-Registrierung: idempotent, Wegwerf-DB, Hash == hashProtocolDir.
// ---------------------------------------------------------------------------

test('registerProtocolHash ist idempotent (Wegwerf-DB)', async () => {
  const dir = scratch('soul-pilot-hashdb-');
  try {
    const dbPath = join(dir, 'throwaway.db');
    const expected = hashProtocolDir(PROTOCOL_DIR).protocol_hash;

    const first = await registerProtocolHash(dbPath, { protocolDir: PROTOCOL_DIR });
    assert.equal(first.protocol_hash, expected);
    assert.equal(first.registered, true);
    assert.equal(first.already_registered, false);
    assert.ok(Number.isInteger(first.seq));

    const second = await registerProtocolHash(dbPath, { protocolDir: PROTOCOL_DIR });
    assert.equal(second.protocol_hash, expected);
    assert.equal(second.registered, false, 'zweiter Aufruf muss No-op sein');
    assert.equal(second.already_registered, true);
    assert.equal(second.seq, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Dry-Run end-to-end (in-process): echte Prozesse, komplette Pipeline.
// ---------------------------------------------------------------------------

test('Dry-Run: Arm A fail / Arm B pass, evaluateGate liefert strukturiertes Ergebnis', async () => {
  const dir = scratch('soul-pilot-dry-');
  try {
    const result = await runDry({
      outDir: dir,
      dbPath: join(dir, 'ledger.db'),
      resamples: 2000, // Testtempo; Pipeline-Struktur ist identisch zu 10k
      seed: 1,
    });

    // echte Verifier-Prozesslaeufe mit dem mechanisch erzwungenen Ergebnis
    assert.equal(result.tasks.length, 3);
    for (const t of result.tasks) {
      assert.equal(t.armA.outcome, 'fail', `Arm A muss fail sein: ${t.task_id}`);
      assert.equal(t.armB.outcome, 'pass', `Arm B muss pass sein: ${t.task_id}`);
      assert.equal(t.armA.tainted, false);
      assert.ok(t.armA.duration_ms > 0 && t.armB.duration_ms > 0);
    }
    assert.equal(result.expectations.mechanical_pass, true);

    // Hash wurde VOR der Auswertung registriert, idempotent
    assert.match(result.protocol.hash, /^[0-9a-f]{64}$/);
    assert.equal(result.protocol.registered, true);
    assert.equal(result.protocol.idempotent_repeat.already_registered, true);

    // komplette vorregistrierte Pipeline: strukturiertes Gate-Ergebnis
    const gate = result.gate;
    assert.deepEqual(gate.family, ['C_vs_B', 'D_vs_C', 'E1_vs_C', 'E2_vs_C']);
    assert.equal(gate.raw_p.length, 4);
    assert.equal(gate.holm_adjusted_p.length, 4);
    for (const p of gate.holm_adjusted_p) assert.ok(p >= 0 && p <= 1);

    // mechanisch ableitbares Verdict: C_vs_B abgelehnt (Differenz +1 je Task),
    // D_vs_C NICHT (identische Slots => Differenz 0 an Grenze 0 => p = 1),
    // Gesamtverdict false. Ein pass waere ein Pipeline-Bug.
    assert.equal(gate.comparisons.C_vs_B.pass, true);
    assert.equal(gate.comparisons.C_vs_B.estimate, 1);
    assert.equal(gate.comparisons.D_vs_C.pass, false);
    assert.equal(gate.comparisons.D_vs_C.estimate, 0);
    assert.equal(gate.comparisons.D_vs_C.p, 1);
    assert.equal(gate.comparisons.E1_vs_C.pass, true);
    assert.equal(gate.comparisons.E2_vs_C.pass, true);
    assert.equal(gate.comparisons.E2_vs_C.zero_tolerance.pass, true);
    assert.equal(gate.pass, false);

    // Report entsteht und deklariert den Nicht-Modell-Charakter prominent
    const report = readFileSync(result.report_path, 'utf8');
    assert.ok(report.includes(DRY_RUN_DISCLAIMER), 'Disclaimer fehlt im Report');
    assert.ok(report.includes(result.protocol.hash), 'protocol_hash fehlt im Report');
    assert.ok(report.includes('DRY-RUN-REPORT') || result.report_path.endsWith('DRY-RUN-REPORT.md'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Dry-Run CLI: Skript, kein Handbetrieb (Exit 0, Report auf Platte)', () => {
  const dir = scratch('soul-pilot-drycli-');
  try {
    const res = spawnSync(
      process.execPath,
      [
        join(ROOT, 'eval', 'pilot', 'run-dry.mjs'),
        '--out', dir,
        '--db', join(dir, 'ledger.db'),
        '--resamples', '2000',
      ],
      { encoding: 'utf8', timeout: 300000 }
    );
    assert.equal(res.status, 0, 'CLI muss Exit 0 liefern\n--- stdout ---\n' + res.stdout + '\n--- stderr ---\n' + res.stderr);
    assert.match(res.stdout, /protocol_hash: [0-9a-f]{64}/);
    assert.match(res.stdout, /Erwartung \(A fail \/ B pass\): true/);
    assert.ok(existsSync(join(dir, 'DRY-RUN-REPORT.md')), 'Report fehlt');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Varianz-Pilot: Determinismus-Assertion, Report, Laufzeit-Varianz.
// ---------------------------------------------------------------------------

test('Pilot-Harness: 3x5, Outcome-Varianz 0, Report mit ehrlicher Einordnung', () => {
  const dir = scratch('soul-pilot-pilot-');
  try {
    const result = runPilot({ outDir: dir });

    assert.equal(result.design.tasks, 3);
    assert.equal(result.design.repeats, 5);
    assert.equal(result.design.runs_total, 30);

    // Determinismus: DAS ist der mechanische Pilot-Zweck.
    for (const d of result.determinism) {
      assert.deepEqual(d.armA_outcomes, ['fail'], `Arm A nicht deterministisch fail: ${d.task_id}`);
      assert.deepEqual(d.armB_outcomes, ['pass'], `Arm B nicht deterministisch pass: ${d.task_id}`);
      assert.equal(d.outcome_variance_zero, true);
    }
    assert.equal(result.determinism_pass, true);

    // Laufzeit-Varianzzerlegung ist berechnet und endlich
    const c = result.variance_components;
    assert.equal(c.tasks, 3);
    assert.equal(c.repeats, 5);
    assert.ok(Number.isFinite(c.sigmaB2) && c.sigmaB2 >= 0);
    assert.ok(Number.isFinite(c.sigmaW2) && c.sigmaW2 >= 0);
    assert.ok(c.grandMean > 0);

    // Power-Beispieltabelle vorhanden, T monoton fallend in R
    const table = result.power_example.table;
    assert.equal(table.length, 5);
    for (let i = 1; i < table.length; i++) {
      assert.ok(table[i].tasks <= table[i - 1].tasks, 'T muss mit R monoton fallen (oder gleich bleiben)');
    }

    const report = readFileSync(result.report_path, 'utf8');
    assert.ok(report.includes(PILOT_DISCLAIMER), 'ehrliche Einordnung fehlt im Report');
    assert.ok(report.includes('Determinismus bestätigt: **true**'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Power-Rechenweg (F15) deterministisch mit synthetischen Fixture-Zahlen.
// ---------------------------------------------------------------------------

test('varianceComponents: bekannte synthetische Zahlen exakt', () => {
  // 2 Tasks x 3 Repeats: Task-Mittel 2 und 5, Innerhalb-Varianz je 1.
  const comp = varianceComponents([
    [1, 2, 3],
    [4, 5, 6],
  ]);
  assert.equal(comp.grandMean, 3.5);
  assert.deepEqual(comp.taskMeans, [2, 5]);
  assert.equal(comp.msWithin, 1); // ss=2+2 ueber T*(R-1)=4
  assert.equal(comp.msBetween, 13.5); // 3 * ((2-3.5)^2 + (5-3.5)^2) / 1
  assert.equal(comp.sigmaW2, 1);
  assert.ok(Math.abs(comp.sigmaB2 - 12.5 / 3) < 1e-12);
  assert.throws(() => varianceComponents([[1, 2]]), /at least 2 tasks/);
  assert.throws(() => varianceComponents([[1], [2]]), /at least 2 repeats/);
  assert.throws(() => varianceComponents([[1, 2], [1, 2, 3]]), /unbalanced/);
});

test('requiredTasks: F15-Rechenweg deterministisch, mehr Tasks schlaegt mehr Repeats', () => {
  // pass@1-artige synthetische Groessenordnung: sigma_b^2=0.04, sigma_w^2=0.15, Delta=0.1
  const z = normInv(0.95) + normInv(0.8);
  const expect = (R) => Math.max(2, Math.ceil((z * z * (0.04 + 0.15 / R)) / 0.01));

  const r1 = requiredTasks({ sigmaB2: 0.04, sigmaW2: 0.15, repeats: 1, delta: 0.1 });
  const r5 = requiredTasks({ sigmaB2: 0.04, sigmaW2: 0.15, repeats: 5, delta: 0.1 });
  const r10 = requiredTasks({ sigmaB2: 0.04, sigmaW2: 0.15, repeats: 10, delta: 0.1 });

  assert.equal(r1.tasks, expect(1));
  assert.equal(r5.tasks, expect(5));
  assert.equal(r10.tasks, expect(10));

  // Wiederholung derselben Inputs => identisches Ergebnis (deterministisch)
  assert.deepEqual(requiredTasks({ sigmaB2: 0.04, sigmaW2: 0.15, repeats: 5, delta: 0.1 }), r5);

  // T faellt mit R, aber der GESAMTAUFWAND T*R waechst (sigma_b^2 > 0):
  // genau die F15-Aussage "mehr unabhaengige Aufgaben schlaegt mehr Repeats".
  assert.ok(r1.tasks > r5.tasks && r5.tasks > r10.tasks);
  assert.ok(r1.totalRuns < r5.totalRuns && r5.totalRuns < r10.totalRuns);

  assert.throws(() => requiredTasks({ sigmaB2: 0.04, sigmaW2: 0.15, repeats: 5, delta: 0 }), /delta/);
});
