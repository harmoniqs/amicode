// The ops wrapper `ops/shard-watch/run-shard-watch.sh` — hermetic contract tests.
//
// The wrapper is THIN PLUMBING around the `amico fleet shard-watch` verb: it resolves the
// bin (env-driven, never a hardcoded host), forwards --dry-run, appends ONE receipt line
// to the receipts journal on real runs, touches NOTHING on dry-run, and relays the check's
// exit code (divergence → nonzero). Every test here drives the wrapper against a STUB bin
// — no ssh, no sqlite, no amico-slack — the same hermetic shape as the skill-freshness /
// role-parity orchestrator tests. The verb's own behavior is covered by shard_watch.test.ts.
//
// Run: pnpm --filter @amicode/amico-run test shard_watch_wrapper
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WRAPPER = join(__dirname, "..", "..", "..", "ops", "shard-watch", "run-shard-watch.sh");

const RECEIPT_LINE = JSON.stringify({
  receipt_version: 1,
  ts: "2026-09-20T04:15:00.000Z",
  kind: "shard-watch",
  verdict: "clean",
  clients: [],
});

function makeStub(exitCode: number, stdout = RECEIPT_LINE + "\n"): string {
  const dir = mkdtempSync(join(tmpdir(), "shard-watch-stub-"));
  const bin = join(dir, "stub-amico.mjs");
  writeFileSync(
    bin,
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(stdout)});\nprocess.exit(${exitCode});\n`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

describe("run-shard-watch.sh — the nightly wrapper contract (stub bin, no network)", () => {
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "shard-watch-wrap-"));
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  function run(args: string[], stub: string, exit: number): { code: number; stdout: string; stderr: string } {
    const receipts = join(tmp, `receipts-${exit}-${args.length > 0 ? "dry" : "real"}.jsonl`);
    const r = spawnSync("bash", [WRAPPER, ...args], {
      encoding: "utf8",
      env: { ...process.env, SHARD_WATCH_BIN: stub, SHARD_WATCH_RECEIPTS: receipts, PATH: process.env.PATH },
    });
    return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  it("--help prints usage and exits 0", () => {
    const stub = makeStub(0);
    const r = run(["--help"], stub, 0);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/usage/i);
  });

  it("an unknown argument is a usage error (exit 2), never a silently ignored flag", () => {
    const stub = makeStub(0);
    const r = run(["--verbose"], stub, 0);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/unknown argument/);
  });

  it("a real run appends exactly ONE receipt line (the bin's stdout JSON) and relays the exit code", () => {
    const stub = makeStub(0);
    const receipts = join(tmp, "receipts-real.jsonl");
    const r = spawnSync("bash", [WRAPPER], {
      encoding: "utf8",
      env: { ...process.env, SHARD_WATCH_BIN: stub, SHARD_WATCH_RECEIPTS: receipts },
    });
    expect(r.status).toBe(0);
    expect(existsSync(receipts)).toBe(true);
    const lines = readFileSync(receipts, "utf8").trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ receipt_version: 1, kind: "shard-watch", verdict: "clean" });
  });

  it("dry-run performs only reads: NO receipt is appended, WOULD-DO goes to stderr, exit still relays", () => {
    const stub = makeStub(0);
    const receipts = join(tmp, "receipts-dry.jsonl");
    const r = spawnSync("bash", [WRAPPER, "--dry-run"], {
      encoding: "utf8",
      env: { ...process.env, SHARD_WATCH_BIN: stub, SHARD_WATCH_RECEIPTS: receipts },
    });
    expect(r.status).toBe(0);
    expect(existsSync(receipts)).toBe(false);
    expect(r.stderr).toMatch(/WOULD-DO/);
  });

  it("dry-run still relays a divergence exit — refraining from writes never launders a verdict", () => {
    const stub = makeStub(1, JSON.stringify({ kind: "shard-watch", verdict: "divergent" }) + "\n");
    const r = run(["--dry-run"], stub, 1);
    expect(r.code).toBe(1);
  });

  it("a divergent real run relays the nonzero exit AND still appends the receipt", () => {
    const stub = makeStub(1, JSON.stringify({ kind: "shard-watch", verdict: "divergent", clients: [] }) + "\n");
    const receipts = join(tmp, "receipts-divergent.jsonl");
    const r = spawnSync("bash", [WRAPPER], {
      encoding: "utf8",
      env: { ...process.env, SHARD_WATCH_BIN: stub, SHARD_WATCH_RECEIPTS: receipts },
    });
    expect(r.status).toBe(1);
    expect(existsSync(receipts)).toBe(true);
  });

  it("a bin that dies without producing a receipt line appends nothing (never a malformed journal line)", () => {
    const stub = makeStub(2, "");
    const receipts = join(tmp, "receipts-empty.jsonl");
    const r = spawnSync("bash", [WRAPPER], {
      encoding: "utf8",
      env: { ...process.env, SHARD_WATCH_BIN: stub, SHARD_WATCH_RECEIPTS: receipts },
    });
    expect(r.status).toBe(2);
    expect(existsSync(receipts)).toBe(false);
  });

  it("a missing bin is a pre-flight failure (exit 2), not a silent pass", () => {
    const receipts = join(tmp, "receipts-nobin.jsonl");
    const r = spawnSync("bash", [WRAPPER], {
      encoding: "utf8",
      env: { ...process.env, SHARD_WATCH_BIN: join(tmp, "no-such-bin"), SHARD_WATCH_RECEIPTS: receipts },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/not found|FATAL/i);
    expect(existsSync(receipts)).toBe(false);
  });
});
