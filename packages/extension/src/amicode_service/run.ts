// AMICODE SERVICE (#451): Node replacements for the two Bun-runtime seams the
// fork's amicode modules use — `run` from opencode's @/util/process (spawn
// with an abort deadline; `timeout` is the SIGTERM→SIGKILL grace period, not
// a deadline) and `Bun.which`. Faithful to the fork's semantics (util/process.ts
// @ v1.18.10-amicode.11) so ported modules keep their timeout behavior intact.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export interface RunOptions {
  /** Deadline: on abort, SIGTERM now, SIGKILL after `timeout` ms. */
  abort?: AbortSignal;
  /** SIGTERM→SIGKILL grace in ms (NOT a deadline — mirror of the fork). */
  timeout?: number;
  nothrow?: boolean;
  cwd?: string;
  env?: Record<string, string>;
}

export interface RunResult {
  code: number | undefined;
  stdout: Buffer;
  stderr: Buffer;
}

export async function run(cmd: string[], opts: RunOptions = {}): Promise<RunResult> {
  return await new Promise<RunResult>((resolve, reject) => {
    if (cmd.length === 0) {
      reject(new Error("Command is required"));
      return;
    }
    opts.abort?.throwIfAborted();
    const proc = spawn(cmd[0], cmd.slice(1), {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : undefined,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const errb: Buffer[] = [];
    proc.stdout?.on("data", (b: Buffer) => out.push(b));
    proc.stderr?.on("data", (b: Buffer) => errb.push(b));

    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      if (closed || proc.exitCode !== null || proc.signalCode !== null) return;
      closed = true;
      proc.kill("SIGTERM");
      const ms = opts.timeout ?? 5_000;
      if (ms <= 0) return;
      timer = setTimeout(() => proc.kill("SIGKILL"), ms);
    };

    proc.once("exit", (code) => {
      if (timer) clearTimeout(timer);
      opts.abort?.removeEventListener("abort", abort);
      resolve({ code: code ?? 0, stdout: Buffer.concat(out), stderr: Buffer.concat(errb) });
    });
    proc.once("error", (err) => {
      if (timer) clearTimeout(timer);
      opts.abort?.removeEventListener("abort", abort);
      reject(err);
    });

    if (opts.abort) {
      opts.abort.addEventListener("abort", abort, { once: true });
      if (opts.abort.aborted) abort();
    }
  });
}

/** Bun.which equivalent: first PATH hit that exists, else undefined. */
export function which(cmd: string): string | undefined {
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, cmd);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}
