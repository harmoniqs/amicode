// `amico run --adopt <runDir> [--unit <name>]` — INTERNAL. The orchestrator half of a
// placed run (#2045 D): the thin client prepared the run (gate, warrant, manifest, solvespec,
// problem.toml all on disk) and started this process outside the engine's process group.
// It must not re-evaluate anything the client already decided: no gate, no warrant, no
// solver-mode check, no run-dir creation. It owns the Julia child, run.lock + heartbeat,
// FINISHED, the ledger stanza and the free-tier verification, and prints NO AMICODE_* lines
// (the client prints those). SIGTERM/SIGINT abort the run — that is how `stop` works.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { juliaArgv, LocalExecutor, type PreparedRun } from "./local_executor.js";
import { lockIsLive, readRunLock } from "./run_lock.js";
import { exitCodeFor, verifyFreeLocal } from "./run_finish.js";
import type { SpecStamp } from "./types.js";

interface Adopted {
  prepared: PreparedRun;
  spec?: SpecStamp;
  juliaProject?: string;
}

export async function adopt(argv: string[]): Promise<number> {
  const runDir = argv[0];
  if (!runDir) return fail("--adopt requires a run directory");
  let unit: string | null = null;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--unit" && argv[i + 1]) unit = argv[++i];
    else return fail(`unknown argument ${argv[i]}`);
  }

  const loaded = load(runDir);
  if (typeof loaded === "string") return fail(loaded);
  const { prepared, spec } = loaded;

  if (existsSync(join(runDir, "FINISHED"))) return fail(`run ${prepared.runId} is already finished`);
  const held = readRunLock(runDir);
  if (held && lockIsLive(runDir, held)) return fail(`run ${prepared.runId} is already owned by a live orchestrator (pid ${held.pid})`);

  // A detached orchestrator must outlive its parent's terminal: ignore hang-up.
  process.on("SIGHUP", () => {});
  const handle = new LocalExecutor().startRun(prepared, {
    lock: { protection: unit ? "unit" : "none", unit },
    graceMs: Number(process.env.AMICO_RUN_GRACE_MS) || undefined,
  });
  const onSignal = (): void => {
    void handle.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  for await (const _ev of handle.events) {
    /* run.log is written by the executor; adopt mode streams nothing to stdout */
  }
  const f = await handle.finished;
  if (!existsSync(join(runDir, "FINISHED"))) {
    console.error(`amico-run: FINISHED missing in ${runDir} (write fault)`);
    return 64;
  }
  if (spec?.tier === "free") await verifyFreeLocal(runDir, spec);
  return exitCodeFor(f);
}

function fail(msg: string): number {
  console.error(`amico-run: adopt: ${msg}`);
  return 64;
}

/** Rebuild what prepareRun decided from the run dir: manifest + solvespec.json (+ problem.toml). */
function load(runDir: string): Adopted | string {
  const read = (name: string): string | undefined => {
    try {
      return readFileSync(join(runDir, name), "utf8");
    } catch {
      return undefined;
    }
  };
  const manifestText = read("run.toml");
  if (manifestText === undefined) return `${runDir} is not a prepared run (no run.toml)`;
  let manifest: Record<string, unknown>;
  try {
    manifest = parseToml(manifestText) as Record<string, unknown>;
  } catch (e) {
    return `unparseable run.toml in ${runDir}: ${(e as Error).message}`;
  }
  const julia = (manifest.julia ?? {}) as { binary?: string; project?: string; sysimage?: string };
  const scriptPath = manifest.script_path;
  if (typeof manifest.run_id !== "string" || typeof scriptPath !== "string" || typeof julia.binary !== "string")
    return `run.toml in ${runDir} is missing run_id / script_path / julia.binary`;

  const specText = read("solvespec.json");
  let specObj: Record<string, unknown> | undefined;
  if (specText !== undefined) {
    try {
      specObj = JSON.parse(specText) as Record<string, unknown>;
    } catch (e) {
      return `unparseable solvespec.json in ${runDir}: ${(e as Error).message}`;
    }
  }
  const hashes = (manifest.hashes ?? undefined) as Record<string, string> | undefined;
  const tier = typeof manifest.tier === "string" ? manifest.tier : undefined;
  const isProblemSpec = specObj?.problem_spec !== undefined;

  const prepared: PreparedRun = {
    runId: manifest.run_id,
    runDir,
    runsRoot: join(runDir, ".."),
    juliaBin: julia.binary,
    juliaArgs: juliaArgv(julia, isProblemSpec ? { problemSpecPath: scriptPath } : { script: scriptPath }),
    specHash: hashes?.spec_hash ?? null,
    tier,
  };
  const spec: SpecStamp | undefined =
    specText === undefined
      ? undefined
      : { canonical: specText, tier, hashes, julia_binary: julia.binary, env_project: julia.project };
  return { prepared, spec };
}
