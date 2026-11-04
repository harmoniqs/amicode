// Distill-queue health (amicode#2098): a READ-ONLY reader of the extension's queue
// (opencode-plugin/distill_queue.ts documents the on-disk grammar this parses),
// surfaced by `amico vault status --json` (additive `distill` field) and `amico doctor`
// (a `distill_queue` check). Every test seeds a temp ops dir — never the real queue.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDistillHealth, distillQueueCheck } from "../src/distill_health.js";

const BUNDLE = join(__dirname, "..", "dist", "amico.js");
const NOW = 1_800_000_000_000;
const MIN = 60_000;

let ops: string;
let home: string;
beforeEach(() => {
  ops = mkdtempSync(join(tmpdir(), "amico-distill-ops-"));
  home = mkdtempSync(join(tmpdir(), "amico-distill-home-"));
});
afterEach(() => {
  rmSync(ops, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const q = () => join(ops, "distill-queue");
function seed(name: string, body: string = '{"kind":"run"}\n'): void {
  mkdirSync(q(), { recursive: true });
  writeFileSync(join(q(), name), body);
}
function ledger(base: string, over: Record<string, unknown> = {}): void {
  seed(`${base}.attempts`, JSON.stringify({ attempt: 1, last_error: "boom", last_at: NOW - MIN, not_before: NOW + 9 * MIN, ...over }));
}

describe("readDistillHealth (read-only)", () => {
  it("absent ops dir / empty queue → all zero, never throws", () => {
    const zero = { ready: 0, backing_off: 0, retry_due: 0, parked: 0, old_format_failed: 0, oldest_ready_age_s: null };
    expect(readDistillHealth(join(ops, "nope"), NOW)).toEqual(zero);
    mkdirSync(q());
    expect(readDistillHealth(ops, NOW)).toEqual(zero);
  });

  it("counts by the on-disk grammar and reports the age of the oldest READY job", () => {
    seed(`${NOW - 3600_000}-0000-run.json`); // enqueued 1h ago
    seed(`${NOW - 60_000}-0001-run.json`);
    seed("1-0002-run.json.failed-1690000600000"); // legacy: no ledger
    seed("1-0003-run.json.failed-1690000600000");
    seed(`2-0000-run.json.failed-${NOW - MIN}`);
    ledger("2-0000-run.json"); // backing off (not_before in the future)
    seed(`3-0000-run.json.failed-${NOW - 20 * MIN}`);
    ledger("3-0000-run.json", { not_before: NOW - 10 * MIN }); // backoff passed → due
    seed(`4-0000-run.json.parked-${NOW - 5 * MIN}`);
    ledger("4-0000-run.json", { attempt: 4, not_before: 0 });
    seed(`5-0000-run.json.parked-${NOW - 5 * MIN}`);
    expect(readDistillHealth(ops, NOW)).toEqual({
      ready: 2,
      backing_off: 1,
      retry_due: 1,
      parked: 2,
      old_format_failed: 2,
      oldest_ready_age_s: 3600,
    });
  });

  it("includes the most recent halt, and only when the halt file is well-formed", () => {
    writeFileSync(join(ops, "distill-halt.json"), JSON.stringify({ reason: "distill drain halted: 5 consecutive failures", at: NOW - MIN, consecutive: 5, job_ids: ["a"] }));
    expect(readDistillHealth(ops, NOW).halt).toEqual({ reason: "distill drain halted: 5 consecutive failures", at: NOW - MIN, consecutive: 5 });
    writeFileSync(join(ops, "distill-halt.json"), "{garbage");
    expect(readDistillHealth(ops, NOW).halt).toBeUndefined();
  });

  it("malformed input degrades quietly: queue is a file, unreadable ledger = legacy, stray files ignored", () => {
    writeFileSync(join(ops, "distill-queue"), "i am a file");
    expect(readDistillHealth(ops, NOW).ready).toBe(0);
    rmSync(join(ops, "distill-queue"));
    seed("1-0000-run.json.failed-1690000600000");
    seed("1-0000-run.json.attempts", "{not json");
    seed("README.txt");
    seed("weird.json.failed-notanumber");
    expect(readDistillHealth(ops, NOW)).toMatchObject({ ready: 0, old_format_failed: 1, backing_off: 0, parked: 0 });
  });

  it("never mutates the queue", () => {
    seed(`${NOW}-0000-run.json`);
    seed("1-0000-run.json.failed-1690000600000");
    seed(`4-0000-run.json.parked-${NOW}`);
    const snap = () => readdirSync(q()).sort().map((f) => [f, readFileSync(join(q(), f), "utf8")]);
    const before = snap();
    readDistillHealth(ops, NOW);
    expect(snap()).toEqual(before);
    expect(readdirSync(ops)).toEqual(["distill-queue"]);
  });
});

describe("distillQueueCheck (the doctor check)", () => {
  const base = { ready: 0, backing_off: 0, retry_due: 0, parked: 0, old_format_failed: 0, oldest_ready_age_s: null };
  it("ok when nothing is parked or halted — never an error", () => {
    expect(distillQueueCheck({ ...base, ready: 3, backing_off: 2, old_format_failed: 195 })).toMatchObject({ name: "distill_queue", status: "ok" });
  });
  it("warn on parked jobs, naming the fix", () => {
    const c = distillQueueCheck({ ...base, parked: 2 });
    expect(c.status).toBe("warn");
    expect(c.detail).toMatch(/2 parked/);
    expect(c.detail).toMatch(/inspect/i);
  });
  it("warn on a halt, naming the reset", () => {
    const c = distillQueueCheck({ ...base, halt: { reason: "distill drain halted: 5 consecutive failures across different jobs", at: NOW, consecutive: 5 } });
    expect(c.status).toBe("warn");
    expect(c.detail).toMatch(/halted/);
    expect(c.detail).toMatch(/reset/i);
  });
});

describe("surfaced through the built CLI (temp AMICODE_OPS_DIR + temp HOME)", () => {
  beforeAll(() => {
    execFileSync("node", [join(__dirname, "..", "esbuild.config.mjs")], { cwd: join(__dirname, "..") });
  });
  const env = () => ({
    ...process.env,
    HOME: home,
    AMICODE_OPS_DIR: ops,
    AMICO_OPS_ROOT: join(home, "ops"),
    AMICO_VAULTS_ROOT: join(home, "vaults"),
    AMICO_MOUNTS_TOML: join(home, "none.toml"),
    AMICO_VAULT_DIR: "",
  });

  it("vault status --json gains an additive top-level `distill`; the per-mount shape is untouched", () => {
    seed(`${Date.now()}-0000-run.json`);
    seed(`4-0000-run.json.parked-${NOW}`);
    const out = JSON.parse(execFileSync("node", [BUNDLE, "vault", "status", "--json"], { encoding: "utf8", env: env() }));
    expect(Object.keys(out).sort()).toEqual(["distill", "error", "mounts", "ok"]);
    expect(out.distill).toMatchObject({ ready: 1, parked: 1, backing_off: 0, old_format_failed: 0 });
    expect(Array.isArray(out.mounts)).toBe(true);
  });

  it("vault status never throws on an absent queue", () => {
    const out = JSON.parse(execFileSync("node", [BUNDLE, "vault", "status", "--json"], { encoding: "utf8", env: env() }));
    expect(out.distill).toMatchObject({ ready: 0, parked: 0 });
  });

  it("amico doctor carries a distill_queue check: warn when parked, ok otherwise", () => {
    const run = () => spawnSync("node", [BUNDLE, "doctor"], { encoding: "utf8", env: env() });
    const clean = run().stdout.split("\n").find((l) => l.includes("distill_queue"));
    expect(clean).toMatch(/^\s*ok\s+distill_queue/);
    seed(`4-0000-run.json.parked-${NOW}`);
    const dirty = run().stdout.split("\n").find((l) => l.includes("distill_queue"));
    expect(dirty).toMatch(/^\s*warn\s+distill_queue/);
  });
});
