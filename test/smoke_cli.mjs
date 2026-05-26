#!/usr/bin/env node
// CLI-direct smoke test: invokes bin/amico-run as opencode/the LLM would
// (via bash), asserts the run dir lifecycle matches what the extension's
// RunsRootWatcher will observe.
//
// Asserts:
//   - exit code 0
//   - /tmp/amicode-runs/latest symlink points at the new run dir
//   - run dir contains: .start, iter_NNNN.png (≥2), result.toml, FINISHED
//   - result.toml fidelity is > 0.99
//
// Usage: node test/smoke_cli.mjs

import * as cp from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const amicoRun = path.join(repo, "bin", "amico-run");

if (!fs.existsSync(amicoRun)) {
  console.error("[cli] FAIL: amico-run missing at", amicoRun);
  process.exit(10);
}

// Use an isolated runs root so we don't clobber whatever the user has.
const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "amicode-smoke-cli-"));
console.log(`[cli] runs root: ${runsRoot}`);

const before = Date.now();
const child = cp.spawnSync(
  amicoRun,
  ["--system", "qubit", "--gate", "X", "--pulse", "zero-order", "--max-iter", "50"],
  {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, AMICO_RUNS_ROOT: runsRoot },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 180_000,
  },
);
const elapsed = ((Date.now() - before) / 1000).toFixed(1);

if (child.status !== 0) {
  console.error(`[cli] FAIL: amico-run exited ${child.status} in ${elapsed}s`);
  console.error("[cli] stderr tail:", (child.stderr ?? "").split("\n").slice(-15).join("\n"));
  process.exit(11);
}
console.log(`[cli] OK: amico-run exited 0 in ${elapsed}s`);

const latest = path.join(runsRoot, "latest");
if (!fs.existsSync(latest)) { console.error("[cli] FAIL: latest symlink missing"); process.exit(12); }
const target = fs.realpathSync(latest);
console.log(`[cli] OK: latest → ${target}`);

const want = [".start", "result.toml", "FINISHED"];
for (const f of want) {
  if (!fs.existsSync(path.join(target, f))) {
    console.error(`[cli] FAIL: missing ${f} in ${target}`);
    process.exit(13);
  }
  console.log(`[cli] OK: ${f} present`);
}

const iterPngs = fs.readdirSync(target).filter((f) => /^iter_\d{4}\.png$/.test(f)).sort();
if (iterPngs.length < 2) {
  console.error(`[cli] FAIL: expected >=2 iter PNGs, got ${iterPngs.length}`);
  process.exit(14);
}
console.log(`[cli] OK: ${iterPngs.length} iter PNGs (first=${iterPngs[0]}, last=${iterPngs[iterPngs.length-1]})`);

const result = fs.readFileSync(path.join(target, "result.toml"), "utf8");
const fid = parseFloat((result.match(/fidelity\s*=\s*([\d.eE+-]+)/) ?? [])[1] ?? "");
if (!Number.isFinite(fid) || fid < 0.99) {
  console.error(`[cli] FAIL: fidelity ${fid} below 0.99`);
  process.exit(15);
}
console.log(`[cli] OK: F=${fid.toFixed(6)}`);

// Sanity: last line of stdout should contain DONE summary.
const stdout = child.stdout ?? "";
const doneLine = stdout.split("\n").reverse().find((l) => l.includes("amico-run: DONE"));
if (!doneLine) {
  console.error("[cli] FAIL: no 'amico-run: DONE' in stdout");
  console.error("[cli] stdout tail:", stdout.split("\n").slice(-5).join("\n"));
  process.exit(16);
}
console.log(`[cli] OK: ${doneLine.trim()}`);

console.log("[cli] ALL GREEN");
