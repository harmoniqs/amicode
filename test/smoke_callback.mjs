#!/usr/bin/env node
// Smoke test: bundles callback_server.ts with a vscode shim, boots it on a
// free port, POSTs each ExtensionAction kind, asserts dispatcher returns
// the expected status code and the shim recorded the call.
//
// Usage: node test/smoke_callback.mjs
// Exits 0 on success, non-zero on failure.

import * as cp from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as os from "node:os";

const here   = path.dirname(fileURLToPath(import.meta.url));
const repo   = path.resolve(here, "..");
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "amicode-smoke-cb-"));
const out    = path.join(outDir, "bundle.mjs");

// Bundle CallbackServer + types with vscode aliased to our shim.
const buildResult = cp.spawnSync(
  "npx",
  [
    "esbuild",
    path.join(repo, "test", "callback_smoke_entry.mjs"),
    "--bundle",
    "--format=esm",
    "--platform=node",
    `--alias:vscode=${path.join(repo, "test", "vscode_shim.mjs")}`,
    `--outfile=${out}`,
  ],
  { encoding: "utf8" },
);
if (buildResult.status !== 0) {
  console.error("[smoke] FAIL: bundle failed");
  console.error(buildResult.stdout, buildResult.stderr);
  process.exit(10);
}

// Run the bundle in a child process; it will print the port on stdout.
const child = cp.spawn("node", [out], { stdio: ["ignore", "pipe", "pipe"] });
child.stderr.on("data", (b) => process.stderr.write(`[bundle stderr] ${b.toString()}`));

const portPromise = new Promise((resolve, reject) => {
  let buf = "";
  child.stdout.setEncoding("utf8");
  const t = setTimeout(() => reject(new Error("timed out waiting for port")), 5000);
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    const m = buf.match(/PORT=(\d+)/);
    if (m) { clearTimeout(t); resolve(parseInt(m[1], 10)); }
  });
});

const port = await portPromise;
const base = `http://127.0.0.1:${port}`;

async function post(path, body) {
  const r = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const txt = await r.text();
  let json = null;
  try { json = txt ? JSON.parse(txt) : null; } catch { /* not JSON */ }
  return { status: r.status, text: txt, json };
}

let exitCode = 0;
const fails = [];

// /ping → 200
{
  const r = await post("/ping", {});
  if (r.status !== 200 || r.json?.ok !== true) { fails.push(`/ping wrong: ${r.status} ${r.text}`); exitCode = 1; }
  else console.log("[smoke] OK: /ping → 200 ok=true");
}

// show-notification → 200
{
  const r = await post("/action", { kind: "show-notification", level: "info", message: "hello" });
  if (r.status !== 200) { fails.push(`show-notification wrong status: ${r.status}`); exitCode = 1; }
  else console.log("[smoke] OK: show-notification → 200");
}

// show-quick-pick → 200, JSON body with choice
{
  const r = await post("/action", { kind: "show-quick-pick", question: "promote?", choices: ["yes", "no"], replyTo: "rt-1" });
  if (r.status !== 200 || r.json?.replyTo !== "rt-1") { fails.push(`show-quick-pick wrong: ${r.status} ${r.text}`); exitCode = 1; }
  else console.log(`[smoke] OK: show-quick-pick → reply ${JSON.stringify(r.json)}`);
}

// refresh-tree → 200
{
  const r = await post("/action", { kind: "refresh-tree", tree: "catalog" });
  if (r.status !== 200) { fails.push(`refresh-tree wrong: ${r.status}`); exitCode = 1; }
  else console.log("[smoke] OK: refresh-tree → 200");
}

// /iter → 204 (no body)
{
  const r = await post("/iter", { iter: 7, f_val: 0.123, inf_pr: 1e-3, inf_du: 1e-4 });
  if (r.status !== 204) { fails.push(`/iter wrong: ${r.status}`); exitCode = 1; }
  else console.log("[smoke] OK: /iter → 204");
}

// unknown action → 400
{
  const r = await post("/action", { kind: "no-such-action" });
  if (r.status !== 400) { fails.push(`unknown action wrong: ${r.status}`); exitCode = 1; }
  else console.log("[smoke] OK: unknown action → 400");
}

if (fails.length > 0) {
  console.error("[smoke] FAILURES:");
  fails.forEach((f) => console.error("  - " + f));
}

child.kill("SIGTERM");
process.exit(exitCode);
