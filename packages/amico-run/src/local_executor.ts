import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants, createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { delimiter, join, resolve } from "node:path";
import * as readline from "node:readline";
import { parse as tomlParse, stringify as tomlStringify } from "smol-toml";
import { EventQueue } from "./event_queue.js";
import { appendRecord, type SolveOutcome, type SolveRecord, type SolveSummary } from "./ledger.js";
import { classifyLine } from "./telemetry.js";
import {
  appendIndex,
  atomicWriteFile,
  defaultRunsRoot,
  deriveLabId,
  generateRunId,
  updateLatest,
  writeFinished,
  writeManifest,
} from "./run_dir.js";
import {
  ConfigError,
  type Executor,
  type Finished,
  type RunEvent,
  type RunHandle,
  type RunStatus,
  type SubmitOpts,
} from "./types.js";

import pkg from "../package.json" with { type: "json" };
const ORCHESTRATOR_VERSION = pkg.version; // single source of truth (esbuild inlines the JSON)

// solvespec v4 problem_spec routing: instead of running an authored script, drive
// the generic typed-spec runner. `julia -e '<PROBLEM_SPEC_RUNNER>' <path>` puts the
// spec path at ARGS[1]; cwd is the run dir, so run_dir=pwd() lands artifacts there.
const PROBLEM_SPEC_RUNNER = "using Piccolo; Piccolo.Specs.solve_spec(ARGS[1]; run_dir=pwd())";

function resolveExecutable(bin: string): void {
  const candidates = bin.includes("/")
    ? [resolve(bin)]
    : (process.env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((d) => join(d, bin));
  for (const c of candidates) {
    try {
      accessSync(c, fsConstants.X_OK);
      return;
    } catch {
      /* keep looking */
    }
  }
  throw new ConfigError(`julia binary not found or not executable: ${bin}`);
}

function signalCode(signal: NodeJS.Signals | null): number {
  const n = signal ? (osConstants.signals as Record<string, number>)[signal] : undefined;
  return 128 + (n ?? 1);
}

// ── the `solve` ledger stanza (Plan 3 / L1 Task 5) ──────────────────────────
// After a run settles, derive + append ONE `solve` record from the run dir's
// on-disk artifacts. Design split (engineering-brief mandate, not a guess):
//   - structure_hash / problem_hash / versions / converged  ← result.toml [params]
//     (the "regime the run actually solved" — self-describing, additionalProperties:true)
//   - base summary (platform/template/trajectory/N/T/goal/solver/strategy) AND
//     the recommendable knobs (Q/R/du_bound/max_iter/integrator — CRITICAL: without
//     these ledger_query's medians are permanently empty, silently breaking L-A)
//     ← the solvespec, i.e. the typed ProblemSpec that run.toml's script_path
//     resolves to (inline problem_spec → <runDir>/problem.toml; a path problem_spec
//     → that path directly; script_path routing to an authored .jl script has no
//     ProblemSpec, so no ledger record is derivable — see readSpecFromScriptPath).
// Any read/parse/validation failure is caught and logged: a ledger hiccup must
// NEVER fail the run itself.
function readTomlSafe(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return tomlParse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** No explicit "platform" field exists on the typed ProblemSpec — derive one from
 *  `system.template` (an enum of System type names, e.g. "MultiTransmonSystem")
 *  by stripping the "System" suffix and snake_casing. Best-effort/informational
 *  only: `structure_hash`, not this string, is the actual ledger join key. */
function platformFromTemplate(template: string): string {
  const base = template.endsWith("System") ? template.slice(0, -"System".length) : template;
  return base.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/** A script_path is only a ProblemSpec (not an authored .jl script) when it parses
 *  as TOML AND has a `system` table (the ProblemSpec's one universally-required
 *  field) — an authored Julia script is not valid TOML and fails the parse. */
function readSpecFromScriptPath(scriptPath: string): Record<string, unknown> | undefined {
  const spec = readTomlSafe(scriptPath);
  if (!spec || !isRecord(spec.system)) return undefined;
  return spec;
}

/** Base summary + recommendable-knob fields derived from a typed ProblemSpec,
 *  mirroring @amicode/schema hashing.ts's structureFields/fullDict field mapping
 *  (kept in sync deliberately — same source object, same field names). */
function summaryFromProblemSpec(spec: Record<string, unknown>): Partial<SolveSummary> {
  const system = isRecord(spec.system) ? spec.system : {};
  const goal = isRecord(spec.goal) ? spec.goal : {};
  const pulse = isRecord(spec.pulse) ? spec.pulse : {};
  const problem = isRecord(spec.problem) ? spec.problem : {};
  const solver = isRecord(spec.solver) ? spec.solver : {};
  const trajectory = isRecord(spec.trajectory) ? spec.trajectory : {};
  const integrator = isRecord(spec.integrator) ? spec.integrator : {};

  const out: Partial<SolveSummary> & Record<string, unknown> = {};
  if (typeof system.template === "string") out.platform = platformFromTemplate(system.template);
  if (typeof problem.template === "string") out.template = problem.template;
  if (typeof trajectory.kind === "string") out.trajectory = trajectory.kind;
  else if (typeof goal.kind === "string") out.trajectory = goal.kind;
  if (typeof problem.N === "number") out.N = problem.N;
  if (typeof pulse.T === "number") out.T = pulse.T;
  if (typeof goal.gate === "string") out.goal = goal.gate;
  else if (typeof goal.kind === "string") out.goal = goal.kind;
  out.solver = typeof solver.backend === "string" ? solver.backend : "ipopt";
  out.strategy = typeof solver.strategy === "string" ? solver.strategy : "direct";
  const sysParams = isRecord(system.params) ? system.params : undefined;
  if (sysParams && typeof sysParams.levels === "number") out.levels = sysParams.levels;

  // CRITICAL (Task-4 handoff): the recommendable knobs — ledger_query's medians
  // are permanently empty without these, which silently breaks L-A retrieval.
  if (typeof problem.Q === "number") out.Q = problem.Q;
  if (typeof problem.R === "number") out.R = problem.R;
  if (typeof problem.du_bound === "number") out.du_bound = problem.du_bound;
  if (typeof solver.max_iter === "number") out.max_iter = solver.max_iter;
  if (typeof integrator.alg === "string") out.integrator = integrator.alg;
  return out;
}

const SUMMARY_REQUIRED = ["platform", "template", "trajectory", "N", "T", "goal", "solver", "strategy"] as const;
function isCompleteSummary(s: Partial<SolveSummary>): s is SolveSummary {
  return SUMMARY_REQUIRED.every((k) => s[k] !== undefined);
}

function emitSolveStanza(runDir: string): void {
  try {
    const result = readTomlSafe(join(runDir, "result.toml"));
    if (!result) return; // no result written (e.g. a bare script that doesn't emit one) — nothing to ledger

    const params = isRecord(result.params) ? result.params : {};
    const manifest = readTomlSafe(join(runDir, "run.toml"));
    const manifestHashes = isRecord(manifest?.hashes) ? manifest.hashes : {};
    // W4.1: fall back to run.toml [hashes] when result.toml lacks the keys
    // (script-authored runs never have result.toml [params] hashes today).
    let structureHash = typeof params.structure_hash === "string" ? params.structure_hash : undefined;
    let problemHash = typeof params.problem_hash === "string" ? params.problem_hash : undefined;
    if (!structureHash && typeof manifestHashes.structure_hash === "string") structureHash = manifestHashes.structure_hash;
    if (!problemHash && typeof manifestHashes.problem_hash === "string") problemHash = manifestHashes.problem_hash;
    if (typeof structureHash !== "string" || typeof problemHash !== "string") return; // no join key — skip

    const scriptPath = typeof manifest?.script_path === "string" ? manifest.script_path : undefined;
    // W4.1: for spec-authored runs, the ProblemSpec is the summary source — try
    // inline problem.toml first (the run's own spec), then scriptPath fallback.
    let spec: Record<string, unknown> | undefined;
    const inlineSpec = readTomlSafe(join(runDir, "problem.toml"));
    if (inlineSpec && isRecord(inlineSpec.system)) spec = inlineSpec;
    else if (scriptPath) spec = readSpecFromScriptPath(scriptPath);
    if (!spec) return; // base summary (per the design split above) comes from the solvespec only

    const summary = summaryFromProblemSpec(spec);
    if (!isCompleteSummary(summary)) return;

    const fidelity = typeof result.fidelity === "number" ? result.fidelity : undefined;
    const iterations = typeof result.iterations === "number" ? result.iterations : undefined;
    if (fidelity === undefined || iterations === undefined) return; // required by the ledger-record schema

    const outcome: SolveOutcome = {
      converged: typeof params.converged === "boolean" ? params.converged : true,
      fidelity,
      iterations,
    };
    if (typeof result.wall_seconds === "number") outcome.wall_s = result.wall_seconds;

    const tier =
      typeof manifest?.tier === "string" ? manifest.tier : typeof params.tier === "string" ? params.tier : "unspecified";

    const rec: SolveRecord = {
      type: "solve",
      ts: new Date().toISOString(),
      structure_hash: structureHash,
      problem_hash: problemHash,
      kind: typeof params.kind === "string" ? params.kind : "control",
      tier,
      summary,
      // $AMICO_LEDGER_SOURCE lets L-I's nightly replay stamp "replay" so its runs
      // never pollute L-A's per-structure priors (spec: priors are source="user" only).
      source: (process.env.AMICO_LEDGER_SOURCE as SolveRecord["source"] | undefined) ?? "user",
      outcome,
    };
    if (isRecord(params.versions)) {
      const versions: Record<string, string> = {};
      for (const [k, v] of Object.entries(params.versions)) if (typeof v === "string") versions[k] = v;
      rec.versions = versions;
    }
    if (typeof params.session === "string") rec.session = params.session;
    if (typeof params.problem === "string") rec.problem = params.problem;
    // The warrant join. `max_solves` is counted by matching solve rows against a
    // plan_hash (warrant_context.solvesUnderPlan), so this stamp is what makes the
    // bound enforce rather than sit at 0 forever. Source is the SOLVESPEC, not
    // run.toml: the spec is what the gate validated and what carries the field
    // (solvespec v5). Absent on an ungated free-set launch — omit rather than
    // writing an empty string, which minLength would reject and which would match
    // no warrant anyway.
    if (typeof spec.plan_hash === "string" && spec.plan_hash !== "") rec.plan_hash = spec.plan_hash;
    if (typeof params.warm_start === "string" || params.warm_start === null)
      rec.warm_start = params.warm_start as string | null;

    appendRecord(rec); // validates against the ledger-record schema; throws on invalid/oversize
  } catch (e) {
    process.stderr.write(`amico-run: failed to emit solve ledger stanza: ${(e as Error).message}\n`);
  }
}

export class LocalExecutor implements Executor {
  async submit(scriptPath: string | undefined, opts: SubmitOpts = {}): Promise<RunHandle> {
    // ---- step 1 (spec §5): validate config; failures here create NO run dir ----
    // Two shapes: a normal script run, or a v4 problem_spec run (route to
    // Piccolo.Specs.solve_spec). For problem_spec, `script` (recorded as the
    // run.toml script_path) is the spec artifact: a string path resolves + must
    // exist now; an inline object is written to <runDir>/problem.toml AFTER the
    // manifest (path known once runDir exists — filled in step 2 below).
    const problemSpec = opts.spec?.problem_spec;
    const inlineProblemSpec = problemSpec !== undefined && typeof problemSpec !== "string";
    let script: string;
    let problemSpecPath: string | undefined; // absolute path passed to solve_spec as ARGS[1]
    if (problemSpec !== undefined) {
      if (typeof problemSpec === "string") {
        problemSpecPath = resolve(problemSpec);
        if (!existsSync(problemSpecPath)) throw new ConfigError(`problem_spec not found: ${problemSpecPath}`);
        script = problemSpecPath;
      } else {
        script = ""; // filled after runDir exists (inline → <runDir>/problem.toml)
      }
    } else {
      if (scriptPath === undefined) throw new ConfigError("no script or problem_spec given");
      script = resolve(scriptPath);
      if (!existsSync(script)) throw new ConfigError(`script not found: ${script}`);
    }
    const juliaBin = opts.julia?.julia ?? "julia";
    resolveExecutable(juliaBin);
    const lab = opts.lab ?? "default";
    const labId = deriveLabId(lab);
    const runsRoot = opts.runsRoot ?? defaultRunsRoot(labId);
    try {
      mkdirSync(runsRoot, { recursive: true });
    } catch (e) {
      throw new ConfigError(`runs root not writable: ${runsRoot} (${(e as Error).message})`);
    }

    // ---- steps 2–5: run dir, manifest FIRST, index, latest ----
    const runId = generateRunId(runsRoot);
    const runDir = join(runsRoot, runId);
    mkdirSync(runDir);
    // inline problem_spec: its problem.toml lives in the run dir — now that runDir
    // exists, resolve the path so run.toml's script_path records it (written next).
    if (inlineProblemSpec) {
      problemSpecPath = join(runDir, "problem.toml");
      script = problemSpecPath;
    }
    const createdAt = new Date().toISOString();
    writeManifest(runDir, {
      // spec C: --spec launches stamp tier + hashes and bump to v2; bare runs stay v1
      schema_version: opts.spec ? "2" : "1",
      run_id: runId,
      script_path: script,
      lab,
      lab_id: labId,
      created_at: createdAt,
      orchestrator_version: ORCHESTRATOR_VERSION,
      julia: { binary: juliaBin, project: opts.julia?.project, sysimage: opts.julia?.sysimage },
      tier: opts.spec?.tier,
      hashes: opts.spec?.hashes,
    });
    // manifest is FIRST (above); an inline problem_spec's problem.toml follows it,
    // then solvespec.json — the run-dir contract's ordering is preserved.
    if (inlineProblemSpec)
      atomicWriteFile(runDir, "problem.toml", tomlStringify(problemSpec as Record<string, unknown>));
    if (opts.spec) atomicWriteFile(runDir, "solvespec.json", opts.spec.canonical + "\n");
    appendIndex(runsRoot, runId, createdAt, script);
    updateLatest(runsRoot, runId);

    // ---- step 6: spawn julia, own process group, cwd = runDir ----
    const args: string[] = [];
    if (opts.julia?.project) args.push(`--project=${opts.julia.project}`);
    if (opts.julia?.sysimage) args.push(`--sysimage=${opts.julia.sysimage}`);
    // problem_spec → the generic typed-spec runner; else the authored script.
    if (problemSpecPath !== undefined) args.push("-e", PROBLEM_SPEC_RUNNER, problemSpecPath);
    else args.push(script);

    const events = new EventQueue<RunEvent>();
    const logStream = createWriteStream(join(runDir, "run.log"), { flags: "a" });
    let resolveFinished!: (f: Finished) => void;
    const finished = new Promise<Finished>((r) => {
      resolveFinished = r;
    });

    let settled = false;
    let aborting = false;
    const settle = (status: RunStatus, exitCode: number): void => {
      if (settled) return;
      settled = true;
      try {
        writeFinished(runDir, status, exitCode); // orchestrator verdict, atomic — overwrites
      } catch (e) {
        // any FINISHED a script faked (spec §5 step 8)
        process.stderr.write(`amico-run: failed to write FINISHED: ${(e as Error).message}\n`);
      }
      emitSolveStanza(runDir); // Plan 3 / L1 Task 5 — never throws; a ledger hiccup must never fail a run

      // WAIT FOR run.log TO ACTUALLY FLUSH before announcing completion.
      //
      // `logStream.end()` is ASYNCHRONOUS: it schedules the flush and returns immediately. The
      // old code called it and then resolved `finished` / closed the event stream in the same
      // tick, so a consumer could await completion and read a TRUNCATED run.log — the events
      // queue is in-memory and complete while the file on disk is still short a line or two.
      //
      // This was an intermittent 1-in-4 failure in executor_parity.test.ts (local's iterLines
      // had 1 entry, remote's had 2, with both event streams identical) and it is a real product
      // bug, not just a test artifact: anything that reads run.log after a run reports finished —
      // the extension, a replay, a user tailing the file — could see a partial log. The
      // 'close'-not-'exit' comment above is what makes the EVENTS complete; nothing made the
      // FILE complete.
      let announced = false;
      const announce = (): void => {
        if (announced) return;
        announced = true;
        events.push({ kind: "finished", status, exitCode });
        events.close();
        resolveFinished({ status, exitCode });
      };
      // A stream that errors must not wedge the run: losing the tail of a log is bad, hanging
      // forever is worse. Both paths announce exactly once.
      logStream.once("error", announce);
      logStream.end(announce);
    };

    // stdbuf (spec §5 "where available") is deliberately omitted in β.1: the β.3 script
    // convention prints with flush, and the fake-julia fixtures are node (line-flushed).
    // If live ITER streaming degrades on a real lab machine, β.6's dry-run catches it.
    const child = spawn(juliaBin, args, {
      cwd: runDir,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // spawn failure AFTER manifest exists → FINISHED{failed, 127} (spec §6)
    child.on("error", () => settle("failed", 127));

    // 'close', NOT 'exit': close waits for stdout/stderr to drain, so every line event
    // lands before settle() — the events stream must terminate ON the finished event (§3).
    //
    // (I hypothesised a second bug here while fixing the run.log flush race below: that readline
    // could still have buffered lines when 'close' fires, making the `if (settled) return` guard
    // in onLine silently DROP them from both the log and the event stream. Gating settle() on the
    // readers' own 'close' events was tested against a 200-line script and made no difference —
    // readline does drain first in practice. Not shipped: it would add a wedge risk to a shipped
    // launch path (a reader that never closes would hang the run) to fix something that did not
    // reproduce. Recorded because the guard's own comment calls the ordering merely "rare", so
    // this is a known-unproven edge rather than a verified invariant.)
    child.on("close", (code, signal) => {
      const rc = code ?? signalCode(signal);
      settle(aborting ? "aborted" : rc === 0 ? "completed" : "failed", rc);
    });

    const onLine =
      (stream: "stdout" | "stderr") =>
      (line: string): void => {
        if (settled) return; // belt-and-braces; 'close' ordering makes this rare
        logStream.write(line + "\n");
        events.push(classifyLine(line, stream));
      };
    readline.createInterface({ input: child.stdout! }).on("line", onLine("stdout"));
    readline.createInterface({ input: child.stderr! }).on("line", onLine("stderr"));

    const graceMs = opts.graceMs ?? 5000;
    const abort = async (): Promise<void> => {
      if (settled) return;
      aborting = true;
      const killGroup = (sig: NodeJS.Signals): void => {
        try {
          process.kill(-child.pid!, sig);
        } catch {
          /* already gone */
        }
      };
      killGroup("SIGTERM");
      const killer = setTimeout(() => killGroup("SIGKILL"), graceMs);
      killer.unref();
      await finished;
      clearTimeout(killer);
    };

    return { runId, runDir, events, finished, abort };
  }
}
