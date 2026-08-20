// packages/amico-run/src/cloud_verb.ts — the `amico cloud` verb (#460, the
// amico-run dissolution's kept cloud code). The Aug 17 rethink memo (§4)
// dissolves amico-run into five verbs and keeps exactly one piece of cloud
// code: a thin cloud client. This is its CLI surface — the submit→poll→mirror
// path over ~/.amico/cloud.json, callable from any agent shell WITHOUT going
// through the launch path:
//
//   amico cloud submit <script.jl> [--spec <solvespec.json>] [--max-wallclock <s>]
//       → POST the script to the configured cloud; print the task id. A run dir
//         is NOT created — a rejected submit ran nothing (the executor's
//         step-1 discipline). The client accepts SCRIPTS today; spec-record
//         submission arrives with P6a.
//   amico cloud status --task <id>
//       → ONE status poll, printed as JSON (the authoritative terminal lane).
//   amico cloud mirror --task <id> [--runs-root <d>] [--lab <l>]
//       → materialize a solve's artifacts into a local contract run dir: run.log
//         AMICODE_ITER/PULSE lines, iter_NNNNN.png frames, FINISHED + the #430
//         GPU receipt ledger row when the task is terminal. One poll pass — a
//         running task yields an honest snapshot (no FINISHED); re-run to
//         refresh (Δ4 re-serves history; the mirror dedups).
//   amico cloud abort --task <id>
//       → POST the abort REQUEST (the status poll still owns the terminal).
//   amico cloud run <script.jl> [--spec <s>] [--max-wallclock <s>] [--lab <l>] [--runs-root <d>]
//       → the composing lifecycle: submit → poll → mirror to terminal, exit
//         lanes mirroring the launch path (completed 0, aborted 130, failed
//         exit_code). Blocks for the run's wall time (warming budget 15 min).
//
// Single-line JSON out (the verb contract). Honest one-line failures when the
// config is absent or the endpoint unreachable — the endpoint's DNS is
// currently NXDOMAIN (#423), so the live path degrades to a clear failure, and
// CI stays on FakeCloud. NOT an MCP tool (memo §9: a bash CLI is transparent
// and agent-friendly) — hence the pasqal-style switch case in amico.ts, not a
// SPINE_VERBS entry.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { validate } from "@amicode/schema";
import {
  CloudClient,
  CloudMirror,
  type CloudStatus,
  cloudRun,
  createMirrorRunDir,
  wallclockCap,
} from "./cloud_client.js";
import { readRemoteConfig, type RemoteConfig } from "./remote_config.js";
import { defaultRunsRoot, deriveLabId } from "./run_dir.js";
import { ConfigError } from "./types.js";
import type { VerbResult } from "./verbs.js";

const USAGE =
  "amico cloud submit <script.jl> [--spec <solvespec.json>] [--max-wallclock <s>]  |  " +
  "amico cloud status --task <id>  |  amico cloud mirror --task <id> [--runs-root <d>] [--lab <l>]  |  " +
  "amico cloud abort --task <id>  |  " +
  "amico cloud run <script.jl> [--spec <s>] [--max-wallclock <s>] [--lab <l>] [--runs-root <d>]";

export interface CloudVerbCtx {
  /** Env override (tests); default process.env. Threads readRemoteConfig and
   *  the wallclock env ladder — never a token of its own. */
  env?: NodeJS.ProcessEnv;
}

function fail(subcommand: string, errors: string[], extra: Record<string, unknown> = {}): VerbResult {
  return { json: { verb: "cloud", subcommand, ok: false, errors, usage: USAGE, ...extra }, code: 64 };
}

/** One honest line for a failed cloud call: node's fetch failures bury the
 *  real reason (NXDOMAIN, ECONNREFUSED) in `cause` — surface it, since a bare
 *  "fetch failed" is exactly the unclear degradation #423 forbids. */
function cloudFault(e: unknown): string {
  const err = e as Error & { cause?: unknown };
  const cause = err?.cause instanceof Error ? ` (${err.cause.message})` : "";
  return `${err?.message ?? String(e)}${cause}`;
}

// ── argv parsing ─────────────────────────────────────────────────────────────────
const VALUE_FLAGS = new Set(["--spec", "--max-wallclock", "--lab", "--runs-root", "--task"]);

interface Parsed {
  flags: Record<string, string>;
  positionals: string[];
}

function parse(argv: string[]): Parsed {
  const flags: Record<string, string> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS.has(a)) {
      if (i + 1 < argv.length) flags[a] = argv[++i];
    } else if (a.startsWith("--") && a.includes("=")) {
      const eq = a.indexOf("=");
      flags[a.slice(0, eq)] = a.slice(eq + 1);
    } else if (a.startsWith("--")) {
      flags[a] = ""; // tolerated boolean flag (none defined today)
    } else {
      positionals.push(a);
    }
  }
  return { flags, positionals };
}

/** Config resolution with the honest absent-config failure (config-class:
 *  nothing ran). */
function configOr(env: NodeJS.ProcessEnv, sub: string): RemoteConfig | VerbResult {
  try {
    return readRemoteConfig(env);
  } catch (e) {
    return fail(sub, [(e as Error).message]);
  }
}

/** The wallclock ladder flag: a positive integer, or a usage error (the verb
 *  is user-facing; the executor knob stays unvalidated because it is internal). */
function maxWallclockFlag(p: Parsed, env: NodeJS.ProcessEnv, sub: string): number | VerbResult {
  const raw = p.flags["--max-wallclock"];
  if (raw === undefined || raw === "") return wallclockCap(undefined, env);
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    return fail(sub, [`--max-wallclock "${raw}" must be a positive integer (seconds)`]);
  }
  return n;
}

/** Resolve WHAT a submission carries: a positional script path, or the
 *  script_path inside a --spec (validated against the solvespec schema first —
 *  the estimate idiom). A relative script_path resolves against the spec's
 *  directory, so a spec+script pair stays relocatable. A problem_spec spec is
 *  refused exactly as RemoteExecutor refuses it: local-only until P6a. */
function resolveSubmission(p: Parsed, sub: string): { script: string } | VerbResult {
  const specPath = p.flags["--spec"] ?? "";
  const positional = p.positionals[0];
  if (p.positionals.length > 1) {
    return fail(sub, [`unexpected extra argument "${p.positionals[1]}" — one script path, not ${p.positionals.length}`]);
  }
  if (specPath !== "" && positional !== undefined) {
    return fail(sub, ["pass either a script path or --spec <solvespec.json>, not both"]);
  }
  if (specPath === "" && positional === undefined) {
    return fail(sub, ["a script path (or --spec <solvespec.json>) is required"]);
  }
  let script: string;
  if (specPath !== "") {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(specPath, "utf8"));
    } catch (e) {
      return fail(sub, [`cannot read --spec ${specPath}: ${(e as Error).message}`]);
    }
    const v = validate(raw, "solvespec");
    if (!v.ok) return fail(sub, [`--spec ${specPath}: solvespec schema: ${v.errors[0]}`]);
    const spec = raw as { script_path?: unknown; problem_spec?: unknown };
    if (spec.problem_spec !== undefined) {
      return fail(sub, [
        "problem_spec is not yet supported by the cloud client (local-only in Phase 2; spec-record submission arrives with P6a)",
      ]);
    }
    const sp = typeof spec.script_path === "string" ? spec.script_path : "";
    if (sp === "") return fail(sub, [`--spec ${specPath} carries no script_path — nothing to submit`]);
    script = isAbsolute(sp) ? sp : resolve(dirname(specPath), sp);
  } else {
    script = resolve(positional!);
  }
  if (!existsSync(script)) return fail(sub, [`script not found: ${script}`]);
  return { script };
}

// ── submit ───────────────────────────────────────────────────────────────────────
async function cloudSubmit(argv: string[], ctx: CloudVerbCtx): Promise<VerbResult> {
  const env = ctx.env ?? process.env;
  const p = parse(argv);
  const sub = resolveSubmission(p, "submit");
  if ("json" in sub) return sub;
  const cfg = configOr(env, "submit");
  if ("json" in cfg) return cfg;
  const cap = maxWallclockFlag(p, env, "submit");
  if (typeof cap !== "number") return cap;
  const client = new CloudClient(cfg);
  let taskId: string;
  try {
    taskId = await client.submitScript(readFileSync(sub.script, "utf8"), basename(sub.script), cap);
  } catch (e) {
    return fail("submit", [cloudFault(e)]);
  }
  return {
    json: {
      verb: "cloud",
      subcommand: "submit",
      ok: true,
      task_id: taskId,
      base_url: cfg.baseUrl,
      filename: basename(sub.script),
      max_wallclock: cap,
      submitted_at: new Date().toISOString(),
      note:
        "submitted — poll with `amico cloud status --task <id>`, mirror with `amico cloud mirror --task <id>`, or run to terminal with `amico cloud run`",
    },
    code: 0,
  };
}

// ── status ───────────────────────────────────────────────────────────────────────
async function cloudStatus(argv: string[], ctx: CloudVerbCtx): Promise<VerbResult> {
  const env = ctx.env ?? process.env;
  const p = parse(argv);
  const taskId = p.flags["--task"] ?? "";
  if (taskId === "") return fail("status", ["--task <id> is required"]);
  const cfg = configOr(env, "status");
  if ("json" in cfg) return cfg;
  try {
    const s = await new CloudClient(cfg).status(taskId);
    const f = s.finished?.status;
    return {
      json: {
        verb: "cloud",
        subcommand: "status",
        ok: true,
        task_id: taskId,
        base_url: cfg.baseUrl,
        task_status: s.task_status ?? "",
        liveness: s.liveness ?? "",
        finished: s.finished ?? null,
        terminal: f === "completed" || f === "failed" || f === "aborted",
      },
      code: 0,
    };
  } catch (e) {
    return fail("status", [cloudFault(e)], { task_id: taskId, base_url: cfg.baseUrl });
  }
}

// ── mirror ───────────────────────────────────────────────────────────────────────
async function cloudMirror(argv: string[], ctx: CloudVerbCtx): Promise<VerbResult> {
  const env = ctx.env ?? process.env;
  const p = parse(argv);
  const taskId = p.flags["--task"] ?? "";
  if (taskId === "") return fail("mirror", ["--task <id> is required"]);
  const cfg = configOr(env, "mirror");
  if ("json" in cfg) return cfg;
  const lab = p.flags["--lab"] ?? "default";
  let labId: string;
  try {
    labId = deriveLabId(lab);
  } catch (e) {
    return fail("mirror", [(e as Error).message], { lab });
  }
  const runsRoot = p.flags["--runs-root"] ?? defaultRunsRoot(labId);
  const client = new CloudClient(cfg);

  // Preflight the task BEFORE minting a run dir: an unknown id or an
  // unreachable endpoint (the #423 reality) fails honestly with nothing on
  // disk — a fat-fingered task id should not litter the runs index.
  try {
    await client.status(taskId);
  } catch (e) {
    return fail("mirror", [cloudFault(e)], { task_id: taskId, base_url: cfg.baseUrl });
  }

  // The script CONTENT lives in the cloud task; the manifest points at the
  // task (run.schema.json requires a non-empty script_path).
  const { runId, runDir } = createMirrorRunDir({ cfg, taskId, script: `cloud://${taskId}`, lab, labId, runsRoot });
  const mirror = new CloudMirror({ client, taskId, runId, runDir });
  let status: CloudStatus;
  try {
    status = await mirror.pollOnce();
  } catch (e) {
    return fail("mirror", [cloudFault(e)], { task_id: taskId, base_url: cfg.baseUrl, run_id: runId, run_dir: runDir });
  }

  const log = readFileSync(join(runDir, "run.log"), "utf8").split("\n").filter((l) => l !== "");
  const pngs = readdirSync(runDir).filter((f) => /^iter_\d{5}\.png$/.test(f)).sort();
  const json: Record<string, unknown> = {
    verb: "cloud",
    subcommand: "mirror",
    ok: true,
    task_id: taskId,
    base_url: cfg.baseUrl,
    run_id: runId,
    run_dir: runDir,
    task_status: status.task_status ?? "",
    liveness: status.liveness ?? "",
    terminal: mirror.settled,
    finished: mirror.result === undefined ? null : { status: mirror.result.status, exit_code: mirror.result.exitCode },
    iter_lines_mirrored: log.filter((l) => l.startsWith("AMICODE_ITER")).length,
    pulse_lines_mirrored: log.filter((l) => l.startsWith("AMICODE_PULSE ") || l.startsWith("AMICODE_PULSE_META")).length,
    frames_mirrored: pngs.length,
    newest_frame: pngs.at(-1) ?? null,
    receipt_emitted: existsSync(join(runDir, "receipt.toml")),
  };
  if (!mirror.settled) {
    json.note =
      "task not terminal — this is a snapshot mirror (no FINISHED); re-run to refresh, or `amico cloud run` for the full lifecycle";
  }
  return { json, code: 0 };
}

// ── abort ────────────────────────────────────────────────────────────────────────
async function cloudAbort(argv: string[], ctx: CloudVerbCtx): Promise<VerbResult> {
  const env = ctx.env ?? process.env;
  const p = parse(argv);
  const taskId = p.flags["--task"] ?? "";
  if (taskId === "") return fail("abort", ["--task <id> is required"]);
  const cfg = configOr(env, "abort");
  if ("json" in cfg) return cfg;
  const client = new CloudClient(cfg);
  // Preflight: the abort POST itself is best-effort by contract (it swallows
  // network faults), so a bare ok would lie about an unreachable endpoint.
  // One status poll proves the channel first; then the request.
  try {
    await client.status(taskId);
  } catch (e) {
    return fail("abort", [cloudFault(e)], { task_id: taskId, base_url: cfg.baseUrl });
  }
  await client.abort(taskId);
  return {
    json: {
      verb: "cloud",
      subcommand: "abort",
      ok: true,
      task_id: taskId,
      base_url: cfg.baseUrl,
      requested: true,
      note: "abort is a REQUEST (resolution (b)) — the run is terminal when the status poll reports aborted",
    },
    code: 0,
  };
}

// ── run (the composing lifecycle) ────────────────────────────────────────────────
async function cloudRunSub(argv: string[], ctx: CloudVerbCtx): Promise<VerbResult> {
  const env = ctx.env ?? process.env;
  const p = parse(argv);
  const sub = resolveSubmission(p, "run");
  if ("json" in sub) return sub;
  const cfg = configOr(env, "run");
  if ("json" in cfg) return cfg;
  const cap = maxWallclockFlag(p, env, "run");
  if (typeof cap !== "number") return cap;
  const lab = p.flags["--lab"] ?? "default";
  let labId: string;
  try {
    labId = deriveLabId(lab);
  } catch (e) {
    return fail("run", [(e as Error).message], { lab });
  }
  const runsRoot = p.flags["--runs-root"] ?? defaultRunsRoot(labId);

  const startedAt = Date.now();
  let handle;
  try {
    handle = await cloudRun({ cfg, script: sub.script, lab, labId, runsRoot, maxWallclock: cap });
  } catch (e) {
    if (e instanceof ConfigError) return fail("run", [e.message]);
    return fail("run", [cloudFault(e)]);
  }

  // Ctrl-C aborts the CLOUD task too (stop paying for the instance) — the
  // launch path's signal wiring (launch.ts), same discipline.
  const onSignal = (): void => {
    void handle.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const fin = await handle.finished;
  // task_id/base_url live in the remote.json sidecar (run.schema.json is frozen).
  const sidecar = JSON.parse(readFileSync(join(handle.runDir, "remote.json"), "utf8")) as {
    task_id: string;
    base_url: string;
  };
  return {
    json: {
      verb: "cloud",
      subcommand: "run",
      ok: fin.status === "completed",
      task_id: sidecar.task_id,
      base_url: sidecar.base_url,
      run_id: handle.runId,
      run_dir: handle.runDir,
      status: fin.status,
      exit_code: fin.exitCode,
      wall_s: Math.round((Date.now() - startedAt) / 1000),
      receipt_emitted: existsSync(join(handle.runDir, "receipt.toml")),
      note:
        fin.status === "completed"
          ? undefined
          : "the lifecycle completed and FINISHED is mirrored — the solve's verdict rides status/exit_code (launch-path exit lanes)",
    },
    // launch.ts exit lanes: completed 0, aborted 130, failed exit_code
    code: fin.status === "completed" ? 0 : fin.status === "aborted" ? 130 : fin.exitCode,
  };
}

// ── subcommand router ────────────────────────────────────────────────────────────
/** The `cloud` verb body: route on the subcommand. `ctx` is injected by tests
 *  (env); the CLI wrapper (amico.ts) calls it with defaults. */
export async function cloudVerb(argv: string[], ctx: CloudVerbCtx = {}): Promise<VerbResult> {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub === "submit") return cloudSubmit(rest, ctx);
  if (sub === "status") return cloudStatus(rest, ctx);
  if (sub === "mirror") return cloudMirror(rest, ctx);
  if (sub === "abort") return cloudAbort(rest, ctx);
  if (sub === "run") return cloudRunSub(rest, ctx);
  return {
    json: { verb: "cloud", error: `unknown subcommand ${sub ? `"${sub}"` : "(none)"}`, usage: USAGE },
    code: 64,
  };
}
