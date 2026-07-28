// The amico-run LAUNCH path, extracted verbatim from cli.ts (B1: generalize amico-run
// into the `amico` verb router, issue #108). Nothing here changed except the name
// `main` → `launch` and the removal of the top-level self-invocation, which now lives in
// cli.ts (the `amico-run` bin) — so both the `amico-run` bin AND the new `amico run`
// router verb can call this ONE launch function without either re-running the other's
// process bootstrap. This is the "delegate to the existing code path" seam: `amico run
// <args>` is exactly `launch(<args>)`, byte-for-byte the historical amico-run behavior.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { LocalExecutor } from "./local_executor.js";
import { RemoteExecutor } from "./remote_executor.js";
import { ConfigError, type Executor, type Finished, type SubmitOpts } from "./types.js";
import { readAuthoring } from "./authoring.js";
import { runGate } from "./gate.js";
import { assembleWarrantContext } from "./warrant_context.js";
import { runVerification } from "./verify.js";
import { trySubcommand } from "./subcommands.js";

function readTomlSafe(fp: string): Record<string, unknown> | undefined {
  try {
    return parseToml(readFileSync(fp, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

const USAGE = `usage: amico-run <script.jl> [--executor local|remote] [--lab <id-or-path>]
                 [--runs-root <path>] [--julia <path>] [--project <path>] [--sysimage <path>]
                 [--spec <solvespec.json>]   (spec C: validate + gate before launch)
       amico-run resolve --platform <p> --kind <k> --size <n>   (tier resolution → JSON)
       amico-run sandbox <workspace-dir> --packages A,B,…       (generate env/Project.toml)
       (a bare script literally named "resolve"/"sandbox" still launches — dispatch checks the file exists)`;

export async function launch(argv: string[]): Promise<number> {
  // spec C subcommands — dispatched before the launch flag loop
  const sub = trySubcommand(argv);
  if (sub !== undefined) return sub;

  let script: string | undefined;
  let executor = "local";
  let specPath: string | undefined;
  const opts: SubmitOpts = { julia: {} };
  let projectExplicit = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new ConfigError(`flag ${a} requires a value`);
      return v;
    };
    try {
      switch (a) {
        case "--help":
        case "-h":
          console.log(USAGE);
          return 0;
        case "--executor":
          executor = next();
          break;
        case "--lab":
          opts.lab = next();
          break;
        case "--runs-root":
          opts.runsRoot = next();
          break;
        case "--julia":
          opts.julia!.julia = next();
          break;
        case "--project":
          opts.julia!.project = next();
          projectExplicit = true;
          break;
        case "--sysimage":
          opts.julia!.sysimage = next();
          break;
        case "--spec":
          specPath = next();
          break;
        default:
          if (a.startsWith("-")) {
            console.error(`amico-run: unknown flag ${a}\n${USAGE}`);
            return 64;
          }
          if (script) {
            console.error(`amico-run: multiple scripts given`);
            return 64;
          }
          script = a;
      }
    } catch (e) {
      if (e instanceof ConfigError) {
        console.error(`amico-run: ${e.message}`);
        return 64;
      }
      throw e;
    }
  }
  // Parse --spec up front: a v4 solvespec carrying `problem_spec` has no script,
  // so the "no script" guard AND the gate's script read + import scan must both
  // stand down (the ProblemSpec routes to Piccolo.Specs.solve_spec, not a script).
  let specRaw: unknown;
  let problemSpec: unknown;
  if (specPath) {
    try {
      specRaw = JSON.parse(readFileSync(specPath, "utf8"));
    } catch (e) {
      console.error(`amico-run: cannot read --spec ${specPath}: ${(e as Error).message}`);
      return 64;
    }
    problemSpec = (specRaw as { problem_spec?: unknown }).problem_spec;
  }
  const hasProblemSpec = problemSpec !== undefined;

  if (script && hasProblemSpec) {
    console.error(`amico-run: --spec carries a problem_spec — do not also pass a script argument`);
    return 64;
  }
  if (!script && !hasProblemSpec) {
    console.error(`amico-run: no script given\n${USAGE}`);
    return 64;
  }
  if (executor !== "local" && executor !== "remote") {
    console.error(`amico-run: unknown --executor ${executor} (supported: local, remote)`);
    return 64;
  }
  // --spec + --executor remote is SUPPORTED (High-Performance + Cloud, tier=hpc):
  // the launch gate is a static local check and runs identically for both
  // executors. Only the free-tier re-rollout verification is local-only — it is
  // skipped for remote runs (noted on stderr at the verification seam below;
  // cloud-side re-rollout is a Phase-2 follow-up).
  if (executor === "remote" && (opts.julia!.julia || opts.julia!.project || opts.julia!.sysimage)) {
    console.error(`amico-run: --julia/--project/--sysimage are ignored with --executor remote (the runner image owns the environment)`);
  }

  // ── spec C: the launch gate. Failures leave NO run dir and exit 64. ──
  if (specPath) {
    // specRaw was parsed above (problem_spec detection). Only read the script for
    // a script-bearing spec; a problem_spec spec has none (gate.ts skips the scan).
    let scriptText = "";
    if (!hasProblemSpec) {
      try {
        scriptText = readFileSync(script!, "utf8");
      } catch (e) {
        console.error(`amico-run: cannot read script ${script}: ${(e as Error).message}`);
        return 64;
      }
    }
    const { config: authoring, warning } = readAuthoring();
    if (warning) console.error(`amico-run: ${warning}`);
    // Warrant context (spec-20260727-164748 §5.1). undefined unless AMICO_WARRANTS
    // is set, and gate.ts treats absence as "the step does not exist" — so the
    // feature is opt-in and this line changes nothing by default.
    const warrantCtx = assembleWarrantContext({
      scriptText,
      planHash:
        typeof (specRaw as { plan_hash?: unknown }).plan_hash === "string"
          ? (specRaw as { plan_hash: string }).plan_hash
          : undefined,
    });
    const gate = runGate(specRaw, scriptText, authoring, warrantCtx);
    if (!gate.ok) {
      console.error(`amico-run: gate: ${gate.reason}`);
      // §5.2: a warrant refusal ALSO prints its structured form on stdout, so a
      // caller (the agent, or the extension) can turn it into an approval request
      // without scraping prose. Other gate failures print nothing extra.
      if (gate.refusal) {
        console.log(JSON.stringify({ error: "warrant_required", ...gate.refusal }));
      }
      return 64;
    }
    // env resolution: spec env.project feeds --project unless the flag was explicit
    const env = (specRaw as { env?: { kind?: string; project?: string } }).env;
    if (env?.project && (env.kind === "project" || env.kind === "sandbox")) {
      if (projectExplicit && opts.julia!.project !== env.project)
        console.error(`amico-run: --project ${opts.julia!.project} overrides the spec's env.project ${env.project}`);
      else opts.julia!.project = env.project;
    }
    opts.spec = {
      canonical: gate.stamp.specCanonical,
      tier: gate.stamp.tier,
      hashes: gate.stamp.hashes,
      julia_binary: opts.julia!.julia,
      env_project: opts.julia!.project,
      // v4: route the typed ProblemSpec to Piccolo.Specs.solve_spec (LocalExecutor)
      problem_spec: hasProblemSpec ? (problemSpec as string | Record<string, unknown>) : undefined,
    };
  }

  // NOTE: `--sysimage <path>` is honored (passed through to the Julia process and
  // recorded in the manifest) but amicode does NOT build one — the local
  // PackageCompiler build (~25-50 min, CairoMakie-dominated) wasn't worth it. The
  // intended fast-path is a prebuilt sysimage distributed like Piccolissimo's
  // (CI build on self-hosted runners → R2 → manifest → download), pointed at via
  // this flag. Until that exists, solves pay the cold start (inspector warms up).

  let handle;
  try {
    const exec: Executor = executor === "remote" ? new RemoteExecutor() : new LocalExecutor();
    handle = await exec.submit(script, opts);
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`amico-run: ${e.message}`);
      return 64;
    }
    throw e;
  }

  const onSignal = (): void => {
    void handle.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  let fin: Finished | undefined;
  for await (const ev of handle.events) {
    if (ev.kind === "iter" || ev.kind === "done") console.log(ev.raw);
    else if (ev.kind === "log") console.log(ev.line);
    else fin = { status: ev.status, exitCode: ev.exitCode };
  }
  const f = fin ?? (await handle.finished);

  // FINISHED-write failure lane (spec §6 last row): verdict file must exist on disk
  if (!existsSync(join(handle.runDir, "FINISHED"))) {
    console.error(`amico-run: FINISHED missing in ${handle.runDir} (write fault)`);
    return 64;
  }
  // spec C: free-tier re-rollout verification runs AFTER FINISHED, BEFORE the
  // AMICODE_FINISHED line — so consumers see a settled verification state. The
  // harness (or the fallback) always writes verification.toml; the promote gate
  // keys off agree==true.
  if (opts.spec?.tier === "free") {
    if (executor === "remote") {
      // Re-rollout verification replays the LOCAL Julia env; a remote run's
      // artifacts arrive via the mirror with no local env to replay in. Skip
      // honestly (no verification.toml → the promote gate never sees agree).
      console.error(`amico-run: free-tier re-rollout verification skipped for --executor remote (local-only)`);
    } else {
      const { config: authoring } = readAuthoring();
      await runVerification(handle.runDir, opts.spec, authoring);
      const verified = readTomlSafe(join(handle.runDir, "verification.toml"));
      console.log(`AMICODE_VERIFIED agree=${verified?.agree === true}`);
    }
  }
  // NOTE: tier=hpc (High-Performance + Cloud) runs remote and skips local
  // re-rollout by construction (the branch above only fires for tier=free);
  // cloud-side re-rollout is the Phase-2 follow-up.
  // stdout protocol line — camelCase by design (spec §4)
  console.log(`AMICODE_FINISHED status=${f.status} exitCode=${f.exitCode} runDir=${handle.runDir}`);
  if (f.status === "aborted") return 130;
  if (f.status === "completed") return 0;
  return f.exitCode === 0 ? 1 : f.exitCode;
}
