// packages/amico-run/src/remote_executor.ts
// Δ8 (#32): the cloud executor — now the Executor ADAPTER. As of #460 (the
// amico-run dissolution's buildable slice) the cloud wire lives ONCE in
// cloud_client.ts, the thin `amico cloud` client extracted from this file;
// RemoteExecutor validates the submit contract (problem_spec routing, script
// existence, config, lab resolution) and DELEGATES the submit→poll→mirror
// lifecycle to cloudRun() with ZERO behavior change — the FakeCloud
// wire-shape tests, the executor-parity suite, and the slow live smoke pin it.
// Locked resolutions (a)–(d) (frames best-effort, abort()=request, warming
// budget, status-poll-authoritative terminal) are carried by the client module.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { cloudRun, wallclockCap } from "./cloud_client.js";
import { defaultRunsRoot, deriveLabId } from "./run_dir.js";
import { readRemoteConfig, type RemoteConfig } from "./remote_config.js";
import { ConfigError, type Executor, type RunHandle, type SubmitOpts } from "./types.js";

export interface RemoteExecutorOpts {
  /** Endpoint + credential; default readRemoteConfig() (env pair → ~/.amico/cloud.json). */
  config?: RemoteConfig;
  /** Poll cadence, default 2000ms. Test knob (the graceMs idiom, types.ts:13) — NOT exposed in the CLI. */
  pollMs?: number;
  /** Resolution (c): per-executor warming budget — no sign of life (Running
   *  status or a first iter) within this window → inferred terminal.
   *  Default 15 min: remote cold-start ≫ local seconds. */
  warmingBudgetMs?: number;
  /** Client half of resolution (d): no SUCCESSFUL status poll for this long →
   *  inferred terminal (observability lost; S3 keeps the cloud truth).
   *  Default 10 min — deliberately the inspector's STALL_AFTER_MS. */
  lostAfterMs?: number;
  /** Δ2 pass-through: overridable wall-clock cap (seconds). */
  maxWallclock?: number;
}

export class RemoteExecutor implements Executor {
  private readonly cfgOverride?: RemoteConfig;
  private readonly pollMs: number;
  private readonly warmingBudgetMs: number;
  private readonly lostAfterMs: number;
  private readonly maxWallclock?: number;

  constructor(opts: RemoteExecutorOpts = {}) {
    this.cfgOverride = opts.config;
    this.pollMs = opts.pollMs ?? 2000;
    this.warmingBudgetMs = opts.warmingBudgetMs ?? 15 * 60 * 1000;
    this.lostAfterMs = opts.lostAfterMs ?? 10 * 60 * 1000;
    // The wall-clock cap is NEVER optional (2026-08-18 GPU-plane pass) — the
    // ladder (explicit > env > generous 2h default) lives once in the client.
    this.maxWallclock = wallclockCap(opts.maxWallclock);
  }

  async submit(scriptPath: string | undefined, opts: SubmitOpts = {}): Promise<RunHandle> {
    // ---- step 1 (LocalExecutor §5 parity): validate config; NO run dir on failure ----
    // v4 problem_spec routing is local-only for now (cloud-side solve_spec is a
    // Phase-4 follow-up); reject it here rather than silently ignore.
    if (opts.spec?.problem_spec !== undefined)
      throw new ConfigError("problem_spec is not yet supported with --executor remote (local-only in Phase 2)");
    if (scriptPath === undefined) throw new ConfigError("no script given");
    const script = resolve(scriptPath);
    if (!existsSync(script)) throw new ConfigError(`script not found: ${script}`);
    const cfg = this.cfgOverride ?? readRemoteConfig();
    const lab = opts.lab ?? "default";
    const labId = deriveLabId(lab);
    const runsRoot = opts.runsRoot ?? defaultRunsRoot(labId);

    // ---- steps 2–4 (Δ2 submit, local mirror, poll pump): the thin cloud client (#460) ----
    return cloudRun({
      cfg,
      script,
      lab,
      labId,
      runsRoot,
      maxWallclock: this.maxWallclock!,
      pollMs: this.pollMs,
      warmingBudgetMs: this.warmingBudgetMs,
      lostAfterMs: this.lostAfterMs,
    });
  }
}
