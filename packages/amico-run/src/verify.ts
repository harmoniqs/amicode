// Re-rollout verification invoke (spec C; extended to tier-2 by
// spec-20260708-112732 §4.3). After FINISHED, when the SolveSpec is a verified
// tier (see isVerifiedTier), amico-run runs the FIXED, VETTED re-rollout harness
// (a Julia asset shipped with the extension, path from authoring.json) against
// the run dir's system_verify.jld2 + pulse.jld2. The harness writes
// verification.toml itself; if it is missing, fails to run, or exits without
// writing, we write a fallback verification.toml with agree=false + a reason —
// a verified run must NEVER end verification-less (absence would read as
// "pending" forever and mask a failure, and the auto-promote gate keys off
// agree==true).
import { spawn } from "node:child_process";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AuthoringConfig } from "./authoring.js";
import type { SpecStamp } from "./types.js";

/** Which trust tiers get the independent re-rollout gate after FINISHED.
 *  free = author-first (tier-3, the original trust anchor); composed = exemplar-
 *  spliced (tier-2 — added by spec-20260708-112732 §4.3, because a wrong fill can
 *  still re-roll to a different pulse and pass the masked-baseline check). vetted
 *  (tier-1) is trusted by its template and skips it. Single source of truth for
 *  the policy — cli.ts gates on it, and the harness driver reads it to know
 *  whether a run will emit an AMICODE_VERIFIED line. */
export function isVerifiedTier(tier: string | undefined): boolean {
  return tier === "free" || tier === "composed";
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

  if (!existsSync(join(runDir, "verification.toml"))) {
    writeFallback(runDir, `verification harness exited ${exitCode} without writing verification.toml`, tolerance);
  }
}
