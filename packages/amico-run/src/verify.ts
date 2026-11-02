// Free-tier re-rollout verification invoke (spec C). After FINISHED, when the
// SolveSpec is tier "free", amico-run runs the FIXED, VETTED re-rollout harness
// (a Julia asset shipped with the extension, path from authoring.json) against
// the run dir's system_verify.jld2 + pulse.jld2. The harness writes
// verification.toml itself; if it is missing, fails to run, or exits without
// writing, we write a fallback verification.toml with agree=false + a reason —
// a free run must NEVER end verification-less (absence would read as "pending"
// forever and mask a failure, and the auto-promote gate keys off agree==true).
import { spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AuthoringConfig } from "./authoring.js";
import type { SpecStamp } from "./types.js";

/** The marker the orchestrator leaves BEFORE it writes FINISHED on a free-tier local run, so
 *  a supervisor killed between FINISHED and the verification cannot present an unverified
 *  fidelity as verified: `agree = false`, `pending = true`. The real verification (or the
 *  fallback below) overwrites it without `pending`. */
export const PENDING_VERIFICATION = `schema_version = "1"\nagree = false\npending = true\nreason = "pending"\n`;

export function writePendingVerification(runDir: string): void {
  const tmp = join(runDir, `.verification.toml.tmp-${process.pid}`);
  writeFileSync(tmp, PENDING_VERIFICATION);
  renameSync(tmp, join(runDir, "verification.toml"));
}

/** True when verification.toml is absent or still the pending marker. */
export function verificationMissingOrPending(runDir: string): boolean {
  const fp = join(runDir, "verification.toml");
  if (!existsSync(fp)) return true;
  try {
    return /^pending\s*=\s*true\s*$/m.test(readFileSync(fp, "utf8"));
  } catch {
    return true;
  }
}

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

/** Run the harness; guarantee a verification.toml exists afterward. Never rejects. */
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
  const args =
    runner === "julia" && spec.env_project
      ? [`--project=${spec.env_project}`, harness, runDir, String(tolerance)]
      : [harness, runDir, String(tolerance)];

  const exitCode: number = await new Promise((resolvePromise) => {
    const child = spawn(runner, args, { stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", () => resolvePromise(127));
    child.on("close", (code) => resolvePromise(code ?? 1));
  });

  if (verificationMissingOrPending(runDir)) {
    writeFallback(runDir, `verification harness exited ${exitCode} without writing verification.toml`, tolerance);
  }
}
