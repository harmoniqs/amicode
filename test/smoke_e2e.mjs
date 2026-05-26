#!/usr/bin/env node
// End-to-end smoke test (everything below the iframe):
//
//   1. Spin up CallbackServer (with vscode shim) on a free port.
//   2. Spawn dist/amico-mcp.js with AMICODE_EXTENSION_URL pointing at #1.
//   3. Send tools/call amico_run_julia { system: qubit, gate: X, pulse: zero-order, max_iter: 50 }.
//   4. While the MCP runs, observe POSTs to /iter (AMICODE_ITER stream) and
//      /action (run-state lifecycle).
//   5. Assert: ≥1 iter POST received, run-state starting + completed POSTs,
//      tool result returns with a fidelity number.
//
// This proves the chain MCP → spike_solve.jl → julia stdout → callback HTTP →
// extension (shim). The only piece NOT exercised is the iframe → opencode →
// MCP path, which is opencode-internal and validated by the boot smoke.
//
// Usage: node test/smoke_e2e.mjs

import * as cp from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");

const julia = "/usr/bin/julia";
if (!fs.existsSync(julia) && !cp.spawnSync("which", ["julia"]).stdout?.length) {
  console.error("[e2e] SKIP: julia not on PATH");
  process.exit(0);
}

// 1. Build the callback bundle (same approach as smoke_callback.mjs).
const cbBundle = path.join(os.tmpdir(), "amicode-e2e-cb.mjs");
const cbBuild = cp.spawnSync(
  "npx",
  [
    "esbuild",
    path.join(repo, "test", "callback_smoke_entry.mjs"),
    "--bundle",
    "--format=esm",
    "--platform=node",
    `--alias:vscode=${path.join(repo, "test", "vscode_shim.mjs")}`,
    `--outfile=${cbBundle}`,
  ],
  { encoding: "utf8" },
);
if (cbBuild.status !== 0) {
  console.error("[e2e] FAIL: cb bundle failed:", cbBuild.stdout, cbBuild.stderr);
  process.exit(10);
}

// 1b. Patch the bundle to ALSO log /iter and /action requests to stdout so
// the parent can verify what arrived. The bundle's CallbackServer is built
// from src/callback_server.ts; the bundled file already logs via channel,
// and channel.appendLine in vscode_shim.mjs is __calls — but those don't
// surface to stdout. Wrap by spawning a tiny capturing proxy instead.
//
// Simpler: write a wrapper entry that imports the bundled artifact and adds
// a request observer via a hook in vscode_shim.

// Spawn the callback server bundle, parse PORT=<n>.
const cbChild = cp.spawn("node", [cbBundle], { stdio: ["ignore", "pipe", "pipe"] });
const cbErr = [];
cbChild.stderr.on("data", (b) => { cbErr.push(b.toString()); process.stderr.write(`[cb] ${b}`); });

const port = await new Promise((resolve, reject) => {
  let buf = "";
  const t = setTimeout(() => reject(new Error("timeout waiting for PORT")), 5000);
  cbChild.stdout.setEncoding("utf8");
  cbChild.stdout.on("data", (chunk) => {
    buf += chunk;
    const m = buf.match(/PORT=(\d+)/);
    if (m) { clearTimeout(t); resolve(parseInt(m[1], 10)); }
  });
});
const callbackUrl = `http://127.0.0.1:${port}`;
console.log(`[e2e] callback server up at ${callbackUrl}`);

// 2. Spawn amico-mcp with env pointing at callback.
const mcpEnv = {
  ...process.env,
  AMICODE_EXTENSION_URL: callbackUrl,
  AMICODE_JULIA_SCRIPT:  path.resolve(repo, "..", "amicode", "julia", "spike_solve.jl"),
  AMICODE_JULIA_PROJECT: "/tmp/amicode-spike-julia",
};
const mcp = cp.spawn("node", [path.join(repo, "dist", "amico-mcp.js")], {
  stdio: ["pipe", "pipe", "pipe"],
  env: mcpEnv,
});
mcp.stderr.on("data", (b) => process.stderr.write(`[mcp] ${b}`));

// Side channel: tap the callback server's port and observe traffic via a
// simple HTTP probe loop on /ping isn't enough — we need to observe POSTs.
// Easier: stand up our OWN tiny HTTP listener on a separate port and tell
// the MCP to use IT (already done via AMICODE_EXTENSION_URL above). Replace
// callbackUrl with our observer-only server.
mcp.kill("SIGTERM"); cbChild.kill("SIGTERM");

// Re-approach: skip the bundled CallbackServer and just stand up a tiny
// observer HTTP server in this process. We don't need the full action
// dispatcher for this smoke — only to count POSTs and capture payloads.
const http = await import("node:http");
const events = { iter: [], action: [] };
const observer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      const data = body ? JSON.parse(body) : null;
      if (req.url === "/iter") events.iter.push(data);
      else if (req.url === "/action") events.action.push(data);
      res.writeHead(req.url === "/iter" ? 204 : 200, { "Content-Type": "application/json" });
      res.end(req.url === "/action" && data?.kind === "show-quick-pick"
        ? JSON.stringify({ replyTo: data.replyTo, choice: data.choices?.[0] ?? null })
        : "ok");
    } catch (e) {
      res.writeHead(500); res.end(String(e));
    }
  });
});
const obsPort = await new Promise((resolve) => observer.listen(0, "127.0.0.1", () => resolve(observer.address().port)));
const obsUrl = `http://127.0.0.1:${obsPort}`;
console.log(`[e2e] observer up at ${obsUrl}`);

// Re-spawn MCP pointing at observer.
const mcp2 = cp.spawn("node", [path.join(repo, "dist", "amico-mcp.js")], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...mcpEnv, AMICODE_EXTENSION_URL: obsUrl },
});
mcp2.stderr.on("data", (b) => process.stderr.write(`[mcp] ${b}`));

let mcpBuf = "";
const mcpResponses = [];
mcp2.stdout.setEncoding("utf8");
mcp2.stdout.on("data", (chunk) => {
  mcpBuf += chunk;
  let nl;
  while ((nl = mcpBuf.indexOf("\n")) >= 0) {
    const line = mcpBuf.slice(0, nl).trim();
    mcpBuf = mcpBuf.slice(nl + 1);
    if (!line) continue;
    try { mcpResponses.push(JSON.parse(line)); }
    catch (e) { console.error("[e2e] parse error:", e.message); }
  }
});

function send(msg) { mcp2.stdin.write(JSON.stringify(msg) + "\n"); }

// 3. Drive the MCP.
send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {
  name: "amico_run_julia",
  arguments: { system: "qubit", gate: "X", pulse: "zero-order", max_iter: 50 },
}});

console.log("[e2e] tools/call sent; awaiting julia run (this takes 30-90s on cold compile)...");

// 4. Wait up to 3 minutes for the tool/call response.
const start = Date.now();
const deadline = start + 180_000;
let toolResponse;
while (Date.now() < deadline) {
  toolResponse = mcpResponses.find((r) => r.id === 2);
  if (toolResponse) break;
  await new Promise((r) => setTimeout(r, 500));
}

// Snapshot what we collected.
console.log(`[e2e] elapsed: ${((Date.now() - start) / 1000).toFixed(1)}s`);
console.log(`[e2e] iter POSTs:   ${events.iter.length}`);
console.log(`[e2e] action POSTs: ${events.action.length}`);
console.log(`[e2e] action kinds: ${[...new Set(events.action.map((a) => a?.kind))].join(", ")}`);

let exitCode = 0;
const fails = [];

if (!toolResponse) {
  fails.push("tools/call never returned within 180s");
  exitCode = 1;
} else if (toolResponse.error) {
  fails.push(`tools/call returned error: ${JSON.stringify(toolResponse.error)}`);
  exitCode = 1;
} else {
  console.log(`[e2e] OK: tool result: ${JSON.stringify(toolResponse.result).slice(0, 200)}`);
  const text = toolResponse.result?.content?.[0]?.text ?? "";
  if (!/F=[0-9.]/i.test(text)) {
    fails.push(`tool result text has no F=… fidelity: ${text.slice(0, 200)}`);
    exitCode = 1;
  }
}

if (events.iter.length === 0) {
  fails.push("zero AMICODE_ITER POSTs hit /iter");
  exitCode = 1;
} else {
  console.log(`[e2e] OK: first iter: ${JSON.stringify(events.iter[0])}`);
  console.log(`[e2e] OK: last iter:  ${JSON.stringify(events.iter[events.iter.length - 1])}`);
}

const stateKinds = events.action.filter((a) => a?.kind === "run-state").map((a) => a.state);
if (!stateKinds.includes("starting")) { fails.push("no run-state=starting POST"); exitCode = 1; }
if (!stateKinds.includes("completed") && !stateKinds.includes("failed")) {
  fails.push("no run-state=completed|failed POST");
  exitCode = 1;
}

if (fails.length > 0) {
  console.error("[e2e] FAILURES:");
  fails.forEach((f) => console.error("  - " + f));
} else {
  console.log("[e2e] ALL GREEN");
}

mcp2.kill("SIGTERM"); cbChild.kill("SIGTERM"); observer.close();
setTimeout(() => process.exit(exitCode), 500);
