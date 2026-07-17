/**
 * Soul 4.0 Eval — Varianz-Pilot-Harness, mechanische Ebene (F15:
 * 3 Aufgaben × 5 Wiederholungen; protocol.json → variance_pilot).
 *
 * Misst auf mechanischer Ebene:
 * - Verifier-Determinismus (Outcome-Varianz MUSS 0 sein: Arm A immer fail,
 *   Arm B immer pass) — Beweis der Verifier-Stabilität.
 * - Laufzeit-Varianz (real interessant) + Beispiel-Power-Rechnung nach der
 *   fixierten F15-Methode (task-zentriert).
 *
 * Die Ergebnis-Varianz echter MODELL-Läufe ist damit NICHT gemessen —
 * siehe Disclaimer im Report (eval/pilot/PILOT-REPORT.md).
 *
 * Aufruf: node eval/pilot/run-pilot.mjs [--out <dir>]
 * Exit 0 = Determinismus bestätigt · Exit 1 = Determinismus verletzt.
 */
import { runPilot, PILOT_REPEATS } from './harness.mjs';

function flag(args, name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}

const args = process.argv.slice(2);
const result = runPilot({ outDir: flag(args, '--out', undefined) });

process.stdout.write(
  [
    `Design: ${result.design.tasks} Tasks × ${PILOT_REPEATS} Wiederholungen × 2 Arme = ${result.design.runs_total} Verifier-Prozessläufe`,
    ...result.determinism.map(
      (d) => `${d.task_id}: A=[${d.armA_outcomes}] B=[${d.armB_outcomes}] deterministisch+erwartet=${d.expected}`
    ),
    `Determinismus bestätigt: ${result.determinism_pass}`,
    `σ²_between=${result.variance_components.sigmaB2.toExponential(3)} σ²_within=${result.variance_components.sigmaW2.toExponential(3)} (Arm-B-Laufzeit, s²)`,
    `Report: ${result.report_path}`,
    '',
  ].join('\n')
);

process.exit(result.determinism_pass ? 0 : 1);
