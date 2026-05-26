#!/usr/bin/env node
// ============================================================================
// amico-mcp — a minimal MCP server (JSON-RPC over stdio) that opencode spawns
// per its config (.opencode/config.json:mcp.amico). One tool:
//
//   amico_run_julia(args) — spawns spike_solve.jl with the given args, parses
//   AMICODE_ITER lines and POSTs them to the extension's CallbackServer for
//   live Inspector updates. Returns final result.toml summary.
//
// Note on safe process usage: every subprocess spawn in this file uses
// child_process.spawn(file, argv[], opts) — NEVER exec. There is no shell
// interpolation; all caller-supplied values are passed as discrete argv
// entries. The opts only include stdio, no shell flag.
//
// Env vars (injected by .opencode/config.json):
//   AMICODE_EXTENSION_URL  — base URL of the extension's CallbackServer
//   AMICODE_JULIA_SCRIPT   — abs path to amicode/julia/spike_solve.jl
//   AMICODE_JULIA_PROJECT  — Julia --project=… root
// ============================================================================

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const EXTENSION_URL = process.env.AMICODE_EXTENSION_URL ?? "";
const JULIA_SCRIPT  = process.env.AMICODE_JULIA_SCRIPT  ?? "";
const JULIA_PROJECT = process.env.AMICODE_JULIA_PROJECT ?? "";

const log = (...args: unknown[]) => process.stderr.write("[amico-mcp] " + args.join(" ") + "\n");

log("starting; extension=" + EXTENSION_URL + " script=" + JULIA_SCRIPT + " project=" + JULIA_PROJECT);

// ─── JSON-RPC framing ───────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function send(msg: JsonRpcResponse | { jsonrpc: "2.0"; method: string; params?: unknown }): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

// ─── Tool registry ──────────────────────────────────────────────────────────

const RUN_JULIA_INPUT_SCHEMA = {
  type: "object",
  properties: {
    system:    { type: "string", enum: ["qubit", "transmon"] },
    gate:      { type: "string", enum: ["X", "Y", "Z", "H", "S", "T", "CNOT", "CZ", "SWAP", "iSWAP"] },
    pulse:     { type: "string", enum: ["zero-order", "linear-spline"] },
    T_ns:      { type: "number" },
    omega_cap: { type: "number" },
    max_iter:  { type: "integer" },
  },
  required: ["system", "gate", "pulse"],
};

async function callback(action: unknown): Promise<void> {
  if (!EXTENSION_URL) return;
  try {
    await fetch(EXTENSION_URL + "/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(action),
    });
  } catch (err) {
    log("callback /action failed:", String(err));
  }
}

async function pushIter(rec: { iter: number; f_val: number; inf_pr: number; inf_du: number }): Promise<void> {
  if (!EXTENSION_URL) return;
  try {
    await fetch(EXTENSION_URL + "/iter", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rec),
    });
  } catch {
    /* don't flood stderr; pushIter is best-effort */
  }
}

// ─── run_julia ──────────────────────────────────────────────────────────────

const AMICODE_ITER_RE = /^AMICODE_ITER\s+iter=(\d+)\s+f=(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s+inf_pr=(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s+inf_du=(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s*$/;

interface RunJuliaArgs {
  system: "qubit" | "transmon";
  gate: string;
  pulse: "zero-order" | "linear-spline";
  T_ns?: number;
  omega_cap?: number;
  max_iter?: number;
}

async function runJulia(args: RunJuliaArgs, progress: (msg: string) => void): Promise<string> {
  if (!JULIA_SCRIPT || !fs.existsSync(JULIA_SCRIPT)) {
    throw new Error(`spike_solve.jl not found at ${JULIA_SCRIPT}`);
  }

  const runId = `r${Date.now().toString(36)}`;
  const outputDir = path.join(os.tmpdir(), "amicode-v2-runs", runId);
  fs.mkdirSync(outputDir, { recursive: true });

  await callback({ kind: "run-state", state: "starting", runId, outputDir });
  await callback({ kind: "open-inspector" });

  const julArgs = [
    `--project=${JULIA_PROJECT}`,
    JULIA_SCRIPT,
    "--system", args.system,
    "--gate", args.gate,
    "--pulse", args.pulse,
    "--solver", "ipopt",
    "--output-dir", outputDir,
    "--print-level", "0",
  ];
  if (args.T_ns      !== undefined) julArgs.push("--T-ns", String(args.T_ns));
  if (args.omega_cap !== undefined) julArgs.push("--omega-cap", String(args.omega_cap));
  if (args.max_iter  !== undefined) julArgs.push("--max-iter", String(args.max_iter));

  // stdbuf -oL for Ipopt's C-side line-buffered stdout (Linux). spawn(file, argv[]) —
  // never exec. All argv entries are validated/literal; no shell interpolation.
  const usingStdbuf = process.platform === "linux";
  const exe  = usingStdbuf ? "stdbuf" : "julia";
  const argv = usingStdbuf ? ["-oL", "-eL", "julia", ...julArgs] : julArgs;

  log(`spawning ${exe} ${argv.join(" ")}`);
  progress(`spawning julia ${JULIA_SCRIPT}`);

  return new Promise<string>((resolve, reject) => {
    const child = childProcess.spawn(exe, argv, { stdio: ["ignore", "pipe", "pipe"] });

    let stdoutBuf = "";
    let stderrBuf = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      let nl: number;
      while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        const m = AMICODE_ITER_RE.exec(line);
        if (m) {
          const rec = {
            iter:   parseInt(m[1], 10),
            f_val:  parseFloat(m[2]),
            inf_pr: parseFloat(m[3]),
            inf_du: parseFloat(m[4]),
          };
          pushIter(rec).catch(() => {});
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      let nl: number;
      while ((nl = stderrBuf.indexOf("\n")) >= 0) {
        const line = stderrBuf.slice(0, nl).trim();
        stderrBuf = stderrBuf.slice(nl + 1);
        if (line) progress(line);
      }
    });
    child.on("error", (err) => {
      callback({ kind: "run-state", state: "failed", runId, outputDir }).catch(() => {});
      reject(err);
    });
    child.on("close", (code) => {
      const state: "completed" | "failed" = code === 0 ? "completed" : "failed";
      callback({ kind: "run-state", state, runId, outputDir }).catch(() => {});
      if (code !== 0) {
        reject(new Error(`julia exited with code ${code}`));
        return;
      }
      const resultPath = path.join(outputDir, "result.toml");
      let summary = `Run ${runId} completed (no result.toml at ${resultPath}).`;
      if (fs.existsSync(resultPath)) {
        const txt = fs.readFileSync(resultPath, "utf8");
        const fid   = (txt.match(/fidelity\s*=\s*([\d.eE+-]+)/) ?? [])[1];
        const iters = (txt.match(/iterations\s*=\s*(\d+)/) ?? [])[1];
        const wall  = (txt.match(/wall_time_s\s*=\s*([\d.eE+-]+)/) ?? [])[1];
        summary = `Run ${runId} completed. F=${fid ?? "?"}, iter=${iters ?? "?"}, wall=${wall ?? "?"}s. Output dir: ${outputDir}`;
      }
      resolve(summary);
    });
  });
}

// ─── Dispatch ───────────────────────────────────────────────────────────────

function ok(id: number | string, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function err(id: number | string | null, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function dispatch(req: JsonRpcRequest): Promise<void> {
  const id = req.id ?? null;
  try {
    switch (req.method) {
      case "initialize": {
        ok(id ?? 0, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "amico-mcp", version: "0.0.1" },
        });
        return;
      }
      case "notifications/initialized":
      case "initialized": {
        return;
      }
      case "tools/list": {
        ok(id ?? 0, {
          tools: [
            {
              name: "amico_run_julia",
              description:
                "Run a Piccolo / Piccolissimo quantum-control optimization via Amicode's spike_solve.jl. Spawns Julia, " +
                "streams per-iteration progress to the VS Code Run Inspector, returns final fidelity + path to the result " +
                "directory. Use this when the user wants to optimize a gate (X / Y / Z / H / CNOT / CZ / SWAP / iSWAP) " +
                "on a qubit (toy Pauli) or transmon (4-level Duffing / multi-transmon) system.",
              inputSchema: RUN_JULIA_INPUT_SCHEMA,
            },
          ],
        });
        return;
      }
      case "tools/call": {
        const params = req.params as { name: string; arguments?: RunJuliaArgs };
        if (params.name !== "amico_run_julia") {
          err(id, -32601, `unknown tool: ${params.name}`);
          return;
        }
        const args = params.arguments ?? ({} as RunJuliaArgs);
        const summary = await runJulia(args, (msg) => {
          send({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: msg } });
        });
        ok(id ?? 0, { content: [{ type: "text", text: summary }] });
        return;
      }
      default: {
        err(id, -32601, `method not found: ${req.method}`);
      }
    }
  } catch (e) {
    err(id, -32603, `internal error: ${(e as Error).message}`);
  }
}

// ─── stdio loop ─────────────────────────────────────────────────────────────

let inbuf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  inbuf += chunk;
  let nl: number;
  while ((nl = inbuf.indexOf("\n")) >= 0) {
    const line = inbuf.slice(0, nl).trim();
    inbuf = inbuf.slice(nl + 1);
    if (!line) continue;
    let msg: JsonRpcRequest;
    try { msg = JSON.parse(line); }
    catch (e) { log("parse error:", String(e), "line:", line); continue; }
    dispatch(msg).catch((e) => log("dispatch error:", String(e)));
  }
});

process.stdin.on("end", () => { log("stdin closed; exiting"); process.exit(0); });
process.on("SIGTERM", () => { log("SIGTERM"); process.exit(0); });
process.on("SIGINT",  () => { log("SIGINT"); process.exit(0); });
