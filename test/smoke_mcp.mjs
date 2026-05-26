#!/usr/bin/env node
// Smoke test: pipe initialize + tools/list to dist/amico-mcp.js, assert
// amico_run_julia tool is present in the response.
//
// Usage: node test/smoke_mcp.mjs
// Exits 0 on success, non-zero on failure.

import * as cp from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const mcp = path.resolve(here, "..", "dist", "amico-mcp.js");

const child = cp.spawn("node", [mcp], { stdio: ["pipe", "pipe", "pipe"] });

let stdoutBuf = "";
const responses = [];

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdoutBuf += chunk;
  let nl;
  while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
    const line = stdoutBuf.slice(0, nl).trim();
    stdoutBuf = stdoutBuf.slice(nl + 1);
    if (!line) continue;
    try { responses.push(JSON.parse(line)); }
    catch (e) { console.error("[smoke] parse error:", e.message, "line:", line); }
  }
});

child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => process.stderr.write(`[mcp stderr] ${chunk}`));

function send(msg) {
  child.stdin.write(JSON.stringify(msg) + "\n");
}

send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

// Give the server a moment to respond, then assert.
setTimeout(() => {
  child.stdin.end();
  let exitCode = 0;

  const init = responses.find((r) => r.id === 1);
  if (!init || !init.result || init.result.serverInfo?.name !== "amico-mcp") {
    console.error("[smoke] FAIL: initialize response missing or wrong serverInfo");
    console.error("[smoke] got:", JSON.stringify(init));
    exitCode = 2;
  } else {
    console.log("[smoke] OK: initialize → serverInfo.name = amico-mcp");
  }

  const tools = responses.find((r) => r.id === 2);
  if (!tools || !Array.isArray(tools.result?.tools)) {
    console.error("[smoke] FAIL: tools/list response missing or malformed");
    console.error("[smoke] got:", JSON.stringify(tools));
    exitCode = 3;
  } else {
    const t = tools.result.tools.find((x) => x.name === "amico_run_julia");
    if (!t) {
      console.error("[smoke] FAIL: amico_run_julia not in tools/list");
      exitCode = 4;
    } else if (!t.inputSchema?.properties?.system) {
      console.error("[smoke] FAIL: amico_run_julia inputSchema missing 'system' property");
      exitCode = 5;
    } else {
      console.log("[smoke] OK: tools/list → amico_run_julia present with inputSchema");
    }
  }

  child.kill("SIGTERM");
  process.exit(exitCode);
}, 500);
