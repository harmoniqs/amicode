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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { seedAmicodeSandbox } from "./amicode_fixture_seed.mjs";

const PKG_ROOT = join(import.meta.dirname, "..");
const FIXTURE_OUT = join(PKG_ROOT, "test", "fixtures", "amicode", "golden.json");

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
  // ── vault family (slice 2) ──────────────────────────────────────────────────
  // The {SANDBOX} placeholder is substituted with the recording sandbox dir at
  // request time (test bodies embed absolute paths); responses carrying the
  // sandbox dir are normalized against meta.sandbox in the replay.
  { method: "GET", path: "/amicode/vaults", name: "vaults — CLI-less scan (mounts, kind order)" },
  {
    method: "POST",
    path: "/amicode/vaults",
    body: { ref: "{SANDBOX}/attachable-demo" },
    name: "attach local vault (symlink flavor)",
  },
  { method: "GET", path: "/amicode/vaults", name: "vaults — post-attach (cache bust, new mount)" },
  { method: "GET", path: "/amicode/vault-files?mount=personal-main", name: "browse personal mount (flat listing)" },
  { method: "GET", path: "/amicode/vault-files?mount=team-shared", name: "browse team mount — fail-closed refusal" },
  {
    method: "GET",
    path: "/amicode/vault-file?mount=personal-main&path=notes%2Fnote.md",
    name: "read one file in mount",
  },
  {
    method: "GET",
    path: "/amicode/vault-file?mount=personal-main&path=data%2Fbinary.bin",
    name: "read non-text file — not_text refusal",
  },
  {
    method: "GET",
    path: "/amicode/vault-file?mount=personal-main&path=..%2F..%2Fattachable-demo%2Fattached.md",
    name: "traversal attempt — escape refusal",
  },
  { method: "GET", path: "/amicode/warrants", name: "warrants — ledger read (solves_used + corrupt-line tolerance)" },
  { method: "POST", path: "/amicode/approve", body: { plan_hash: "abc123" }, name: "approve via stub amico (success)" },
  { method: "POST", path: "/amicode/approve", body: "not json", name: "approve — bad body refusal" },
  {
    method: "GET",
    path: `/amicode/resolve-file?path=${encodeURIComponent("{SANDBOX}/docs/readme.md")}`,
    name: "resolve absolute path (tier 1)",
  },
  {
    method: "GET",
    path: `/amicode/resolve-file?path=${encodeURIComponent("personal-main/notes/note.md")}`,
    name: "resolve mount-prefixed (tier 3)",
  },
  {
    method: "GET",
    path: `/amicode/resolve-file?path=${encodeURIComponent("docs/readme.md")}`,
    name: "resolve relative w/ dir part (tier 4 → project dir)",
  },
  {
    method: "GET",
    path: `/amicode/resolve-file?path=${encodeURIComponent("insight-nothing.md")}`,
    name: "resolve bare typed-prefix — miss (tier 5)",
  },
  {
    method: "GET",
    path: `/amicode/resolve-file?path=${encodeURIComponent("https://example.com/x")}`,
    name: "resolve scheme-ful string — not a file ref",
  },
  // ── problems family (slice 3) ──────────────────────────────────────────────
  { method: "GET", path: "/amicode/problems", name: "problems list — active + slugs + entity kinds" },
  { method: "GET", path: "/amicode/problem", name: "problem detail — active slug (score stamped)" },
  { method: "GET", path: "/amicode/problem?slug=t-gate-transmon", name: "problem detail — score_stages via interview_state fallback" },
  { method: "GET", path: "/amicode/problem?slug=cat-state-cavity", name: "problem detail — no entities dir, no runs" },
  { method: "GET", path: "/amicode/problem?slug=no-such-problem", name: "problem detail — not_found" },
  { method: "GET", path: "/amicode/run-status", name: "run status — active problem, all terminal states" },
  { method: "GET", path: "/amicode/run-status?slug=cat-state-cavity", name: "run status — other-lab ref" },
  { method: "GET", path: "/amicode/run-cards", name: "run cards — trophy case (completed only, newest first)" },
  { method: "GET", path: "/amicode/run-series?run=r20260801-000000Z-0a1b2c", name: "run series — completed (pulse + series + elapsed)" },
  { method: "GET", path: "/amicode/run-series?run=r20260805-000000Z-9z8y7x", name: "run series — stopped (cooperative-stop relabel)" },
  { method: "GET", path: "/amicode/run-series?run=r20260810-000000Z-3d4e5f", name: "run series — solving (DONE is a hint only)" },
  { method: "GET", path: "/amicode/run-series?run=r20260815-000000Z-6a7b8c", name: "run series — failed (result.toml ≠ finished)" },
  { method: "GET", path: "/amicode/run-series?run=r20260818-000000Z-4h5i6j", name: "run series — stalled (cold run.log)" },
  { method: "GET", path: "/amicode/run-series?run=r20260812-000000Z-5c6d7e&lab=other", name: "run series — explicit lab" },
  { method: "GET", path: "/amicode/run-series?run=no-such-run", name: "run series — not_found" },
  // ── library (slice 4) ──────────────────────────────────────────────────────
  { method: "GET", path: "/amicode/library", name: "library — seeded papers, newest first" },
  {
    method: "POST",
    path: "/amicode/library",
    body: { filename: "new paper.pdf", data_b64: Buffer.from("%PDF-1.4 uploaded paper body\n").toString("base64") },
    name: "library upload — valid PDF (refreshed listing)",
  },
  {
    method: "POST",
    path: "/amicode/library",
    body: { filename: "not-a-pdf.txt", data_b64: Buffer.from("plain text\n").toString("base64") },
    name: "library upload — bad_filetype refusal",
  },
  {
    method: "POST",
    path: "/amicode/library",
    body: { filename: "ok.pdf" },
    name: "library upload — missing data_b64 refusal",
  },
  { method: "GET", path: "/amicode/library", name: "library — post-upload state" },
  // ── widget kernel + dashboard (slice 5) ────────────────────────────────────
  { method: "GET", path: "/amicode/widgets", name: "widget registry — builtins with content hashes" },
  { method: "GET", path: "/amicode/widget-frame?id=meet-amico", name: "widget frame — served HTML + its own CSP" },
  { method: "GET", path: "/amicode/widget-frame?id=not-a-widget", name: "widget frame — unknown id stub" },
  { method: "GET", path: "/amicode/widget-code?id=about-you", name: "widget code — builtin source + hash" },
  { method: "GET", path: "/amicode/widget-code?id=no-such", name: "widget code — not_found" },
  {
    method: "POST",
    path: "/amicode/widget-fork",
    body: { id: "pulse-bank", new_id: "my-pulse-bank", session: "seed-session" },
    name: "widget fork — builtin forked into user widgets",
  },
  {
    method: "POST",
    path: "/amicode/widget-fork",
    body: { id: "pulse-bank", new_id: "my-pulse-bank" },
    name: "widget fork — exists refusal",
  },
  { method: "POST", path: "/amicode/widget-fork", body: { id: "nope" }, name: "widget fork — not_found" },
  { method: "GET", path: "/amicode/dashboard", name: "dashboard — stored state merge (hidden, passthrough, missing)" },
  {
    method: "POST",
    path: "/amicode/dashboard",
    body: {
      version: 1,
      widget: [
        { id: "about-you", hidden: false, config: {}, group: "right" },
        { id: "my-pulse-bank", hidden: true, config: {} },
      ],
      views: { home: "grid" },
    },
    name: "dashboard save — merge + reserved keys",
  },
  {
    method: "POST",
    path: "/amicode/dashboard",
    body: { widget: "not-a-list" },
    name: "dashboard save — bad_body refusal",
  },
];

async function main() {
  const flagIdx = process.argv.indexOf("--binary");
  const binary = resolveBinary(flagIdx >= 0 ? process.argv[flagIdx + 1] : undefined);
  const version = spawnSync(binary, ["--version"], { encoding: "utf8" }).stdout.trim();
  console.log(`[record] fork binary: ${binary} (${version})`);

  const sandbox = mkdtempSync(join(tmpdir(), "amicode-fixture-"));
  const { env: seedEnv, seededAt } = seedAmicodeSandbox(sandbox);
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
    // {SANDBOX} substitution: request paths/bodies embed the recording sandbox.
    const path = req.path
      .replaceAll("{SANDBOX}", sandbox)
      .replaceAll(encodeURIComponent("{SANDBOX}"), encodeURIComponent(sandbox));
    const body =
      req.body === undefined
        ? undefined
        : typeof req.body === "string"
          ? req.body
          : JSON.stringify(
              JSON.parse(JSON.stringify(req.body), (_k, v) => (typeof v === "string"
                ? v.replaceAll("{SANDBOX}", sandbox)
                : v)),
            );
    const r = await fetch(base + path, {
      method: req.method,
      headers: { Authorization: auth, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body,
    });
    const respBody = await r.text();
    // Record the request with {SANDBOX} restored so the replay re-substitutes
    // ITS sandbox; the RESPONSE is stored as-served (normalization happens at
    // replay, against meta.sandbox below). Content-type + CSP are recorded
    // too — the served widget frame's OWN policy is part of its contract.
    entries.push({
      name: req.name,
      request: { method: req.method, path: req.path, ...(req.body !== undefined ? { body: req.body } : {}) },
      status: r.status,
      contentType: r.headers.get("content-type"),
      csp: r.headers.get("content-security-policy"),
      body: respBody,
    });
    console.log(`[record] ${req.method} ${path} → ${r.status} (${respBody.length} bytes)`);
  }

  child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));

  mkdirSync(join(PKG_ROOT, "test", "fixtures", "amicode"), { recursive: true });
  const manifest = JSON.parse(readFileSync(join(PKG_ROOT, "opencode.lock.json"), "utf8"));
  writeFileSync(
    FIXTURE_OUT,
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        fork: { version, tag: manifest.tag },
        // The recording sandbox dir (and its realpath — responses embed both
        // forms: unresolved joins and realpathSync'd results). The replay
        // normalizes these to <SANDBOX> on both sides before comparing.
        sandbox: sandbox,
        sandboxReal: realpathSync(sandbox),
        seededAt: seededAt, // added_ms of route-WRITTEN files (uploads) is wall-clock — normalized at replay
        entries,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`[record] wrote ${FIXTURE_OUT} (${entries.length} entries)`);
  rmSync(sandbox, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(`[record] FAILED: ${err}`);
  process.exit(1);
});
