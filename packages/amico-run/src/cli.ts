import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { LocalExecutor } from "./local_executor.js";
import { ConfigError, type Finished, type SubmitOpts } from "./types.js";
import { readAuthoring } from "./authoring.js";
import { runGate } from "./gate.js";
import { runVerification } from "./verify.js";
import { trySubcommand } from "./subcommands.js";

function readTomlSafe(fp: string): Record<string, unknown> | undefined {
  try {
    return parseToml(readFileSync(fp, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

const USAGE = `usage: amico-run <script.jl> [--executor local] [--lab <id-or-path>]
                 [--runs-root <path>] [--julia <path>] [--project <path>] [--sysimage <path>]
                 [--spec <solvespec.json>]   (spec C: validate + gate before launch)
       amico-run resolve --platform <p> --kind <k> --size <n>   (tier resolution → JSON)
       amico-run sandbox <workspace-dir> --packages A,B,…       (generate env/Project.toml)
       (a bare script literally named "resolve"/"sandbox" still launches — dispatch checks the file exists)`;

export async function main(argv: string[]): Promise<number> {
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
  if (!script) {
    console.error(`amico-run: no script given\n${USAGE}`);
    return 64;
  }
  if (executor !== "local") {
    console.error(`amico-run: only --executor local is supported in β`);
    return 64;
  }

  // ── spec C: the launch gate. Failures leave NO run dir and exit 64. ──
  if (specPath) {
    let specRaw: unknown;
    try {
      specRaw = JSON.parse(readFileSync(specPath, "utf8"));
    } catch (e) {
      console.error(`amico-run: cannot read --spec ${specPath}: ${(e as Error).message}`);
      return 64;
    }
    let scriptText: string;
    try {
      scriptText = readFileSync(script, "utf8");
    } catch (e) {
      console.error(`amico-run: cannot read script ${script}: ${(e as Error).message}`);
      return 64;
    }
    const { config: authoring, warning } = readAuthoring();
    if (warning) console.error(`amico-run: ${warning}`);
    const gate = runGate(specRaw, scriptText, authoring);
    if (!gate.ok) {
      console.error(`amico-run: gate: ${gate.reason}`);
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
    handle = await new LocalExecutor().submit(script, opts);
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
    const { config: authoring } = readAuthoring();
    await runVerification(handle.runDir, opts.spec, authoring);
    const verified = readTomlSafe(join(handle.runDir, "verification.toml"));
    console.log(`AMICODE_VERIFIED agree=${verified?.agree === true}`);
  }
  // stdout protocol line — camelCase by design (spec §4)
  console.log(`AMICODE_FINISHED status=${f.status} exitCode=${f.exitCode} runDir=${handle.runDir}`);
  if (f.status === "aborted") return 130;
  if (f.status === "completed") return 0;
  return f.exitCode === 0 ? 1 : f.exitCode;
}

main(process.argv.slice(2)).then(
  (c) => {
    process.exitCode = c;
  },
  (e) => {
    // Any unexpected throw is an orchestrator fault, not a solve failure → 64.
    console.error(`amico-run: unexpected error: ${e instanceof Error ? (e.stack ?? e.message) : e}`);
    process.exitCode = 64;
  },
);
