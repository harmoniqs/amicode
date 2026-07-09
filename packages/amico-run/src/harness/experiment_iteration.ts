// Experiment-iteration harness driver — the CONTROL-FLOW half of the harness
// reframe (spec-20260708-112732 §3.2/§4.3, plan slice B4). This is the module
// that DISSOLVES the 1117-line LLM `orchestrator` for one iteration: the loop
// (select target → dispatch one experimenter leaf → run the solve → re-rollout
// verify → record + gate promotion) is deterministic CODE, not an agent prompt.
//
// The ONLY place a model enters is `dispatchExperimenter` — a single, flat,
// depth-1 leaf that authors the Julia script. Everything around it is code:
//   - the SolveSpec is DERIVED from the iteration score (data), not authored by
//     the model — so tier/source/env are not the LLM's judgment;
//   - the launch goes through the `amico-run` CLI (the §7.3 "harness calls the
//     CLI directly" spine), which runs the launch gate and the tier-2/3
//     re-rollout verification;
//   - promotion is gated on the re-rollout `agree` verdict, in code.
//
// The leaf dispatch is a pluggable seam so the loop is testable with NO model in
// the control-flow path. In production it is wired to `opencode run --agent
// experimenter` (headless, fire-and-forget → returns the authored script path)
// per §3.2; in tests/the demo it is a deterministic fake.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { atomicWriteFile } from "../run_dir.js";
import { isVerifiedTier } from "../verify.js";
import type { IterationScore, IterationTarget, Tier } from "./iteration_score.js";

/** What the experimenter leaf returns: the Julia script it authored. The leaf's
 *  job is authoring ONLY — the SolveSpec (tier/source/env) is derived from the
 *  score by the driver, so trust-tier selection is never the model's call. */
export interface AuthoredScript {
  scriptPath: string;
  /** Optional free text the leaf reports (logged for provenance; never control). */
  note?: string;
}

export interface DispatchContext {
  /** Scratch dir the leaf may author its script into. */
  workdir: string;
  /** 1-based iteration index (this prototype runs exactly one). */
  iteration: number;
}

/** The single model seam. Flat / depth-1: the dispatched leaf holds no `task`/
 *  `Agent` grant, so it cannot itself spawn children. */
export type ExperimenterDispatch = (target: IterationTarget, ctx: DispatchContext) => Promise<AuthoredScript>;

export interface IterationDeps {
  /** The one model call in the whole loop. */
  dispatchExperimenter: ExperimenterDispatch;
  /** Scratch/work dir for the authored script + the iteration record. */
  workdir: string;
  /** Where the solve run dir is created (amico-run --runs-root). */
  runsRoot: string;
  /** Absolute path to the built amico-run CLI bundle (dist/amico-run.js). */
  amicoRunBundle: string;
  /** Julia binary the solve runs under. */
  juliaBin: string;
  /** Lab pointer for the SolveSpec + run dir. Default "default". */
  labId?: string;
  /** node binary that runs the bundle. Default "node". */
  nodeBin?: string;
  /** Extra env for the CLI child (AMICO_AUTHORING_FILE, AMICO_VERIFY_RUNNER, …). */
  env?: Record<string, string>;
  /** Structured log sink (the demo prints these to show the deterministic steps). */
  logger?: (line: string) => void;
}

export interface IterationOutcome {
  scoreId: string;
  target: IterationTarget;
  /** How many experimenter leaves were dispatched — always 1 (flat, depth-1). */
  dispatched: number;
  authoredScript?: string;
  runDir?: string;
  status?: "completed" | "failed" | "aborted";
  /** Re-rollout verdict: true/false for a verified tier, null when the tier is
   *  not verified (vetted) or no verification line was emitted. */
  verified: boolean | null;
  /** Promotion decision, gated on `agree` for verified tiers (verify.promote_on). */
  promoted: boolean;
  promoteReason: string;
  /** Set when the iteration could not complete (dispatch/launch fault). */
  error?: string;
}

/** SolveSpec object derived from the score target — NOT authored by the model. */
function buildSolveSpec(target: IterationTarget, scriptPath: string, labId: string): Record<string, unknown> {
  const spec: Record<string, unknown> = {
    schema_version: "2",
    script_path: scriptPath,
    lab_id: labId,
    executor: "local",
    tier: target.tier,
    env: target.env ?? { kind: "provisioned" },
  };
  if (target.gate) spec.gate = target.gate;
  const source: Record<string, string> = {};
  if (target.tier === "composed" && target.exemplar_id) source.exemplar_id = target.exemplar_id;
  if (target.tier === "vetted" && target.template_id) source.template_id = target.template_id;
  if (Object.keys(source).length) spec.source = source;
  return spec;
}

interface LaunchResult {
  code: number;
  status?: "completed" | "failed" | "aborted";
  exitCode?: number;
  runDir?: string;
  verified: boolean | null;
  stdout: string;
  stderr: string;
}

/** Launch the authored solve through the amico-run CLI and parse its stdout
 *  protocol lines (AMICODE_FINISHED / AMICODE_VERIFIED). The CLI runs the launch
 *  gate and, for verified tiers, the independent re-rollout — the harness does
 *  not re-implement either; it calls the spine and reads the verdicts. */
function launchSolve(specPath: string, scriptPath: string, deps: IterationDeps): Promise<LaunchResult> {
  const args = [
    deps.amicoRunBundle,
    scriptPath,
    "--spec",
    specPath,
    "--runs-root",
    deps.runsRoot,
    "--julia",
    deps.juliaBin,
  ];
  return new Promise((resolvePromise) => {
    const child = spawn(deps.nodeBin ?? "node", args, {
      env: { ...process.env, ...(deps.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (e) => resolvePromise({ code: 127, verified: null, stdout, stderr: stderr + String(e) }));
    child.on("close", (code) => {
      const fin = /AMICODE_FINISHED status=(\w+) exitCode=(-?\d+) runDir=(\S+)/.exec(stdout);
      const ver = /AMICODE_VERIFIED agree=(true|false)/.exec(stdout);
      resolvePromise({
        code: code ?? 1,
        status: fin ? (fin[1] as LaunchResult["status"]) : undefined,
        exitCode: fin ? Number(fin[2]) : undefined,
        runDir: fin ? fin[3] : undefined,
        verified: ver ? ver[1] === "true" : null,
        stdout,
        stderr,
      });
    });
  });
}

const tq = (s: string): string => JSON.stringify(s); // JSON escaping is valid TOML basic-string

/** Bookkeeping (spec §2: bookkeeping → tools): the deterministic outcome record.
 *  This is what a librarian/distiller would consume; no model writes it. */
function writeIterationRecord(deps: IterationDeps, o: IterationOutcome): void {
  const lines = [
    `schema_version = 1`,
    `score_id = ${tq(o.scoreId)}`,
    `platform = ${tq(o.target.platform)}`,
    ...(o.target.gate ? [`gate = ${tq(o.target.gate)}`] : []),
    `kind = ${tq(o.target.kind)}`,
    `size = ${o.target.size}`,
    `tier = ${tq(o.target.tier)}`,
    `dispatched_experimenters = ${o.dispatched}`,
    ...(o.authoredScript ? [`authored_script = ${tq(o.authoredScript)}`] : []),
    ...(o.runDir ? [`run_dir = ${tq(o.runDir)}`] : []),
    ...(o.status ? [`status = ${tq(o.status)}`] : []),
    `verified = ${o.verified === null ? tq("none") : o.verified}`,
    `promoted = ${o.promoted}`,
    `promote_reason = ${tq(o.promoteReason)}`,
    ...(o.error ? [`error = ${tq(o.error)}`] : []),
  ];
  atomicWriteFile(deps.workdir, "iteration.toml", lines.join("\n") + "\n");
}

/**
 * Run ONE experiment iteration, driven end-to-end by this code (the score + this
 * driver), with a single flat experimenter leaf. Returns the outcome; also
 * writes `iteration.toml` into `deps.workdir`. Never throws — a dispatch or
 * launch fault becomes a recorded, un-promoted outcome (an orchestrator that
 * crashes is worse than one that records a failure).
 */
export async function runExperimentIteration(score: IterationScore, deps: IterationDeps): Promise<IterationOutcome> {
  const log = deps.logger ?? (() => {});
  const labId = deps.labId ?? "default";
  const tier: Tier = score.target.tier;
  mkdirSync(deps.workdir, { recursive: true });
  mkdirSync(deps.runsRoot, { recursive: true });

  // ── step 1: select/receive the target (deterministic, from the score data) ──
  const target = score.target;
  log(`[harness] iteration for score "${score.id}": ${target.platform}/${target.gate ?? target.kind} tier=${tier}`);

  const base: IterationOutcome = {
    scoreId: score.id,
    target,
    dispatched: 0,
    verified: null,
    promoted: false,
    promoteReason: "",
  };

  // ── step 2: dispatch ONE experimenter leaf (flat / depth-1) — the sole model call ──
  let authored: AuthoredScript;
  try {
    log(`[harness] dispatching experimenter leaf (flat, depth-1)…`);
    authored = await deps.dispatchExperimenter(target, { workdir: deps.workdir, iteration: 1 });
  } catch (e) {
    const outcome: IterationOutcome = {
      ...base,
      dispatched: 1,
      promoteReason: "experimenter dispatch failed",
      error: `dispatch: ${(e as Error).message}`,
    };
    log(`[harness] experimenter dispatch FAILED: ${outcome.error}`);
    writeIterationRecord(deps, outcome);
    return outcome;
  }
  base.dispatched = 1;
  base.authoredScript = authored.scriptPath;
  log(`[harness] experimenter authored ${authored.scriptPath}${authored.note ? ` — ${authored.note}` : ""}`);

  // ── step 3: derive the SolveSpec from the score (NOT the model) + launch via the CLI ──
  const spec = buildSolveSpec(target, authored.scriptPath, labId);
  const specPath = `${deps.workdir}/solvespec.json`;
  atomicWriteFile(deps.workdir, "solvespec.json", JSON.stringify(spec, null, 2) + "\n");
  log(`[harness] launching solve via amico-run (tier=${tier}, verify=${isVerifiedTier(tier)})…`);
  const launch = await launchSolve(specPath, authored.scriptPath, deps);
  if (!launch.runDir) {
    const outcome: IterationOutcome = {
      ...base,
      promoteReason: "solve launch produced no run dir",
      error: `launch exit ${launch.code}: ${(launch.stderr || launch.stdout).trim().split("\n").slice(-1)[0] ?? ""}`,
    };
    log(`[harness] solve launch FAILED: ${outcome.error}`);
    writeIterationRecord(deps, outcome);
    return outcome;
  }
  log(`[harness] solve ${launch.status} in ${launch.runDir} (re-rollout agree=${launch.verified})`);

  // ── step 4: record outcome + gate promotion on the re-rollout verdict ──
  const verifiedTier = isVerifiedTier(tier);
  let promoted = false;
  let promoteReason: string;
  if (launch.status !== "completed") {
    promoteReason = `not promoted: solve ${launch.status ?? "unknown"}`;
  } else if (verifiedTier && launch.verified !== true) {
    promoteReason = "not promoted: re-rollout did not agree (promote_on=agree)";
  } else if (verifiedTier) {
    promoted = true;
    promoteReason = "promoted: re-rollout agreed";
  } else {
    // vetted tier: trusted by its template, no re-rollout gate
    promoted = true;
    promoteReason = "promoted: vetted tier (template-trusted, no re-rollout)";
  }

  const outcome: IterationOutcome = {
    ...base,
    runDir: launch.runDir,
    status: launch.status,
    verified: launch.verified,
    promoted,
    promoteReason,
  };
  log(`[harness] outcome: promoted=${promoted} (${promoteReason})`);
  writeIterationRecord(deps, outcome);
  return outcome;
}
