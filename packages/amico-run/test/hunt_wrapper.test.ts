// ops/hunt.sh — the hardened hunt wrapper (#426), exercised end to end through a stub
// `amico`. The wrapper's contract is the retirement of the raw-nohup pattern:
//
//   ssh <host> 'cd ~/qldpc-challenge && nohup uv run python -u research/candidates/<hunt>.py > /tmp/<hunt>.log 2>&1 &'
//
// Every piece of that pattern had a failure mode: no timeout (wedged hangs forever), no
// heartbeat (a silent wrapper is indistinguishable from a dead one), logs in /tmp (lost
// on reboot), status by ps-grep (no record, no adoption). The tests below pin each
// replacement behavior:
//   1. RECORD LIFECYCLE — `fleet launch` before the command runs (the wrapper's own pid
//      as holder), `fleet finish settled|crashed` after, SAME pid on both calls.
//   2. BOUNDED — a command that overruns its --timeout is killed and finished crashed.
//   3. DURABLE LOGS + HEARTBEAT under the hunts dir, never /tmp.
//   4. UNIQUE PER RUN — re-running a hunt id gets a fresh session, never a clobber.
//
// The stub stands in for the CLI so this suite tests the WRAPPER; the real verbs it
// calls are covered in fleet_verb.test.ts.
// Run: pnpm --filter @amicode/amico-run test hunt_wrapper
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..", "..", "..");
const HUNT = join(REPO, "ops", "hunt.sh");

let work: string; // holds both the hunts dir and the stub's call log
let hunts: string;
let calls: string;
let stub: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "hunt-wrap-"));
  hunts = join(work, "hunts");
  calls = join(work, "amico-calls.log");
  stub = join(work, "amico-stub.sh");
  writeFileSync(stub, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(calls)}\nexit 0\n`);
  chmodSync(stub, 0o755);
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

function runHunt(args: string[], opts: { timeout?: number } = {}): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("bash", [HUNT, ...args], {
    encoding: "utf8",
    timeout: opts.timeout ?? 30_000,
    env: { ...process.env, AMICO_CALLS: calls },
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function amicoCalls(): string[] {
  return existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter((l) => l.trim() !== "") : [];
}

function pidFrom(line: string): string {
  const m = /--pid (\d+)/.exec(line);
  expect(m, `no --pid in: ${line}`).not.toBeNull();
  return m![1];
}

describe("ops/hunt.sh — record lifecycle", () => {
  it("launches BEFORE the command runs and finishes settled after a clean exit, same holder pid on both", () => {
    const r = runHunt(["--id", "e2e", "--amico", stub, "--hunts-dir", hunts, "--", "true"]);
    expect(r.code).toBe(0);
    const lines = amicoCalls();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^fleet launch --session hunt-e2e --pid \d+$/);
    expect(lines[1]).toMatch(/^fleet finish --session hunt-e2e --outcome settled --pid \d+ --step exit=0$/);
    expect(pidFrom(lines[0])).toBe(pidFrom(lines[1]));
  });

  it("a nonzero exit finishes CRASHED with the exit code stamped in --step, and the wrapper exits with the same code", () => {
    const r = runHunt(["--id", "e2e", "--amico", stub, "--hunts-dir", hunts, "--", "sh", "-c", "exit 3"]);
    expect(r.code).toBe(3);
    const lines = amicoCalls();
    expect(lines[1]).toMatch(/--outcome crashed --pid \d+ --step exit=3$/);
    expect(pidFrom(lines[0])).toBe(pidFrom(lines[1]));
  });

  it("a missing command, an invalid --id, or a failing `fleet launch` aborts BEFORE anything runs", () => {
    const noCmd = runHunt(["--id", "e2e", "--amico", stub, "--hunts-dir", hunts, "--"]);
    expect(noCmd.code).not.toBe(0);
    expect(amicoCalls()).toEqual([]);

    const badId = runHunt(["--id", "bad/id", "--amico", stub, "--hunts-dir", hunts, "--", "true"]);
    expect(badId.code).not.toBe(0);
    expect(amicoCalls()).toEqual([]);

    // A CLI that cannot create the record (exit 64) must stop the hunt, not run untracked.
    const failing = join(work, "amico-fail.sh");
    writeFileSync(failing, "#!/usr/bin/env bash\nexit 64\n");
    chmodSync(failing, 0o755);
    const refused = runHunt(["--id", "e2e", "--amico", failing, "--hunts-dir", hunts, "--", "true"]);
    expect(refused.code).not.toBe(0);
    expect(existsSync(join(hunts, "e2e", "hunt.log"))).toBe(true); // the refusal is IN the durable log
  });
});

describe("ops/hunt.sh — bounded by --timeout", () => {
  it("kills an overrunning command and finishes crashed", () => {
    const t0 = Date.now();
    const r = runHunt(["--id", "slow", "--amico", stub, "--hunts-dir", hunts, "--timeout", "1s", "--", "sleep", "30"], { timeout: 25_000 });
    const elapsed = (Date.now() - t0) / 1000;
    expect(r.code).not.toBe(0);
    expect(elapsed).toBeLessThan(15); // 30 s sleep, bounded at ~1 s + grace
    const lines = amicoCalls();
    expect(lines[1]).toMatch(/--outcome crashed --pid \d+ --step (exit=\d+|signal .+)$/);
  }, 30_000);
});

describe("ops/hunt.sh — durable artifacts", () => {
  it("captures the command's stdout/stderr in the hunt log and ticks a heartbeat under the hunts dir", () => {
    const r = runHunt(["--id", "loggy", "--amico", stub, "--hunts-dir", hunts, "--", "sh", "-c", "echo hunt-output-line; echo err-line 1>&2"]);
    expect(r.code).toBe(0);
    const dir = join(hunts, "loggy");
    const log = readFileSync(join(dir, "hunt.log"), "utf8");
    expect(log).toContain("hunt-output-line");
    expect(log).toContain("err-line");
    const hb = join(dir, "heartbeat");
    expect(existsSync(hb)).toBe(true);
    expect(Date.now() - statSync(hb).mtimeMs).toBeLessThan(10_000);
  });
});

describe("ops/hunt.sh — one session per run", () => {
  it("re-running the same --id gets a uniquified session and dir, never a clobbered record", () => {
    expect(runHunt(["--id", "again", "--amico", stub, "--hunts-dir", hunts, "--", "true"]).code).toBe(0);
    expect(runHunt(["--id", "again", "--amico", stub, "--hunts-dir", hunts, "--", "true"]).code).toBe(0);
    const lines = amicoCalls();
    const sessions = lines.map((l) => /--session (\S+)/.exec(l)![1]);
    expect(new Set(sessions).size).toBe(2);
    expect(sessions[0]).toBe("hunt-again");
    expect(sessions[2]).toBe("hunt-again-2");
    expect(existsSync(join(hunts, "again"))).toBe(true);
    expect(existsSync(join(hunts, "again-2"))).toBe(true);
  });
});

describe("ops/hunt.sh --bg — detached dispatch", () => {
  it("returns immediately and the detached hunt finishes its own record", () => {
    const t0 = Date.now();
    const r = runHunt(["--id", "bgd", "--amico", stub, "--hunts-dir", hunts, "--bg", "--", "sh", "-c", "sleep 0.4"], { timeout: 15_000 });
    expect(r.code).toBe(0);
    expect((Date.now() - t0) / 1000).toBeLessThan(5); // the parent does not wait for the command
    // the detached child completes on its own; poll for its finish line
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const lines = amicoCalls();
      if (lines.length >= 2) {
        expect(lines[1]).toMatch(/fleet finish --session hunt-bgd --outcome settled --pid \d+ --step exit=0/);
        return;
      }
      execFileSync("sleep", ["0.2"]);
    }
    throw new Error(`detached hunt never finished its record; calls: ${JSON.stringify(amicoCalls())}`);
  }, 30_000);
});
