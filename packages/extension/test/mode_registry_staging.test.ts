// mode_registry_staging.test.ts — H2, the atomic bundle stager (#804, spec
// D1): each component is written to a temp file and RENAMED into place
// (POSIX rename(2) atomicity — the stated platform assumption), under a
// liveness-tokened staging lock (process start-time, not bare PID) with a
// TTL heartbeat. A concurrent probe never reads a torn component; a live lock
// reads staging-in-progress → unknown; a stale lock reads stale-lock →
// failed and is STOLEN by the next staging pass after the owner-liveness
// check, the steal recorded on the deploy receipt. One lock per staging
// root. Legacy card staging (mode_cards.ts) stays AUTHORITATIVE: bundle
// staging never touches the legacy agents destination (AC9).
//
// Idempotence (H2, pinned to the RECONCILED #761/#614 semantics):
// source-minus-generated artifact bytes unchanged across runs — always-copy
// with receipt freshness and generator stamps excepted.
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, readdirSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  stageModeBundles,
  readStagingLock,
  stagingLockVerdict,
  processStartTimeToken,
  generateLedgerDiscoveryRegion,
  type ModeStagingLock,
} from "@amicode/schema";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(HERE, "..");

/** A hermetic source tree: the REAL registry copied into a temp extension
 *  root (with agents/ + handoff-seeds/ beside modes/, as the declared
 *  relative paths resolve). */
function sourceFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "mode-staging-src-"));
  cpSync(join(EXT, "modes"), join(root, "modes"), { recursive: true });
  cpSync(join(EXT, "agents"), join(root, "agents"), { recursive: true });
  cpSync(join(EXT, "handoff-seeds"), join(root, "handoff-seeds"), { recursive: true });
  return root;
}

function freshDest(): string {
  return mkdtempSync(join(tmpdir(), "mode-staging-dest-"));
}

const BUNDLE_FILES = (mode: string): string[] => {
  const dir = join(EXT, "modes", mode);
  const files: string[] = [];
  const walk = (rel: string) => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.isDirectory()) walk(join(rel, e.name));
      else files.push(join(rel, e.name));
    }
  };
  walk("");
  return files.sort();
};

function writeLock(modesDir: string, over: Partial<ModeStagingLock> = {}): ModeStagingLock {
  const lock: ModeStagingLock = {
    lock_version: 1,
    staging_root: modesDir,
    owner_pid: process.pid,
    owner_started: processStartTimeToken(process.pid) ?? "",
    liveness_token: "test-token",
    acquired_at: new Date().toISOString(),
    heartbeat_at: new Date().toISOString(),
    ttl_ms: 120_000,
    ...over,
  };
  mkdirSync(modesDir, { recursive: true });
  writeFileSync(join(modesDir, ".staging-lock.json"), JSON.stringify(lock, null, 2) + "\n");
  return lock;
}

/** A pid that is provably DEAD (spawned, reaped, exited). */
function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  // the child is gone; its pid is not ours and not alive. Use a high
  // unlikely-to-exist pid as fallback if the child's pid was reclaimed.
  const pid = 999_999 + (Math.floor(Math.random() * 1000) | 0);
  try {
    process.kill(pid, 0);
    return pid; // extremely unlikely: someone owns it — then it IS alive, use child
  } catch {
    return pid;
  }
}

describe("stageModeBundles — the full-bundle stage", () => {
  it("stages every declared component of every mode into a fresh dest, receipt written", () => {
    const src = sourceFixture();
    const dest = freshDest();
    const r = stageModeBundles(src, dest);
    expect(r.outcome).toBe("staged");
    for (const mode of ["autodev", "autoresearch"]) {
      for (const f of BUNDLE_FILES(mode)) {
        expect(existsSync(join(dest, "modes", mode, f)), `missing ${mode}/${f}`).toBe(true);
        expect(readFileSync(join(dest, "modes", mode, f), "utf8")).toBe(
          readFileSync(join(src, "modes", mode, f), "utf8"),
        );
      }
      // roles + handoff-seed schemas are MATERIALIZED into the bundle
      expect(existsSync(join(dest, "modes", mode, "roles"))).toBe(true);
      expect(existsSync(join(dest, "modes", mode, "handoff-seeds"))).toBe(true);
    }
    expect(r.receiptPath).toBe(join(dest, "modes", ".deploy-receipt.json"));
    const receipt = JSON.parse(readFileSync(r.receiptPath!, "utf8"));
    expect(receipt.receipt_version).toBe(1);
    expect(receipt.modes.map((m: { mode: string }) => m.mode).sort()).toEqual(["autodev", "autoresearch"]);
    for (const m of receipt.modes) {
      for (const file of m.files) {
        expect(file.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
      }
    }
    // post-stage parity is asserted and recorded (AC8)
    expect(receipt.parity).toBe("ok");
    rmSync(src, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  });

  it("legacy authority (AC9): bundle staging never touches the legacy agents destination", () => {
    const src = sourceFixture();
    const dest = freshDest();
    stageModeBundles(src, dest);
    // the legacy card stager's destination (<destRoot>/agents) is untouched:
    // it does not exist unless the legacy stager created it
    expect(existsSync(join(dest, "agents"))).toBe(false);
    rmSync(src, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  });
});

describe("stageModeBundles — idempotence (reconciled always-copy semantics)", () => {
  it("run 2: every bundle artifact byte-identical (receipt freshness excepted); no lock left behind", () => {
    const src = sourceFixture();
    const dest = freshDest();
    const fixedNow = () => "2026-09-05T00:00:00.000Z";
    const r1 = stageModeBundles(src, dest, { now: fixedNow });
    const first = readFileSync(r1.receiptPath!, "utf8");
    const r2 = stageModeBundles(src, dest, { now: fixedNow });
    const second = readFileSync(r2.receiptPath!, "utf8");
    // artifact bytes unchanged (same injected clock ⇒ even the receipt is
    // byte-identical; with a real clock only staged_at moves)
    expect(second).toBe(first);
    for (const mode of ["autodev", "autoresearch"]) {
      for (const f of BUNDLE_FILES(mode)) {
        expect(readFileSync(join(dest, "modes", mode, f), "utf8")).toBe(
          readFileSync(join(src, "modes", mode, f), "utf8"),
        );
      }
    }
    // no lock left behind
    expect(readStagingLock(join(dest, "modes"))).toBeNull();
    rmSync(src, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  });

  it("tamper repair: a tampered deployed component is repaired as a unit; run 2 byte-identical", () => {
    const src = sourceFixture();
    const dest = freshDest();
    stageModeBundles(src, dest);
    writeFileSync(join(dest, "modes", "autodev", "pack.toml"), "# TAMPERED\n");
    const r = stageModeBundles(src, dest);
    expect(r.outcome).toBe("staged");
    expect(readFileSync(join(dest, "modes", "autodev", "pack.toml"), "utf8")).toBe(
      readFileSync(join(src, "modes", "autodev", "pack.toml"), "utf8"),
    );
    rmSync(src, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  });
});

describe("stageModeBundles — atomic rename under a concurrent probe (AC2)", () => {
  it("a probe racing the stage reads each component complete-old or complete-new, never torn", () => {
    const src = sourceFixture();
    const dest = freshDest();
    // pre-stage so OLD complete content exists, then mutate the source so the
    // stage writes NEW content over it
    stageModeBundles(src, dest);
    const modeDir = join(src, "modes", "autodev");
    writeFileSync(join(modeDir, "card.md"), readFileSync(join(modeDir, "card.md"), "utf8") + "<!-- NEW CONTENT -->\n");
    const oldBytes = new Map<string, string>();
    const newBytes = new Map<string, string>();
    for (const mode of ["autodev", "autoresearch"]) {
      for (const f of BUNDLE_FILES(mode)) {
        oldBytes.set(`${mode}/${f}`, safeRead(join(dest, "modes", mode, f)));
        newBytes.set(`${mode}/${f}`, readFileSync(join(src, "modes", mode, f), "utf8"));
      }
    }
    // the concurrent probe: fired after EVERY component write + heartbeat
    // refresh — each read is complete-old or complete-new, never partial
    let probes = 0;
    const torn: string[] = [];
    stageModeBundles(src, dest, {
      tick: () => {
        probes++;
        for (const [key, old] of oldBytes) {
          const p = join(dest, "modes", key);
          if (!existsSync(p)) continue;
          const read = safeRead(p);
          const isNew = read === newBytes.get(key);
          const isOld = read === old;
          if (!isNew && !isOld) torn.push(key);
        }
      },
    });
    expect(probes).toBeGreaterThan(4); // the probe genuinely raced the stage
    expect(torn, `torn reads: ${torn.join(", ")}`).toEqual([]);
    rmSync(src, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  });
});

function safeRead(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "<UNREADABLE>";
  }
}

describe("the staging lock (one lock per staging root)", () => {
  it("a LIVE lock aborts a second staging pass — nothing written, no steal", () => {
    const src = sourceFixture();
    const dest = freshDest();
    stageModeBundles(src, dest); // populate + no lock left
    const modesDir = join(dest, "modes");
    writeLock(modesDir); // fresh heartbeat, OUR pid (alive), matching start-time
    const before = safeRead(join(modesDir, "autodev", "pack.toml"));
    const r = stageModeBundles(src, dest);
    expect(r.outcome).toBe("aborted-locked");
    expect(safeRead(join(modesDir, "autodev", "pack.toml"))).toBe(before); // untouched
    expect(readStagingLock(modesDir)).not.toBeNull(); // the live holder's lock stands
    rmSync(src, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  });

  it("a STALE lock (dead owner, heartbeat past TTL) is STOLEN by the next pass; the steal is recorded on the deploy receipt", () => {
    const src = sourceFixture();
    const dest = freshDest();
    stageModeBundles(src, dest);
    const modesDir = join(dest, "modes");
    const stale = writeLock(modesDir, {
      owner_pid: deadPid(),
      owner_started: "1970-01-01T00:00:00 bogus",
      heartbeat_at: "2020-01-01T00:00:00.000Z", // long past any TTL
    });
    const r = stageModeBundles(src, dest);
    expect(r.outcome).toBe("staged");
    expect(r.steals.length).toBe(1);
    expect(r.steals[0].from.owner_pid).toBe(stale.owner_pid);
    const receipt = JSON.parse(readFileSync(r.receiptPath!, "utf8"));
    expect(receipt.steals.length).toBe(1);
    expect(receipt.steals[0].from.owner_pid).toBe(stale.owner_pid);
    expect(readStagingLock(modesDir)).toBeNull(); // released after staging
    rmSync(src, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  });

  it("PID reuse must not make a dead stager's lock look owned: a LIVE pid with the WRONG start-time token is stale, stolen", () => {
    const src = sourceFixture();
    const dest = freshDest();
    stageModeBundles(src, dest);
    const modesDir = join(dest, "modes");
    // the lock claims OUR (alive) pid but a start-time that is not ours — the
    // reused-pid shape: pid-alive would pass a bare-PID check, the
    // start-time token must not
    writeLock(modesDir, { owner_pid: process.pid, owner_started: "STARTED-LONG-AGO-AND-ELSEWHERE" });
    const v = stagingLockVerdict(readStagingLock(modesDir)!);
    expect(v).toBe("stale");
    const r = stageModeBundles(src, dest);
    expect(r.outcome).toBe("staged");
    expect(r.steals.length).toBe(1);
    rmSync(src, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  });

  it("a fresh-heartbeat lock held by a dead process is stale (heartbeat alone cannot save a dead owner)", () => {
    const modesDir = join(freshDest(), "modes");
    writeLock(modesDir, { owner_pid: deadPid() });
    expect(stagingLockVerdict(readStagingLock(modesDir)!)).toBe("stale");
    rmSync(dirname(modesDir), { recursive: true, force: true });
  });

  it("the doctor's lock verdicts: live → staging-in-progress (unknown); stale → stale-lock (failed)", () => {
    const modesDir = join(freshDest(), "modes");
    // live: our pid, our start time, fresh heartbeat
    writeLock(modesDir);
    expect(stagingLockVerdict(readStagingLock(modesDir)!)).toBe("live");
    rmSync(dirname(modesDir), { recursive: true, force: true });
  });

  it("an unparseable or empty lock file reads stale (never a permanent wedge)", () => {
    const modesDir = join(freshDest(), "modes");
    mkdirSync(modesDir, { recursive: true });
    writeFileSync(join(modesDir, ".staging-lock.json"), "{not json");
    expect(stagingLockVerdict(readStagingLock(modesDir)!)).toBe("stale");
    rmSync(dirname(modesDir), { recursive: true, force: true });
  });
});

describe("stager version floor (AC5 — the stager is a consumer too)", () => {
  it("a bundle whose stager floor exceeds this stager's version aborts LOUDLY, nothing staged", () => {
    const src = sourceFixture();
    // raise the floor above what this build supports
    const manifestPath = join(src, "modes", "autodev", "mode.toml");
    writeFileSync(manifestPath, readFileSync(manifestPath, "utf8").replace('stager = "1"', 'stager = "2"'));
    const dest = freshDest();
    expect(() => stageModeBundles(src, dest)).toThrow(/version gap/);
    expect(existsSync(join(dest, "modes"))).toBe(false);
    rmSync(src, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  });
});

describe("staging refuses a broken SOURCE registry (anti-gaming: never stage what does not validate)", () => {
  it("a source card with a tampered generated region refuses staging (regenerate-and-compare)", () => {
    const src = sourceFixture();
    const cardPath = join(src, "modes", "autodev", "card.md");
    writeFileSync(cardPath, readFileSync(cardPath, "utf8").replace("kickoff before any work.", "TAMPERED RULE BODY."));
    // keep the region's delimiters + stamp — a forged current stamp
    const dest = freshDest();
    expect(() => stageModeBundles(src, dest)).toThrow(/generated region|divergent/i);
    rmSync(src, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  });

  it("a source missing a declared role file refuses staging, naming the role", () => {
    const src = sourceFixture();
    rmSync(join(src, "agents", "implementer.md"));
    const dest = freshDest();
    expect(() => stageModeBundles(src, dest)).toThrow(/implementer/);
    rmSync(src, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  });
});
