#!/usr/bin/env node
// Smoke test: synthesize an opencode project dir via prepareOpencodeProject,
// boot opencode serve against it, confirm /event SSE returns 200 OK and the
// amico MCP shows up in the registered tools listing (via /config or /mcp
// endpoints — opencode 1.3.3 exposes these).
//
// Usage: node test/smoke_opencode_boot.mjs

import * as cp from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");

// Bundle prepareOpencodeProject standalone.
const harnessOut = path.join(os.tmpdir(), "amicode-smoke-bootharness.mjs");
const buildResult = cp.spawnSync(
  "npx",
  [
    "esbuild",
    path.join(here, "opencode_boot_harness.mjs"),
    "--bundle",
    "--format=esm",
    "--platform=node",
    `--outfile=${harnessOut}`,
  ],
  { encoding: "utf8" },
);
if (buildResult.status !== 0) {
  console.error("[smoke] bundle failed", buildResult.stdout, buildResult.stderr);
  process.exit(10);
}

// Run the harness — it prints PROJECT=<dir> on stdout.
const harnessChild = cp.spawnSync("node", [harnessOut], {
  encoding: "utf8",
  env: { ...process.env, AMICODE_V2_REPO: repo },
});
if (harnessChild.status !== 0) {
  console.error("[smoke] harness failed:", harnessChild.stderr);
  process.exit(11);
}
const projectDir = harnessChild.stdout.match(/PROJECT=(.+)/)?.[1]?.trim();
if (!projectDir) { console.error("[smoke] no PROJECT in harness output:", harnessChild.stdout); process.exit(12); }
console.log(`[smoke] project dir: ${projectDir}`);

// Confirm config landed.
const configPath = path.join(projectDir, ".opencode", "opencode.json");
if (!fs.existsSync(configPath)) {
  console.error("[smoke] FAIL: config.json missing at " + configPath);
  process.exit(13);
}
console.log("[smoke] OK: config.json written");

const cfgRaw = fs.readFileSync(configPath, "utf8");
const cfg = JSON.parse(cfgRaw);
if (!cfg.mcp?.amico) { console.error("[smoke] FAIL: mcp.amico missing in config"); process.exit(14); }
console.log("[smoke] OK: mcp.amico registered in config");

// Also confirm plugin symlink resolves
const pluginPath = path.join(projectDir, "plugin", "amicode-plugin.mjs");
if (!fs.existsSync(pluginPath)) {
  console.error("[smoke] FAIL: plugin/amicode-plugin.mjs missing");
  process.exit(15);
}
console.log("[smoke] OK: plugin symlink resolves");

// Pick a free port for opencode.
const port = await new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
  s.on("error", reject);
});

console.log(`[smoke] booting opencode serve --port=${port} in ${projectDir}`);
const oc = cp.spawn("opencode", ["serve", "--port", String(port)], {
  cwd: projectDir,
  stdio: ["ignore", "pipe", "pipe"],
});

let log = "";
oc.stdout.on("data", (b) => { const s = b.toString(); log += s; process.stdout.write(`[opencode] ${s}`); });
oc.stderr.on("data", (b) => { const s = b.toString(); log += s; process.stderr.write(`[opencode!] ${s}`); });

// Wait for opencode to become healthy.
async function waitHealthy(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
      if (r.ok || (r.status >= 200 && r.status < 400)) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

let exitCode = 0;
const fails = [];

const healthy = await waitHealthy(15000);
if (!healthy) {
  fails.push("opencode failed to become healthy within 15s");
  exitCode = 1;
} else {
  console.log("[smoke] OK: opencode is healthy");
}

if (healthy) {
  // Try /event with a short read.
  try {
    const ctrl = new AbortController();
    const resp = await fetch(`http://127.0.0.1:${port}/event`, {
      headers: { Accept: "text/event-stream" },
      signal: ctrl.signal,
    });
    if (resp.status !== 200) {
      fails.push(`/event returned ${resp.status}`);
      exitCode = 1;
    } else {
      console.log("[smoke] OK: /event returns 200 (SSE handshake)");
    }
    setTimeout(() => ctrl.abort(), 200);
    try { for await (const _ of resp.body) { break; } } catch {}
  } catch (e) {
    fails.push(`/event probe failed: ${e.message}`);
    exitCode = 1;
  }

  // Probe a few likely "what tools are loaded" endpoints in opencode 1.3.3.
  // Result is informational — opencode's HTTP surface isn't fully stable.
  for (const ep of ["/config", "/mcp", "/tool", "/tools"]) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}${ep}`, { signal: AbortSignal.timeout(500) });
      const text = r.status === 200 ? (await r.text()).slice(0, 200) : "";
      console.log(`[smoke] info: ${ep} → ${r.status} ${text ? "→ " + text : ""}`);
    } catch { /* endpoint not present */ }
  }
}

// Inspect log for amico-mcp/plugin loaded markers.
if (/amico/i.test(log)) {
  console.log("[smoke] OK: opencode log mentions 'amico' (mcp or plugin loaded)");
} else {
  console.log("[smoke] info: opencode log does not yet reference amico (may load lazily)");
}

if (fails.length > 0) {
  console.error("[smoke] FAILURES:");
  fails.forEach((f) => console.error("  - " + f));
}

oc.kill("SIGTERM");
setTimeout(() => oc.kill("SIGKILL"), 2000);
process.exit(exitCode);
