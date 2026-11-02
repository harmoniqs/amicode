// Shared harness for the launcher goldens (#2045 B) and the placement suites:
// spawn the BUNDLED `amico run …` with a hermetic env, capture stdout/stderr/exit
// code, and normalise the volatile parts (temp root, run id, timestamps).
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const BUNDLE = join(__dirname, "..", "dist", "amico.js");

export function buildBundle(): void {
  execFileSync("node", [join(__dirname, "..", "esbuild.config.mjs")], { cwd: join(__dirname, ".."), stdio: "ignore" });
}

export function cliEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AMICODE_OPS_DIR: mkdtempSync(join(tmpdir(), "amico-run-ops-")),
    AMICO_RUN_PLACEMENT: "none",
    ...extra,
  };
  delete env.BUN_INSPECT;
  delete env.AMICODE_ENGINE_INSPECT;
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete env[k];
  return env;
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CliProc {
  child: ChildProcess;
  result: Promise<CliResult>;
  /** resolves once stdout has contained `needle` */
  waitFor(needle: string, ms?: number): Promise<void>;
  out(): string;
}

/** Spawn `amico <args>` (not `amico run` — pass the verb yourself). */
export function spawnCli(args: string[], env: NodeJS.ProcessEnv, opts: { detached?: boolean } = {}): CliProc {
  const child = spawn("node", [BUNDLE, ...args], { env, stdio: ["ignore", "pipe", "pipe"], detached: opts.detached });
  let stdout = "";
  let stderr = "";
  const waiters: Array<{ needle: string; resolve: () => void }> = [];
  child.stdout!.on("data", (d: Buffer) => {
    stdout += d.toString();
    for (const w of [...waiters]) if (stdout.includes(w.needle)) (waiters.splice(waiters.indexOf(w), 1), w.resolve());
  });
  child.stderr!.on("data", (d: Buffer) => {
    stderr += d.toString();
  });
  const result = new Promise<CliResult>((resolveP) => {
    child.on("close", (code, signal) => resolveP({ code: code ?? (signal ? 128 : -1), stdout, stderr }));
  });
  return {
    child,
    result,
    out: () => stdout,
    waitFor: (needle, ms = 20000) =>
      new Promise<void>((resolveP, reject) => {
        if (stdout.includes(needle)) return resolveP();
        const t = setTimeout(() => reject(new Error(`timeout waiting for ${JSON.stringify(needle)}; stdout so far: ${stdout}`)), ms);
        waiters.push({
          needle,
          resolve: () => {
            clearTimeout(t);
            resolveP();
          },
        });
      }),
  };
}

export function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<CliResult> {
  return spawnCli(args, env).result;
}

/** Replace the volatile parts of launcher output so it can be compared with a golden. */
export function normalize(text: string, root: string): string {
  return text
    .split(root)
    .join("<ROOT>")
    .replace(/r\d{8}-\d{6}Z-[0-9a-f]{4}/g, "<RUNID>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<TS>");
}

// ── helpers for the placement suites ──────────────────────────────────────────────────────────
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function waitUntil(what: string, pred: () => boolean, ms = 20000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return;
    await sleep(40);
  }
  throw new Error(`timeout waiting for ${what}`);
}

export const fileHas = (file: string, needle: string): boolean => {
  try {
    return readFileSync(file, "utf8").includes(needle);
  } catch {
    return false;
  }
};

/** The single run dir under a runs root (after its manifest exists). */
export async function onlyRunDir(runsRoot: string, ms = 20000): Promise<string> {
  let found = "";
  await waitUntil(`a run dir under ${runsRoot}`, () => {
    try {
      const ids = readdirSync(runsRoot).filter((e) => /^r\d{8}-/.test(e) && existsSync(join(runsRoot, e, "run.toml")));
      if (ids.length === 0) return false;
      found = join(runsRoot, ids[0]);
      return true;
    } catch {
      return false;
    }
  }, ms);
  return found;
}

export const runIdOf = (runDir: string): string => runDir.split("/").at(-1)!;

/** A fake julia that records its pid, prints READY, and runs until `<dir>/go` exists, then prints
 *  DONE and exits 0 (SIGTERM kills it → the abort lane). */
export function waitingJuliaBody(dir: string): string {
  return [
    `const fs = require('fs'), p = require('path');`,
    `fs.writeFileSync(${JSON.stringify(join(dir, "julia.pid"))}, String(process.pid));`,
    `console.log('READY');`,
    `const t = setInterval(() => { if (fs.existsSync(${JSON.stringify(join(dir, "go"))})) { clearInterval(t); console.log('DONE f=0.99'); } }, 40);`,
  ].join("\n");
}

export const letItFinish = (dir: string): void => writeFileSync(join(dir, "go"), "");

/** Best-effort cleanup of everything a test may have left running: the julia recorded in
 *  `<dir>/julia.pid` and the orchestrator in the run's lock. Only processes THIS test started. */
export function killStragglers(dir: string, runDir?: string): void {
  const kill = (pid: number): void => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* gone */
    }
  };
  try {
    kill(Number(readFileSync(join(dir, "julia.pid"), "utf8")));
  } catch {
    /* none */
  }
  if (runDir) {
    try {
      kill(JSON.parse(readFileSync(join(runDir, "run.lock"), "utf8")).pid);
    } catch {
      /* none */
    }
  }
}

export { dirname };
