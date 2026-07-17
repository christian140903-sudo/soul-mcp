/**
 * Soul 4.0 Eval — mechanischer A/B-Dry-Run (SOUL4-PLAN 1A-Akzeptanz:
 * "ein Dry-Run auf 3 Aufgaben × Arm A/B läuft mechanisch durch — Skript,
 * kein Handbetrieb").
 *
 * Arm A = unverändertes Fixture (Verifier muss fail),
 * Arm B = Referenzlösungs-Overlay (Verifier muss pass).
 * KEIN Modell-Vergleich, keine konfirmatorische Aussage — siehe harness.mjs.
 *
 * Ablauf: Protokoll-Hash idempotent in eine Wegwerf-Ledger-DB registrieren
 * (VOR der Auswertung), 6 echte Verifier-Prozessläufe, dann die komplette
 * vorregistrierte Pipeline (applyITT → Bootstrap-p → Holm → deterministische
 * Gates via evaluateGate). Report: eval/pilot/DRY-RUN-REPORT.md.
 *
 * Aufruf: node eval/pilot/run-dry.mjs [--out <dir>] [--db <pfad>]
 *                                     [--resamples N] [--seed N]
 * Exit 0 = mechanischer Durchlauf ok (A fail / B pass, Gate lieferte ein
 * strukturiertes Verdict) · Exit 1 = mechanische Erwartung verletzt.
 */
import { runDry } from './harness.mjs';

function flag(args, name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}

const args = process.argv.slice(2);
const opts = {
  outDir: flag(args, '--out', undefined),
  dbPath: flag(args, '--db', undefined),
  resamples: Number(flag(args, '--resamples', 10000)),
  seed: Number(flag(args, '--seed', 1)),
};

const result = await runDry(opts);

process.stdout.write(
  [
    `protocol_hash: ${result.protocol.hash}`,
    `ledger (Wegwerf-DB): ${result.protocol.db_path} — registered=${result.protocol.registered}, idempotent repeat already_registered=${result.protocol.idempotent_repeat.already_registered}`,
    ...result.tasks.map(
      (t) => `${t.task_id} (Stufe ${t.stage}): Arm A ${t.armA.outcome} / Arm B ${t.armB.outcome}`
    ),
    `Erwartung (A fail / B pass): ${result.expectations.mechanical_pass}`,
    `evaluateGate Gesamtverdict: ${result.gate.pass} (mechanisch erwartet: false — D_vs_C bei identischen Slots)`,
    `Report: ${result.report_path}`,
    '',
  ].join('\n')
);

process.exit(result.expectations.mechanical_pass ? 0 : 1);
