#!/usr/bin/env node
// Records golden fixtures for the amicode-service contract tests (#451, M1).
//
// Boots the FORK binary (the vendored one pinned by opencode.lock.json — the
// parity reference for the port) against a freshly seeded sandbox and records
// {method, path, status, body} for the request sequence below into
// test/fixtures/amicode/profile.json. The contract test replays the same
// sequence against the PORTED extension-host service with the same seed and
// asserts deep-equal responses.
//
// Run by hand when a slice ports or the fork pin moves; the committed fixtures
// are what CI replays (CI never boots the fork binary).
//
//   node scripts/record_amicode_fixtures.mjs [--binary <path-to-fork-opencode>]
//
// Binary resolution: --binary > repo vendored copy > newest installed VSIX.
import { spawnSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { seedAmicodeSandbox } from "./amicode_fixture_seed.mjs";

const PKG_ROOT = join(import.meta.dirname, "..");
const FIXTURE_OUT = join(PKG_ROOT, "test", "fixtures", "amicode", "profile.json");

function resolveBinary(flag) {
  if (flag) {
    if (!existsSync(flag)) throw new Error(`--binary not found: ${flag}`);
    return flag;
  }
  const key = `${process.platform}-${process.arch}`;
  const vendored = join(PKG_ROOT, "vendor", "opencode", key, "opencode");
  if (existsSync(vendored)) return vendored;
  const vsix = join(homedir(), ".vscode", "extensions");
  if (existsSync(vsix)) {
    const dirs = readdirSync(vsix)
      .filter((d) => d.startsWith("harmoniqs.amicode-"))
      .sort(compareVersions);
    for (const d of [...dirs].reverse()) {
      const p = join(vsix, d, "vendor", "opencode", key, "opencode");
      if (existsSync(p)) return p;
    }
  }
  throw new Error("no fork binary found — pass --binary <path>");
}
function compareVersions(a, b) {
  const av = (a.match(/\d+(\.\d+)*/g) ?? ["0"]).map(Number);
  const bv = (b.match(/\d+(\.\d+)*/g) ?? ["0"]).map(Number);
  for (let i = 0; i < Math.max(av.length, bv.length); i++) {
    if ((av[i] ?? 0) !== (bv[i] ?? 0)) return (av[i] ?? 0) - (bv[i] ?? 0);
  }
  return 0;
}

const REQUESTS = [
  { method: "GET", path: "/amicode/profile", name: "cold read — synthesized identity + stats + remembers" },
  { method: "POST", path: `/amicode/profile?focus=${encodeURIComponent("Rydberg blockade")}`, name: "edit focus" },
  { method: "POST", path: "/amicode/profile?name=", name: "clear name — mounts.toml fallback fires" },
  { method: "GET", path: "/amicode/profile", name: "warm read — post-save state" },
];

async function main() {
  const flagIdx = process.argv.indexOf("--binary");
  const binary = resolveBinary(flagIdx >= 0 ? process.argv[flagIdx + 1] : undefined);
  const version = spawnSync(binary, ["--version"], { encoding: "utf8" }).stdout.trim();
  console.log(`[record] fork binary: ${binary} (${version})`);

  const sandbox = mkdtempSync(join(tmpdir(), "amicode-fixture-"));
  const { env: seedEnv } = seedAmicodeSandbox(sandbox);
  const password = "fixture-recording-password";
  const port = 4601 + Math.floor(Math.random() * 400);

  const child = spawn(binary, ["serve", "--port", String(port), "--hostname", "127.0.0.1"], {
    cwd: sandbox,
    env: {
      ...process.env,
      HOME: sandbox, // redirects the fork's ~/.amico reads (incl. mounts.toml)
      OPENCODE_DB: join(sandbox, "opencode-fixture.db"), // never touch a real chat DB
      OPENCODE_SERVER_PASSWORD: password,
      ...seedEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (b) => process.stdout.write(`[fork] ${b}`));
  child.stderr.on("data", (b) => process.stderr.write(`[fork!] ${b}`));

  const auth = "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
  const base = `http://127.0.0.1:${port}`;

  // health poll (authed — the fork 401s anonymous probes when armed)
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try {
      const r = await fetch(base + "/", { headers: { Authorization: auth } });
      if (r.status === 200) up = true;
    } catch {
      /* not listening yet */
    }
    if (!up) await new Promise((r) => setTimeout(r, 500));
  }
  if (!up) {
    child.kill("SIGTERM");
    throw new Error("fork server did not become healthy within 30s");
  }
  console.log(`[record] fork healthy on :${port}`);

  const entries = [];
  for (const req of REQUESTS) {
    const r = await fetch(base + req.path, { method: req.method, headers: { Authorization: auth } });
    const body = await r.text();
    entries.push({ name: req.name, request: { method: req.method, path: req.path }, status: r.status, body });
    console.log(`[record] ${req.method} ${req.path} → ${r.status} (${body.length} bytes)`);
  }

  child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));

  mkdirSync(join(PKG_ROOT, "test", "fixtures", "amicode"), { recursive: true });
  const manifest = JSON.parse(readFileSync(join(PKG_ROOT, "opencode.lock.json"), "utf8"));
  writeFileSync(
    FIXTURE_OUT,
    JSON.stringify({ recordedAt: new Date().toISOString(), fork: { version, tag: manifest.tag }, entries }, null, 2) + "\n",
  );
  console.log(`[record] wrote ${FIXTURE_OUT} (${entries.length} entries)`);
  rmSync(sandbox, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(`[record] FAILED: ${err}`);
  process.exit(1);
});
