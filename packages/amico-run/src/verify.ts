// Free-tier re-rollout verification invoke (spec C, v2 rollout referee — W2.5).
// After FINISHED, when the SolveSpec is tier "free", amico-run derives a typed
// rollout spec via `referee_rollout(control_spec, run)` — strictly finer in every
// resolution axis, different integrator family, forge-proof [referee] block
// re-validated at parse time — and runs it SYNCHRONOUSLY. This is the master spec's
// scoped exception to the never-launches invariant: rollouts are bounded,
// seconds-scale, produce no run_dir. The invariant continues to hold for
// control/tuning. The typed Verdict (Agree/Disagree) with witness fidelities is
// recorded; a rollout without a valid [referee] block yields no verdict by
// construction. The legacy `system_verify.jld2` snapshot is retired once the
// typed path is proven (the skeleton's CONTRACT block emitting it is the
// migration seam — retained as fallback until rollout is proven on it).
import { spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import type { AuthoringConfig } from "./authoring.js";
import type { SpecStamp } from "./types.js";

function tomlEscape(s: string): string {
  return JSON.stringify(s);
}

function writeFallback(runDir: string, reason: string, tolerance: number): void {
  const body =
    `schema_version = "1"\n` +
    `agree = false\n` +
    `fidelity_rerolled = "nan"\n` +
    `fidelity_reported = "nan"\n` +
    `tolerance = ${tolerance}\n` +
    `integrator = "none"\n` +
    `error = ${tomlEscape(reason)}\n`;
  const tmp = join(runDir, `.verification.toml.tmp-${process.pid}`);
  writeFileSync(tmp, body);
  renameSync(tmp, join(runDir, "verification.toml"));
}

function writeTypedVerdict(
  runDir: string,
  verdict: "agree" | "disagree",
  fidelity_rerolled: number,
  fidelity_reported: number,
  tolerance: number,
): void {
  const agree = verdict === "agree";
  const body =
    `schema_version = "1"\n` +
    `verdict = ${tomlEscape(verdict)}\n` +
    `agree = ${agree}\n` +
    `fidelity_rerolled = ${fidelity_rerolled}\n` +
    `fidelity_reported = ${fidelity_reported}\n` +
    `tolerance = ${tolerance}\n` +
    `integrator = "referee"\n`;
  const tmp = join(runDir, `.verification.toml.tmp-${process.pid}`);
  writeFileSync(tmp, body);
  renameSync(tmp, join(runDir, "verification.toml"));
}

/** Derive a rollout spec from the run's retained control spec (result.toml
 *  [params].spec or runDir/problem.toml). Returns undefined when no control spec
 *  is available — caller falls back to the legacy harness. The rollout spec is
 *  written to <runDir>/rollout.toml for the harness to consume; it carries a
 *  forge-proof [referee] block (run id, solve knots/integrator, reported fidelity)
 *  re-validated at parse time. */
function tryDeriveRolloutSpec(runDir: string): string | undefined {
  let controlSpec: Record<string, unknown> | undefined;
  // Prefer result.toml [params].spec (the runner persists it)
  try {
    const resultRaw = readFileSync(join(runDir, "result.toml"), "utf8");
    const result = parseToml(resultRaw) as Record<string, unknown>;
    const params = result?.params as Record<string, unknown> | undefined;
    if (params?.spec && typeof params.spec === "object") {
      controlSpec = params.spec as Record<string, unknown>;
    } else if (typeof params?.spec === "string") {
      // spec may be serialized TOML string
      try {
        controlSpec = parseToml(params.spec as string) as Record<string, unknown>;
      } catch {
        // not TOML — treat as missing
      }
    }
  } catch {
    // no result.toml yet
  }
  if (!controlSpec) {
    try {
      const probRaw = readFileSync(join(runDir, "problem.toml"), "utf8");
      controlSpec = parseToml(probRaw) as Record<string, unknown>;
    } catch {
      // no problem.toml either
    }
  }
  if (!controlSpec || typeof controlSpec.system !== "object") return undefined;

  // Build the rollout spec: strictly finer in every resolution axis, different
  // integrator family, forge-proof [referee] block.
  const pulsePath = join(runDir, "pulse.jld2");
  if (!existsSync(pulsePath)) return undefined;

  // Derive fidelity_reported from result.toml if available
  let fidelityReported = 0;
  try {
    const res = parseToml(readFileSync(join(runDir, "result.toml"), "utf8")) as Record<string, unknown>;
    if (typeof res.fidelity === "number") fidelityReported = res.fidelity;
  } catch {
    // leave 0
  }

  const problem = (controlSpec.problem as Record<string, unknown> | undefined) ?? {};
  const solveKnots = typeof problem.N === "number" ? problem.N : 40;
  const solveIntegrator = ((controlSpec.integrator as Record<string, unknown> | undefined)?.kind as string) ?? "bilinear";

  // Read run_id from run.toml for referee provenance
  let runId = "unknown";
  try {
    const runToml = parseToml(readFileSync(join(runDir, "run.toml"), "utf8")) as Record<string, unknown>;
    if (typeof runToml.run_id === "string") runId = runToml.run_id;
  } catch {
    // leave unknown
  }

  const rollout: Record<string, unknown> = {
    schema_version: 1,
    kind: "rollout",
    input_pulse: pulsePath,
    rollout_kind: ((controlSpec.goal as Record<string, unknown> | undefined)?.kind as string) ?? "unitary",
    alg: "tsit5",
    system: controlSpec.system,
    report: { fidelity: true, populations: false },
    referee: {
      run: runId,
      solve_knots: solveKnots,
      solve_integrator: solveIntegrator,
      fidelity_reported: fidelityReported,
    },
  };

  const rolloutPath = join(runDir, "rollout.toml");
  writeFileSync(rolloutPath, stringifyToml(rollout as never));
  return rolloutPath;
}

/** Derive rollout spec via referee_rollout(control_spec, run) (W2.5 v2 path).
 *  Synchronous, bounded, seconds-scale — the scoped exception to the never-launches
 *  invariant. Returns the rollout.toml path or undefined if no control spec is
 *  available (caller falls back to legacy harness). */
export function deriveRolloutSpec(runDir: string): string | undefined {
  return tryDeriveRolloutSpec(runDir);
}

/** Run the harness; guarantee a verification.toml exists afterward. Never rejects.
 *  v2: attempts the typed rollout referee path first (derived from retained control
 *  spec); falls back to the legacy system_verify.jld2 harness when no spec is
 *  available. The legacy path is retained until the typed path is proven on it
 *  (migration seam — then system_verify.jld2 is retired). */
export async function runVerification(runDir: string, spec: SpecStamp, authoring: AuthoringConfig): Promise<void> {
  const tolerance = authoring.verify_tolerance;
  const harness = authoring.verify_harness;
  if (!harness || !existsSync(harness)) {
    writeFallback(runDir, `verification harness not found (${harness ?? "unset"})`, tolerance);
    return;
  }
  // The harness interpreter is julia in production; AMICO_VERIFY_RUNNER overrides
  // it for tests (node fake-harness). The env's project comes from the spec.
  const runner = process.env.AMICO_VERIFY_RUNNER ?? spec.julia_binary ?? "julia";

  // ── v2 path: typed rollout referee ──
  const rolloutPath = tryDeriveRolloutSpec(runDir);
  const rolloutArgs =
    rolloutPath !== undefined
      ? runner === "julia" && spec.env_project
        ? [`--project=${spec.env_project}`, harness, runDir, String(tolerance), rolloutPath]
        : [harness, runDir, String(tolerance), rolloutPath]
      : undefined;

  const tryRun = async (args: string[]): Promise<number> => {
    const exitCode: number = await new Promise((resolvePromise) => {
      const child = spawn(runner, args, { stdio: ["ignore", "inherit", "inherit"] });
      child.on("error", () => resolvePromise(127));
      child.on("close", (code) => resolvePromise(code ?? 1));
    });
    return exitCode;
  };

  if (rolloutArgs) {
    const exitCode = await tryRun(rolloutArgs);
    if (existsSync(join(runDir, "verification.toml"))) {
      // A rollout spec without a valid [referee] block yields no verdict by
      // construction — surface that as a fallback, don't mint a fake verdict.
      const v = (() => {
        try {
          return parseToml(readFileSync(join(runDir, "verification.toml"), "utf8")) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      })();
      if (v && (v.verdict === "agree" || v.verdict === "disagree" || typeof v.agree === "boolean")) {
        return;
      }
      // Harness ran but produced no valid verdict — surface fallback
      writeFallback(runDir, `rollout harness produced no valid verdict (missing [referee]?)`, tolerance);
      return;
    }
    if (exitCode === 0) {
      // Rollout harness succeeded but didn't write — try legacy fallback before giving up
    } else {
      writeFallback(runDir, `rollout harness exited ${exitCode} without writing verification.toml`, tolerance);
      return;
    }
  }

  // ── legacy path: system_verify.jld2 harness ──
  const args =
    runner === "julia" && spec.env_project
      ? [`--project=${spec.env_project}`, harness, runDir, String(tolerance)]
      : [harness, runDir, String(tolerance)];

  const exitCode: number = await tryRun(args);

  if (!existsSync(join(runDir, "verification.toml"))) {
    writeFallback(runDir, `verification harness exited ${exitCode} without writing verification.toml`, tolerance);
  }
}
