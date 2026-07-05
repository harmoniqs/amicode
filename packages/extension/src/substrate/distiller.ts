/** Extension-side distiller integration (spec-20260705-002847 §4).
 *
 *  The distiller is a headless LLM agent: `opencode run --agent distiller
 *  <job-json>` with its own OPENCODE_CONFIG_CONTENT (built here). The
 *  deterministic parts — queue, single global lock, drain, spawn — live in the
 *  shared module opencode-plugin/distill_queue.ts so the Bun-side plugin and
 *  the batch script produce IDENTICAL distiller processes via the
 *  distiller.config.json transport this module writes at activation. */
import {
  enqueueJob,
  enqueueAndDrain,
  writeDistillerConfig,
  defaultClock,
  type DistillJob,
} from "../../opencode-plugin/distill_queue";

export interface DistillerSetup {
  /** Absolute path of the (vendored) opencode binary. */
  binary: string;
  /** Absolute path of the bundled DISTILLER.md instruction file. */
  distillerMdPath: string;
  vaultDir: string;
  opsDir: string;
  problemsRoot: string;
  runsRoot: string;
  /** providerID/modelID — pinned so distillation survives chat-provider rate limits. */
  model: string;
}

export function buildDistillerConfigContent(s: DistillerSetup): Record<string, unknown> {
  return {
    $schema: "https://opencode.ai/config.json",
    instructions: [s.distillerMdPath],
    agent: {
      distiller: {
        description: "Amico's background memory distiller (headless; no subagents)",
        prompt:
          "You are Amico's distiller. Follow the distiller instructions exactly. " +
          "Your input message is one JSON job object. Work silently; never spawn " +
          "subagents; finish with a one-line summary.",
        model: s.model,
      },
    },
    permission: {
      bash: "allow",
      edit: "allow",
      external_directory: {
        [`${s.vaultDir}/amicode/**`]: "allow", // the ONLY place it writes
        [`${s.vaultDir}/.git/**`]: "allow",    // pathspec-scoped commits (DISTILLER.md rule 1)
        [`${s.opsDir}/**`]: "allow",           // onboarding stream + queue state
        [`${s.problemsRoot}/**`]: "allow",     // events.jsonl reads
        [`${s.runsRoot}/**`]: "allow",         // result.toml / run.toml / pulse.jld2 reads
      },
    },
  };
}

/** Written once per activation; every spawner (extension, plugin trigger-4,
 *  batch shell) reads this file so headless distillers are identical. */
export function initDistillerTransport(s: DistillerSetup): void {
  writeDistillerConfig(s.opsDir, { binary: s.binary, config: buildDistillerConfigContent(s) });
}

function baseJob(s: DistillerSetup): Pick<DistillJob, never> & { vault: string; ops: string; runs_root: string } {
  return { vault: s.vaultDir, ops: s.opsDir, runs_root: s.runsRoot };
}

/** Trigger 1 (run finished): fire-and-forget — never blocks the extension. */
export function triggerRunDistill(s: DistillerSetup, runId: string): void {
  void enqueueAndDrain(s.opsDir, { kind: "run", run_id: runId, ...baseJob(s) }, defaultClock()).catch(() => {});
}

/** Triggers 2+3 (session close / manual): coarse idempotent sweep. */
export function triggerSweep(s: DistillerSetup, drain: boolean): void {
  if (drain) {
    void enqueueAndDrain(s.opsDir, { kind: "sweep", ...baseJob(s) }, defaultClock()).catch(() => {});
  } else {
    // deactivate path: just queue — the next activation/trigger drains.
    try {
      enqueueJob(s.opsDir, { kind: "sweep", ...baseJob(s) });
    } catch {
      /* queueing must never break deactivate */
    }
  }
}
