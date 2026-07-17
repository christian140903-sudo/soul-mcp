/**
 * Soul 4.0 Eval — mechanischer Pilot-/Dry-Run-Harness (Phase 1A Akzeptanz).
 *
 * EHRLICHKEITS-DEKLARATION (gilt für alles in eval/pilot/):
 * Dieser Harness führt KEINE Modelle aus. "Arm A" ist das unveränderte Fixture
 * (der Verifier MUSS fail sagen), "Arm B" ist das Referenzlösungs-Overlay
 * (der Verifier MUSS pass sagen). Das beweist, dass die Kette
 * Task-Ausführung → Outcome → vorregistrierte Statistik-Pipeline mechanisch
 * end-to-end funktioniert — es ist KEIN Modell-Vergleich und trägt keinerlei
 * konfirmatorische Aussage.
 *
 * Herkunft der Regeln: eval/protocol/EVAL-PROTOCOL.md + protocol.json
 * (Preregistration als Code), docs/SOUL4-PLAN.md 1A-Akzeptanz
 * ("ein Dry-Run auf 3 Aufgaben × Arm A/B läuft mechanisch durch"),
 * docs/SOUL4-DECISIONS.md F15 (Varianz-Pilot 3×5, task-zentrierte
 * Powerplanung: mehr unabhängige Aufgaben schlägt mehr Repeats).
 *
 * Dieses Verzeichnis liegt AUSSERHALB von eval/protocol/ und ändert den
 * Protokoll-Hash nicht. eval/protocol/ wird ausschließlich importiert
 * (statistics.mjs, hash.mjs) — nie verändert.
 */

import { mkdtempSync, cpSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { evaluateGate, normInv } from '../protocol/statistics.mjs';
import { hashProtocolDir, registerProtocolHash } from '../protocol/hash.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const TASKS_DIR = join(ROOT, 'eval', 'tasks');
export const PROTOCOL_DIR = join(ROOT, 'eval', 'protocol');
export const PILOT_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Die 3 Pilot-Aufgaben (protocol.json → variance_pilot.tasks = 3):
 * je eine aus Fähigkeitsleiter-Stufe 1, 3 und 5 (F04).
 */
export const PILOT_TASKS = [
  { cluster: 'repo-recon', task_id: 'rr-01-module-graph', stage: 1 },
  { cluster: 'minimal-fix-with-regression-test', task_id: 'mfr-01-interval-overlap', stage: 3 },
  { cluster: 'refactor-under-tests', task_id: 'rut-03-decompose-pipeline', stage: 5 },
];

/** Wiederholungszahl des Varianz-Piloten (protocol.json → variance_pilot.runs_per_task). */
export const PILOT_REPEATS = 5;

const VERIFIER_TIMEOUT_MS = 120000;

function taskDir(task) {
  return join(TASKS_DIR, task.cluster, task.task_id);
}

/**
 * Ein ECHTER Verifier-Prozesslauf (wie in test/eval-tasks.test.mjs):
 * fixture/ → frisches Workdir; bei Arm B zusätzlich solution/ als Overlay;
 * dann `node <task>/verifier.mjs <workdir>` als Kindprozess.
 *
 * Outcome-Klassifikation (Intention-to-treat-kompatibel, Protokoll §2):
 * exit 0 = 'pass' · exit ≠ 0 = 'fail' · Signal/Timeout = 'timeout' ·
 * Spawn-Fehler = 'error'. Alles außer 'pass' zählt in applyITT als Fehlschlag.
 *
 * @param {{cluster:string, task_id:string}} task
 * @param {{withSolution:boolean}} opts  false = Arm A (Fixture pur), true = Arm B (Overlay)
 * @returns {{task_id:string, arm:'A'|'B', outcome:string, exit_code:number|null, signal:string|null, duration_ms:number, tainted:boolean}}
 */
export function runVerifierOnce(task, { withSolution }) {
  const dir = taskDir(task);
  const workdir = mkdtempSync(join(tmpdir(), `soul-pilot-${task.task_id}-`));
  try {
    cpSync(join(dir, 'fixture'), workdir, { recursive: true });
    if (withSolution) cpSync(join(dir, 'solution'), workdir, { recursive: true, force: true });
    const t0 = process.hrtime.bigint();
    const res = spawnSync(process.execPath, [join(dir, 'verifier.mjs'), workdir], {
      encoding: 'utf8',
      timeout: VERIFIER_TIMEOUT_MS,
    });
    const durationMs = Number(process.hrtime.bigint() - t0) / 1e6;
    let outcome;
    if (res.error) outcome = 'error';
    else if (res.signal) outcome = 'timeout';
    else if (res.status === 0) outcome = 'pass';
    else outcome = 'fail';
    return {
      task_id: task.task_id,
      arm: withSolution ? 'B' : 'A',
      outcome,
      exit_code: res.status ?? null,
      signal: res.signal ?? null,
      duration_ms: durationMs,
      tainted: false,
    };
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Varianzzerlegung + task-zentrierte Powerplanung (F15).
// ---------------------------------------------------------------------------

/**
 * Balancierte einfaktorielle Varianzzerlegung (Task = Cluster):
 * msWithin = gepoolte Innerhalb-Task-Varianz (σ²_w),
 * msBetween = R · Var(Task-Mittel),
 * σ²_b = max(0, (msBetween − msWithin) / R)  (Momentenschätzer).
 *
 * @param {number[][]} perTask  T Tasks × R Wiederholungen (balanciert)
 */
export function varianceComponents(perTask) {
  const T = perTask.length;
  if (T < 2) throw new Error('varianceComponents: need at least 2 tasks');
  const R = perTask[0].length;
  if (R < 2) throw new Error('varianceComponents: need at least 2 repeats per task');
  for (const row of perTask) {
    if (row.length !== R) throw new Error('varianceComponents: unbalanced design not supported');
  }
  const taskMeans = perTask.map((row) => row.reduce((a, b) => a + b, 0) / R);
  const grandMean = taskMeans.reduce((a, b) => a + b, 0) / T;
  let ssWithin = 0;
  for (let t = 0; t < T; t++) {
    for (const v of perTask[t]) ssWithin += (v - taskMeans[t]) ** 2;
  }
  const msWithin = ssWithin / (T * (R - 1));
  let ssBetween = 0;
  for (const m of taskMeans) ssBetween += (m - grandMean) ** 2;
  const msBetween = (R * ssBetween) / (T - 1);
  const sigmaW2 = msWithin;
  const sigmaB2 = Math.max(0, (msBetween - msWithin) / R);
  return { tasks: T, repeats: R, grandMean, taskMeans, msWithin, msBetween, sigmaW2, sigmaB2 };
}

/**
 * Task-zentrierte Powerplanung (F15, fixe Stichprobe, einseitig):
 * Varianz des Cluster-Mittels bei T Tasks × R Repeats ist
 *   Var(θ̂) = (σ²_b + σ²_w / R) / T.
 * Erforderliche Task-Zahl für Power 1−β am einseitigen Niveau α bei
 * kleinstem interessierenden Abstand Δ zur Entscheidungsgrenze:
 *   T = ⌈ (z_{1−α} + z_{1−β})² · (σ²_b + σ²_w/R) / Δ² ⌉  (min. 2 Cluster).
 *
 * Direkte Konsequenz (mechanisch prüfbar): der Gesamtaufwand T·R wächst in R,
 * sobald σ²_b > 0 — "mehr unabhängige Aufgaben schlägt mehr Repeats".
 *
 * @param {{sigmaB2:number, sigmaW2:number, repeats:number, delta:number, alpha?:number, power?:number}} opts
 */
export function requiredTasks({ sigmaB2, sigmaW2, repeats, delta, alpha = 0.05, power = 0.8 }) {
  if (!(delta > 0)) throw new RangeError('requiredTasks: delta must be > 0');
  if (!(repeats >= 1)) throw new RangeError('requiredTasks: repeats must be >= 1');
  if (!(sigmaB2 >= 0) || !(sigmaW2 >= 0)) throw new RangeError('requiredTasks: variances must be >= 0');
  const zAlpha = normInv(1 - alpha);
  const zPower = normInv(power);
  const varCluster = sigmaB2 + sigmaW2 / repeats;
  const raw = ((zAlpha + zPower) ** 2 * varCluster) / (delta * delta);
  const tasks = Math.max(2, Math.ceil(raw));
  return { tasks, totalRuns: tasks * repeats, raw, varCluster, zAlpha, zPower, alpha, power, delta, repeats, sigmaB2, sigmaW2 };
}

// ---------------------------------------------------------------------------
// Dry-Run: 3 Aufgaben × Arm A/B mechanisch durch die komplette Pipeline.
// ---------------------------------------------------------------------------

export const DRY_RUN_DISCLAIMER =
  'Arm A/B sind Fixture-vs-Referenzlösung — ein Pipeline-Funktionsbeweis, KEIN Modell-Vergleich, keine konfirmatorische Aussage.';

/**
 * Der mechanische A/B-Dry-Run (SOUL4-PLAN 1A-Akzeptanz):
 * 1. Protokoll-Hash idempotent in eine WEGWERF-Ledger-DB registrieren
 *    (registerProtocolHash, F05) — "Hash vor Lauf" mechanisch vorgeführt.
 *    Das Live-Ledger (~/.soul) wird NIE berührt.
 * 2. Pro Aufgabe zwei echte Verifier-Prozessläufe: Arm A (Fixture, muss fail)
 *    und Arm B (Referenzlösungs-Overlay, muss pass).
 * 3. Die echten Outcomes fließen durch die KOMPLETTE vorregistrierte Pipeline:
 *    applyITT → gepaarte Task-Differenzen → Bootstrap-p → Holm →
 *    deterministische Gates (alles in evaluateGate, F01r3).
 *
 * Slot-Belegung (mechanisch, im Report deklariert): evaluateGate verlangt die
 * fünf Protokoll-Arme B/C/D/E1/E2. Der Dry-Run belegt Slot B mit den
 * Arm-A-Outcomes und die Slots C/D/E1/E2 mit den Arm-B-Outcomes (E2 mit
 * Null-Toleranz-Zählern = 0). Token-Zahlen existieren ohne Modell nicht;
 * als Zahlenstrom für das Kosten-Gate dienen die Verifier-Laufzeiten in ms
 * (reiner Code-Pfad-Beweis, deklariert, entscheidet nichts Inhaltliches).
 *
 * Mechanisch erwartbares Gate-Ergebnis (und genau das prüft der Test):
 * C_vs_B wird abgelehnt (Differenz +1 je Task), D_vs_C NICHT (identische
 * Slots, p = 1), Gesamtverdict false. Ein "pass" wäre hier ein Bug.
 *
 * @param {{outDir?:string, dbPath?:string, resamples?:number, seed?:number}} opts
 */
export async function runDry(opts = {}) {
  const outDir = opts.outDir ?? PILOT_DIR;
  const dbPath =
    opts.dbPath ?? join(mkdtempSync(join(tmpdir(), 'soul-dryrun-ledger-')), 'throwaway-ledger.db');
  const resamples = opts.resamples ?? 10000;
  const seed = opts.seed ?? 1;

  // 1. Hash VOR der Auswertung registrieren — zweiter Aufruf beweist Idempotenz.
  const registration = await registerProtocolHash(dbPath, { protocolDir: PROTOCOL_DIR });
  const registrationRepeat = await registerProtocolHash(dbPath, { protocolDir: PROTOCOL_DIR });

  // 2. Echte Verifier-Prozessläufe.
  const perTask = PILOT_TASKS.map((task) => ({
    task,
    armA: runVerifierOnce(task, { withSolution: false }),
    armB: runVerifierOnce(task, { withSolution: true }),
  }));

  const expectations = {
    armA_all_fail: perTask.every((r) => r.armA.outcome !== 'pass'),
    armB_all_pass: perTask.every((r) => r.armB.outcome === 'pass'),
  };
  expectations.mechanical_pass = expectations.armA_all_fail && expectations.armB_all_pass;

  // 3. Komplette vorregistrierte Pipeline (applyITT läuft IN evaluateGate).
  const mkRun = (r) => ({ task_id: r.task_id, outcome: r.outcome, tainted: r.tainted });
  const arms = {
    B: perTask.map((r) => mkRun(r.armA)),
    C: perTask.map((r) => mkRun(r.armB)),
    D: perTask.map((r) => mkRun(r.armB)),
    E1: perTask.map((r) => mkRun(r.armB)),
    E2: perTask.map((r) => ({
      ...mkRun(r.armB),
      policy_violations: 0,
      egress_attempts: 0,
      authority_claims: 0,
    })),
  };
  const tokens = {
    B: perTask.map((r) => r.armA.duration_ms),
    D: perTask.map((r) => r.armB.duration_ms),
  };
  const gate = evaluateGate({ arms, tokens }, { resamples, seed });

  const result = {
    kind: 'mechanical_dry_run',
    disclaimer: DRY_RUN_DISCLAIMER,
    protocol: {
      hash: registration.protocol_hash,
      db_path: dbPath,
      registered: registration.registered,
      seq: registration.seq,
      idempotent_repeat: {
        registered: registrationRepeat.registered,
        already_registered: registrationRepeat.already_registered,
      },
    },
    tasks: perTask.map((r) => ({
      task_id: r.task.task_id,
      cluster: r.task.cluster,
      stage: r.task.stage,
      armA: r.armA,
      armB: r.armB,
    })),
    expectations,
    gate,
    params: { resamples, seed },
  };

  mkdirSync(outDir, { recursive: true });
  const reportPath = join(outDir, 'DRY-RUN-REPORT.md');
  writeFileSync(reportPath, renderDryRunReport(result), 'utf8');
  result.report_path = reportPath;
  return result;
}

function fmt(x, digits = 4) {
  return Number.isFinite(x) ? x.toFixed(digits) : String(x);
}

function renderDryRunReport(r) {
  const lines = [];
  lines.push('# Soul 4.0 — Mechanischer A/B-Dry-Run (Phase 1A)');
  lines.push('');
  lines.push(`> **${r.disclaimer}**`);
  lines.push('');
  lines.push('Generiert von `eval/pilot/run-dry.mjs` (Skript, kein Handbetrieb).');
  lines.push('Zweck: beweisen, dass Task-Ausführung → Outcome → vorregistrierte');
  lines.push('Statistik-Pipeline (applyITT → Bootstrap-p → Holm → deterministische');
  lines.push('Gates in `evaluateGate`) end-to-end MECHANISCH funktioniert.');
  lines.push('');
  lines.push('## Protokoll-Hash (vor dem Lauf registriert)');
  lines.push('');
  lines.push(`- \`protocol_hash\`: \`${r.protocol.hash}\``);
  lines.push(`- Registrierung: ${r.protocol.registered ? `neu geschrieben (seq ${r.protocol.seq})` : 'bereits vorhanden (No-op)'} — Wegwerf-Ledger-DB, NICHT das Live-Ledger`);
  lines.push(`- Idempotenz-Beweis (zweiter Aufruf): registered=${r.protocol.idempotent_repeat.registered}, already_registered=${r.protocol.idempotent_repeat.already_registered}`);
  lines.push('');
  lines.push('## Echte Verifier-Prozessläufe (3 Aufgaben, Stufen 1/3/5)');
  lines.push('');
  lines.push('| Task | Stufe | Arm A (Fixture) | Arm B (Referenzlösung) | A ms | B ms |');
  lines.push('|---|---|---|---|---|---|');
  for (const t of r.tasks) {
    lines.push(
      `| ${t.task_id} | ${t.stage} | ${t.armA.outcome} (exit ${t.armA.exit_code}) | ${t.armB.outcome} (exit ${t.armB.exit_code}) | ${fmt(t.armA.duration_ms, 0)} | ${fmt(t.armB.duration_ms, 0)} |`
    );
  }
  lines.push('');
  lines.push(`Erwartung erfüllt: Arm A überall fail = **${r.expectations.armA_all_fail}**, Arm B überall pass = **${r.expectations.armB_all_pass}**.`);
  lines.push('');
  lines.push('## Slot-Belegung für evaluateGate (mechanisch, deklariert)');
  lines.push('');
  lines.push('| Protokoll-Slot | Belegung im Dry-Run |');
  lines.push('|---|---|');
  lines.push('| B | Arm A — unverändertes Fixture (Verifier muss fail) |');
  lines.push('| C, D, E1, E2 | Arm B — Referenzlösungs-Overlay (Verifier muss pass); E2 mit Null-Toleranz-Zählern = 0 |');
  lines.push('| tokens.B / tokens.D | Verifier-Laufzeit in ms als Zahlenstrom (kein Modell ⇒ keine Tokens; reiner Code-Pfad-Beweis) |');
  lines.push('');
  lines.push('## Ergebnis der vorregistrierten Pipeline (evaluateGate)');
  lines.push('');
  lines.push(`- Familie: ${r.gate.family.join(', ')} · family_alpha ${r.gate.family_alpha} · resamples ${r.gate.params.resamples} · seed ${r.gate.params.seed}`);
  lines.push('');
  lines.push('| Vergleich | Punktschätzer | roh p | Holm p | bestanden |');
  lines.push('|---|---|---|---|---|');
  for (const name of r.gate.family) {
    const c = r.gate.comparisons[name];
    lines.push(`| ${name} | ${fmt(c.estimate)} | ${fmt(c.p, 6)} | ${fmt(c.p_holm, 6)} | ${c.pass} |`);
  }
  lines.push('');
  lines.push(`- Kosten-Gate (Laufzeit-ms-Stand-in): median(D)=${fmt(r.gate.cost_gate.medianD, 0)} ≤ ${r.gate.cost_gate.factor}·median(B)=${fmt(r.gate.cost_gate.factor * r.gate.cost_gate.medianB, 0)} → ${r.gate.cost_gate.pass}`);
  lines.push(`- Gesamtverdict: **${r.gate.pass}**`);
  lines.push('');
  lines.push('Mechanisch erwartet und korrekt: C_vs_B wird abgelehnt (Differenz +1 je');
  lines.push('Task), D_vs_C NICHT (identische Slot-Belegung ⇒ Differenz 0 an Grenze 0 ⇒');
  lines.push('p = 1), Gesamtverdict false. Ein "pass" wäre hier ein Pipeline-Bug —');
  lines.push('dieses Verdict ist der Funktionsbeweis, keine Messaussage.');
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Varianz-Pilot: 3 Aufgaben × 5 Wiederholungen, mechanische Ebene.
// ---------------------------------------------------------------------------

export const PILOT_DISCLAIMER =
  'Mechanischer Pilot — die Ergebnis-Varianz echter Modell-Läufe ist damit NICHT gemessen; die konfirmatorische Stichprobenzahl kann erst nach echten Modell-Pilotläufen fixiert werden. Dieser Pilot fixiert nur: Verifier-Determinismus bestätigt, Harness funktionsfähig, Rechenweg der Power-Fixierung implementiert und getestet.';

/**
 * Varianz-Pilot-Harness (F15: 3 Aufgaben × 5 Läufe), mechanische Ebene:
 * - Determinismus: Outcome-Varianz MUSS 0 sein (Arm A immer fail, Arm B immer
 *   pass) — das IST der Pilot-Zweck auf dieser Ebene: Verifier-Stabilität.
 * - Laufzeit-Varianz (real interessant): Varianzzerlegung σ²_b/σ²_w über die
 *   Arm-B-Laufzeiten und daraus die Beispiel-Power-Rechnung nach F15
 *   (task-zentriert, einseitig α = 0.05, Power 0.8).
 *
 * @param {{outDir?:string, repeats?:number}} opts
 */
export function runPilot(opts = {}) {
  const outDir = opts.outDir ?? PILOT_DIR;
  const repeats = opts.repeats ?? PILOT_REPEATS;

  const perTask = PILOT_TASKS.map((task) => {
    const armA = [];
    const armB = [];
    for (let i = 0; i < repeats; i++) {
      armA.push(runVerifierOnce(task, { withSolution: false }));
      armB.push(runVerifierOnce(task, { withSolution: true }));
    }
    return { task, armA, armB };
  });

  // Determinismus: pro Task und Arm genau EIN Outcome, und zwar der erwartete.
  const determinism = perTask.map((r) => {
    const aOutcomes = [...new Set(r.armA.map((x) => x.outcome))];
    const bOutcomes = [...new Set(r.armB.map((x) => x.outcome))];
    return {
      task_id: r.task.task_id,
      armA_outcomes: aOutcomes,
      armB_outcomes: bOutcomes,
      outcome_variance_zero: aOutcomes.length === 1 && bOutcomes.length === 1,
      expected: aOutcomes.length === 1 && aOutcomes[0] === 'fail' && bOutcomes.length === 1 && bOutcomes[0] === 'pass',
    };
  });
  const determinismPass = determinism.every((d) => d.expected);

  // Laufzeit-Statistik (Sekunden) + Varianzzerlegung über Arm B.
  const runtime = perTask.map((r) => {
    const stats = (runs) => {
      const xs = runs.map((x) => x.duration_ms / 1000);
      const m = xs.reduce((a, b) => a + b, 0) / xs.length;
      const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
      return { mean_s: m, sd_s: Math.sqrt(v), values_s: xs };
    };
    return { task_id: r.task.task_id, armA: stats(r.armA), armB: stats(r.armB) };
  });
  const components = varianceComponents(runtime.map((r) => r.armB.values_s));

  // Beispiel-Power-Rechnung (F15): Δ = 20 % der mittleren Laufzeit (deklariertes
  // Beispiel — beim echten Piloten ist der Endpunkt pass@1 und Δ der Abstand
  // zur vorregistrierten Entscheidungsgrenze).
  const delta = 0.2 * components.grandMean;
  const powerTable = [1, 2, 3, 5, 10].map((R) =>
    requiredTasks({ sigmaB2: components.sigmaB2, sigmaW2: components.sigmaW2, repeats: R, delta })
  );

  const result = {
    kind: 'mechanical_variance_pilot',
    disclaimer: PILOT_DISCLAIMER,
    design: { tasks: PILOT_TASKS.length, repeats, runs_total: PILOT_TASKS.length * repeats * 2 },
    determinism,
    determinism_pass: determinismPass,
    runtime,
    variance_components: components,
    power_example: { delta_s: delta, alpha: 0.05, power: 0.8, table: powerTable },
  };

  mkdirSync(outDir, { recursive: true });
  const reportPath = join(outDir, 'PILOT-REPORT.md');
  writeFileSync(reportPath, renderPilotReport(result), 'utf8');
  result.report_path = reportPath;
  return result;
}

function renderPilotReport(r) {
  const lines = [];
  lines.push('# Soul 4.0 — Varianz-Pilot, mechanische Ebene (F15, Phase 1A)');
  lines.push('');
  lines.push(`> **${r.disclaimer}**`);
  lines.push('');
  lines.push(`Generiert von \`eval/pilot/run-pilot.mjs\`. Design: ${r.design.tasks} Aufgaben × ${r.design.repeats} Wiederholungen × 2 Arme = ${r.design.runs_total} echte Verifier-Prozessläufe.`);
  lines.push('');
  lines.push('## Verifier-Determinismus (Outcome-Varianz muss 0 sein)');
  lines.push('');
  lines.push('| Task | Arm-A-Outcomes (5×) | Arm-B-Outcomes (5×) | Varianz 0 | erwartet (A fail / B pass) |');
  lines.push('|---|---|---|---|---|');
  for (const d of r.determinism) {
    lines.push(`| ${d.task_id} | ${d.armA_outcomes.join(',')} | ${d.armB_outcomes.join(',')} | ${d.outcome_variance_zero} | ${d.expected} |`);
  }
  lines.push('');
  lines.push(`Determinismus bestätigt: **${r.determinism_pass}**`);
  lines.push('');
  lines.push('## Laufzeit-Varianz (real gemessen, Sekunden)');
  lines.push('');
  lines.push('| Task | Arm A mean ± sd | Arm B mean ± sd |');
  lines.push('|---|---|---|');
  for (const t of r.runtime) {
    lines.push(`| ${t.task_id} | ${fmt(t.armA.mean_s, 3)} ± ${fmt(t.armA.sd_s, 3)} | ${fmt(t.armB.mean_s, 3)} ± ${fmt(t.armB.sd_s, 3)} |`);
  }
  lines.push('');
  const c = r.variance_components;
  lines.push(`Varianzzerlegung über Arm-B-Laufzeiten: σ²_between = ${fmt(c.sigmaB2, 6)}, σ²_within = ${fmt(c.sigmaW2, 6)} (Grand Mean ${fmt(c.grandMean, 3)} s).`);
  lines.push('');
  lines.push('## Beispiel-Power-Rechnung (F15: task-zentriert, einseitig α = 0.05, Power 0.8)');
  lines.push('');
  lines.push(`Rechenweg: T = ⌈(z₀.₉₅ + z₀.₈)² · (σ²_b + σ²_w/R) / Δ²⌉ mit Beispiel-Δ = 20 % der mittleren Laufzeit = ${fmt(r.power_example.delta_s, 4)} s.`);
  lines.push('');
  lines.push('| Repeats R | erforderliche Tasks T | Gesamtläufe T·R |');
  lines.push('|---|---|---|');
  for (const row of r.power_example.table) {
    lines.push(`| ${row.repeats} | ${row.tasks} | ${row.totalRuns} |`);
  }
  lines.push('');
  lines.push('Sobald σ²_between > 0 wächst der Gesamtaufwand T·R mit R — mechanische');
  lines.push('Bestätigung der F15-Regel "mehr unabhängige Aufgaben schlägt mehr Repeats".');
  lines.push('');
  lines.push('## Ehrlich offen');
  lines.push('');
  lines.push('- Die Beispiel-Zahlen oben sind LAUFZEIT-Sekunden, nicht pass@1: ohne echte');
  lines.push('  Modell-Läufe existiert keine Outcome-Varianz (Verifier sind deterministisch).');
  lines.push('- Die konfirmatorische Wiederholungszahl wird erst nach echten Modell-');
  lines.push('  Pilotläufen fixiert und dann als sichtbare Protokoll-Revision nachgetragen');
  lines.push('  (EVAL-PROTOCOL.md §3/§5), BEVOR die erste konfirmatorische Welle startet.');
  lines.push('');
  return lines.join('\n');
}
