import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants, createWriteStream, existsSync, mkdirSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { delimiter, join, resolve } from "node:path";
import * as readline from "node:readline";
import { stringify as tomlStringify } from "smol-toml";
import { EventQueue } from "./event_queue.js";
import { classifyLine } from "./telemetry.js";
import {
  appendIndex,
  atomicWriteFile,
  defaultRunsRoot,
  deriveLabId,
  generateRunId,
  updateLatest,
  writeFinished,
  writeManifest,
} from "./run_dir.js";
import {
  ConfigError,
  type Executor,
  type Finished,
  type RunEvent,
  type RunHandle,
  type RunStatus,
  type SubmitOpts,
} from "./types.js";

import pkg from "../package.json" with { type: "json" };
const ORCHESTRATOR_VERSION = pkg.version; // single source of truth (esbuild inlines the JSON)

// solvespec v4 problem_spec routing: instead of running an authored script, drive
// the generic typed-spec runner. `julia -e '<PROBLEM_SPEC_RUNNER>' <path>` puts the
// spec path at ARGS[1]; cwd is the run dir, so run_dir=pwd() lands artifacts there.
const PROBLEM_SPEC_RUNNER = "using Piccolo; Piccolo.Specs.solve_spec(ARGS[1]; run_dir=pwd())";

function resolveExecutable(bin: string): void {
  const candidates = bin.includes("/")
    ? [resolve(bin)]
    : (process.env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((d) => join(d, bin));
  for (const c of candidates) {
    try {
      accessSync(c, fsConstants.X_OK);
      return;
    } catch {
      /* keep looking */
    }
  }
  throw new ConfigError(`julia binary not found or not executable: ${bin}`);
}

function signalCode(signal: NodeJS.Signals | null): number {
  const n = signal ? (osConstants.signals as Record<string, number>)[signal] : undefined;
  return 128 + (n ?? 1);
}

export class LocalExecutor implements Executor {
  async submit(scriptPath: string | undefined, opts: SubmitOpts = {}): Promise<RunHandle> {
    // ---- step 1 (spec §5): validate config; failures here create NO run dir ----
    // Two shapes: a normal script run, or a v4 problem_spec run (route to
    // Piccolo.Specs.solve_spec). For problem_spec, `script` (recorded as the
    // run.toml script_path) is the spec artifact: a string path resolves + must
    // exist now; an inline object is written to <runDir>/problem.toml AFTER the
    // manifest (path known once runDir exists — filled in step 2 below).
    const problemSpec = opts.spec?.problem_spec;
    const inlineProblemSpec = problemSpec !== undefined && typeof problemSpec !== "string";
    let script: string;
    let problemSpecPath: string | undefined; // absolute path passed to solve_spec as ARGS[1]
    if (problemSpec !== undefined) {
      if (typeof problemSpec === "string") {
        problemSpecPath = resolve(problemSpec);
        if (!existsSync(problemSpecPath)) throw new ConfigError(`problem_spec not found: ${problemSpecPath}`);
        script = problemSpecPath;
      } else {
        script = ""; // filled after runDir exists (inline → <runDir>/problem.toml)
      }
    } else {
      if (scriptPath === undefined) throw new ConfigError("no script or problem_spec given");
      script = resolve(scriptPath);
      if (!existsSync(script)) throw new ConfigError(`script not found: ${script}`);
    }
    const juliaBin = opts.julia?.julia ?? "julia";
    resolveExecutable(juliaBin);
    const lab = opts.lab ?? "default";
    const labId = deriveLabId(lab);
    const runsRoot = opts.runsRoot ?? defaultRunsRoot(labId);
    try {
      mkdirSync(runsRoot, { recursive: true });
    } catch (e) {
      throw new ConfigError(`runs root not writable: ${runsRoot} (${(e as Error).message})`);
    }

    // ---- steps 2–5: run dir, manifest FIRST, index, latest ----
    const runId = generateRunId(runsRoot);
    const runDir = join(runsRoot, runId);
    mkdirSync(runDir);
    // inline problem_spec: its problem.toml lives in the run dir — now that runDir
    // exists, resolve the path so run.toml's script_path records it (written next).
    if (inlineProblemSpec) {
      problemSpecPath = join(runDir, "problem.toml");
      script = problemSpecPath;
    }
    const createdAt = new Date().toISOString();
    writeManifest(runDir, {
      // spec C: --spec launches stamp tier + hashes and bump to v2; bare runs stay v1
      schema_version: opts.spec ? "2" : "1",
      run_id: runId,
      script_path: script,
      lab,
      lab_id: labId,
      created_at: createdAt,
      orchestrator_version: ORCHESTRATOR_VERSION,
      julia: { binary: juliaBin, project: opts.julia?.project, sysimage: opts.julia?.sysimage },
      tier: opts.spec?.tier,
      hashes: opts.spec?.hashes,
    });
    // manifest is FIRST (above); an inline problem_spec's problem.toml follows it,
    // then solvespec.json — the run-dir contract's ordering is preserved.
    if (inlineProblemSpec)
      atomicWriteFile(runDir, "problem.toml", tomlStringify(problemSpec as Record<string, unknown>));
    if (opts.spec) atomicWriteFile(runDir, "solvespec.json", opts.spec.canonical + "\n");
    appendIndex(runsRoot, runId, createdAt, script);
    updateLatest(runsRoot, runId);

    // ---- step 6: spawn julia, own process group, cwd = runDir ----
    const args: string[] = [];
    if (opts.julia?.project) args.push(`--project=${opts.julia.project}`);
    if (opts.julia?.sysimage) args.push(`--sysimage=${opts.julia.sysimage}`);
    // problem_spec → the generic typed-spec runner; else the authored script.
    if (problemSpecPath !== undefined) args.push("-e", PROBLEM_SPEC_RUNNER, problemSpecPath);
    else args.push(script);

    const events = new EventQueue<RunEvent>();
    const logStream = createWriteStream(join(runDir, "run.log"), { flags: "a" });
    let resolveFinished!: (f: Finished) => void;
    const finished = new Promise<Finished>((r) => {
      resolveFinished = r;
    });

    let settled = false;
    let aborting = false;
    const settle = (status: RunStatus, exitCode: number): void => {
      if (settled) return;
      settled = true;
      try {
        writeFinished(runDir, status, exitCode); // orchestrator verdict, atomic — overwrites
      } catch (e) {
        // any FINISHED a script faked (spec §5 step 8)
        process.stderr.write(`amico-run: failed to write FINISHED: ${(e as Error).message}\n`);
      }
      logStream.end();
      events.push({ kind: "finished", status, exitCode });
      events.close();
      resolveFinished({ status, exitCode });
    };

    // stdbuf (spec §5 "where available") is deliberately omitted in β.1: the β.3 script
    // convention prints with flush, and the fake-julia fixtures are node (line-flushed).
    // If live ITER streaming degrades on a real lab machine, β.6's dry-run catches it.
    const child = spawn(juliaBin, args, {
      cwd: runDir,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // spawn failure AFTER manifest exists → FINISHED{failed, 127} (spec §6)
    child.on("error", () => settle("failed", 127));
    // 'close', NOT 'exit': close waits for stdout/stderr to drain, so every line event
    // lands before settle() — the events stream must terminate ON the finished event (§3).
    child.on("close", (code, signal) => {
      const rc = code ?? signalCode(signal);
      settle(aborting ? "aborted" : rc === 0 ? "completed" : "failed", rc);
    });

    const onLine =
      (stream: "stdout" | "stderr") =>
      (line: string): void => {
        if (settled) return; // belt-and-braces; 'close' ordering makes this rare
        logStream.write(line + "\n");
        events.push(classifyLine(line, stream));
      };
    readline.createInterface({ input: child.stdout! }).on("line", onLine("stdout"));
    readline.createInterface({ input: child.stderr! }).on("line", onLine("stderr"));

    const graceMs = opts.graceMs ?? 5000;
    const abort = async (): Promise<void> => {
      if (settled) return;
      aborting = true;
      const killGroup = (sig: NodeJS.Signals): void => {
        try {
          process.kill(-child.pid!, sig);
        } catch {
          /* already gone */
        }
      };
      killGroup("SIGTERM");
      const killer = setTimeout(() => killGroup("SIGKILL"), graceMs);
      killer.unref();
      await finished;
      clearTimeout(killer);
    };

    return { runId, runDir, events, finished, abort };
  }
}
