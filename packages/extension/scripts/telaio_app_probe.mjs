#!/usr/bin/env node
// telaio_app_probe.mjs — the boot proof + the capability audit (#682).
//
// The chat surface's evidence script: boots the telaio harness serve against
// a BUILT app tree and asserts the shell (the origin document, an asset with
// its content type, the auth-token bootstrap, the SSE stream), then audits
// the bundle's actual SDK surface route-by-route against the running harness
// — the honest capability report the picker's telaio copy and the M3
// port-decision worklist both consume.
//
// ENV-GATED (the repo's convention): with TELAIO_BIN absent the script
// SKIPS (exit 0) — CI has no telaio binary; the live phase runs it verbatim.
//
// USAGE (the live phase):
//   1. Build the app tree:
//        node packages/app-bundle/scripts/materialize.mjs --out /tmp/amicode-app \
//          && cd /tmp/amicode-app && pnpm install && pnpm --filter app build
//   2. Run:
//        TELAIO_BIN=/path/to/telaio TELAIO_APP_DIR=/tmp/amicode-app/<built-dist> \
//          node packages/extension/scripts/telaio_app_probe.mjs
//   Exit 0 = the shell holds; the audit table is the honest feature report.
//
// READ-ONLY EVIDENCE: boots, probes, reports, stops — never mutates state.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fail = (msg, code = 1) => { console.error(`[telaio-probe] FAIL: ${msg}`); process.exit(code); };
const skip = (msg) => { console.log(`[telaio-probe] SKIP: ${msg}`); process.exit(0); };

const TELAIO_BIN = (process.env.TELAIO_BIN ?? "").trim();
if (!TELAIO_BIN) skip("TELAIO_BIN not set — the env-gated live-phase script");
if (!existsSync(TELAIO_BIN)) fail(`TELAIO_BIN points at a missing file: ${TELAIO_BIN}`);

const APP_DIR = (process.env.TELAIO_APP_DIR ?? "").trim();
if (!APP_DIR || !existsSync(join(APP_DIR, "index.html")))
  skip(`a built app tree is required (TELAIO_APP_DIR with index.html) — see the header for the build recipe`);

// The bundle's actual SDK surface (grep-derived from the app bundle's
// client.* usage — the code is the truth about what the product exercises).
const ROUTE_AUDIT = [
  { name: "session.create", method: "POST", path: "/session", body: {}, verdict: "contract" },
  { name: "session.get", method: "GET", path: "/session/PROBE_ID", verdict: "contract" },
  { name: "session.list", method: "GET", path: "/session", verdict: "contract" },
  { name: "session.messages", method: "GET", path: "/session/PROBE_ID/message", verdict: "contract" },
  { name: "session.update (rename)", method: "POST", path: "/session/PROBE_ID", body: { title: "probe" }, verdict: "contract" },
  { name: "session.todo", method: "GET", path: "/session/PROBE_ID/todo", verdict: "honest-v1 (empty)" },
  { name: "session.diff", method: "GET", path: "/session/PROBE_ID/diff", verdict: "honest-v1 (empty)" },
  { name: "commands", method: "GET", path: "/command", verdict: "honest-v1 (empty)" },
  { name: "file finder", method: "GET", path: "/find/file?query=x", verdict: "honest-v1 (empty)" },
  { name: "session.share", method: "POST", path: "/session/PROBE_ID/share", body: {}, verdict: "501 (honest refusal)" },
  { name: "session.unshare", method: "DELETE", path: "/session/PROBE_ID/share", verdict: "no-op (local by construction)" },
  { name: "session.prompt", method: "POST", path: "/session/PROBE_ID/message",
    body: { parts: [{ type: "text", text: "probe" }] }, verdict: "LIVE-PHASE GATED (needs credentials)" },
];

const AUTH = `Basic ${Buffer.from("opencode:probepw123").toString("base64")}`;
const authed = (path, opts = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    ...opts,
    headers: { Authorization: AUTH, ...(opts.headers ?? {}) },
  });

// ── boot ─────────────────────────────────────────────────────────────────────
const proj = mkdtempSync(join(tmpdir(), "telaio-probe-"));
const port = 4979;
const child = spawn(TELAIO_BIN, ["serve", "--port", String(port)], {
  cwd: proj,
  env: { ...process.env, OPENCODE_SERVER_PASSWORD: "probepw123", TELAIO_APP_DIR: APP_DIR },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
child.stdout.on("data", (d) => (log += d));
child.stderr.on("data", (d) => (log += d));
const stop = () => { try { child.kill("SIGTERM"); } catch { /* already gone */ } };
process.on("exit", stop);

let up = false;
for (let i = 0; i < 160 && !up; i++) {   // 40s — a julia harness boots slower than a node one
  await new Promise((r) => setTimeout(r, 250));
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Authorization: AUTH } });
    up = r.ok;
  } catch { /* not yet */ }
}
up || fail(`telaio serve not up within 10s\n--- output ---\n${log}`);
console.log(`[telaio-probe] telaio up on :${port}`);

// ── the shell assertions ─────────────────────────────────────────────────────
{
  const r = await authed("/");
  const body = await r.text();
  if (!r.ok) fail(`GET / → ${r.status}, want 200`);
  if (!(r.headers.get("content-type") ?? "").includes("text/html")) fail(`GET / content-type: ${r.headers.get("content-type")}`);
  if (body.includes("TELAIO_APP_DIR")) fail(`GET / served the PLACEHOLDER — the app dir did not reach the harness`);
  console.log(`[telaio-probe] ✓ origin document (${body.length} bytes, not the placeholder)`);
}
{
  // an asset: parse the first script src out of the index document
  const index = await (await authed("/")).text();
  const m = index.match(/<script[^>]+src="([^"]+)"/) ?? index.match(/<link[^>]+href="([^"]+\.css)"/);
  if (!m) { console.log("[telaio-probe] ⚠ no asset reference found in the index document — skipping the asset assert"); }
  else {
    const assetPath = m[1].startsWith("http") ? null : m[1];
    if (assetPath) {
      const r = await authed(assetPath);
      const ct = r.headers.get("content-type") ?? "";
      if (!r.ok) fail(`asset ${assetPath} → ${r.status}`);
      if (ct.includes("text/html")) fail(`asset ${assetPath} served as text/html — the asset server is not resolving files`);
      console.log(`[telaio-probe] ✓ asset ${assetPath} (${ct})`);
    }
  }
}
{
  const anon = await fetch(`http://127.0.0.1:${port}/session`, { redirect: "manual" });
  if (anon.status !== 401) fail(`anonymous /session → ${anon.status}, want 401`);
  const tok = Buffer.from("opencode:probepw123").toString("base64");
  const viaParam = await fetch(`http://127.0.0.1:${port}/session?auth_token=${tok}`);
  if (!viaParam.ok) fail(`?auth_token= bootstrap → ${viaParam.status}, want 200`);
  console.log("[telaio-probe] ✓ auth: anonymous 401, ?auth_token= bootstrap 200");
}
{
  const r = await fetch(`http://127.0.0.1:${port}/event`, { headers: { Authorization: AUTH } });
  if (!(r.headers.get("content-type") ?? "").includes("text/event-stream")) fail(`/event content-type: ${r.headers.get("content-type")}`);
  r.body?.cancel();
  console.log("[telaio-probe] ✓ /event is an SSE stream");
}

// ── the capability audit ─────────────────────────────────────────────────────
console.log("\n[telaio-probe] ── capability audit (the bundle's SDK surface) ──");
let sid = null;
{
  const r = await authed("/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const j = await r.json().catch(() => ({}));
  sid = j?.id ?? null;
  console.log(`  ${r.ok && sid ? "✓" : "✗"} session.create → ${r.status}${sid ? ` (${sid})` : ""}`);
}
for (const probe of ROUTE_AUDIT) {
  if (probe.path.includes("PROBE_ID") && !sid) { console.log(`  - ${probe.name}: skipped (no session id)`); continue; }
  const path = probe.path.replace("PROBE_ID", sid ?? "");
  const r = await authed(path, {
    method: probe.method,
    headers: probe.body ? { "Content-Type": "application/json" } : undefined,
    body: probe.body ? JSON.stringify(probe.body) : undefined,
    signal: AbortSignal.timeout(20_000),   // a credential-less prompt route can legitimately take a while to fail — never wedge the probe
  }).catch((e) => (console.log(`      (${probe.name}: ${e.name === "TimeoutError" ? "20s timeout" : e.message})`), null));
  const verdict = r === null ? "request failed" : `${r.status}${r.ok ? " ok" : ""}`;
  console.log(`  ${r?.ok ? "✓" : "·"} ${probe.name} → ${verdict}  [${probe.verdict}]`);
}
console.log("\n[telaio-probe] the audit table is the picker-copy input and the port-decision worklist.");
console.log("[telaio-probe] PASS (the shell holds; the audit is the honest feature report)");
stop();
process.exit(0);
