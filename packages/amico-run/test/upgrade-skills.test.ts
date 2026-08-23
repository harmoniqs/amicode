// upgrade-skills.test.ts — the `amico upgrade skills` verb (#526, spec D2) plus
// the SHARED verb plumbing it exercises first: pre-flight doctor gate
// (current → no-op; unknown → aborted-unknown; stale → proceed), the
// single-operator lock (flock semantics via O_EXCL + PID liveness steal), and
// the append-only JSONL receipts. Fully hermetic — every run injects temp
// roots via the flags mirroring doctor's, the real ~/.amico is never touched.
import { describe, test, expect } from "vitest";
import { readFileSync, writeFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { surfaceInventory, dirDigest, type SurfaceRecord } from "../src/surfaces.js";
import { upgradeVerb, acquireUpgradeLock } from "../src/upgrade.js";
import {
  buildDoctorWorld,
  ctxForWorld,
  cleanupTracked,
  trackTmp,
  fakeBin,
  FUTURE_BUILD,
  type DoctorWorld,
} from "./helpers.js";

const cleanup = cleanupTracked;

// ── harness ──────────────────────────────────────────────────────────────────

/** All seven root flags the verbs mirror from doctor — the probe context is
 *  always fully injected, never the developer's real machine. */
function verbArgs(w: DoctorWorld, surface: string, extra: string[] = []): string[] {
  return [
    surface,
    "--root-server", w.server,
    "--root-vscext", w.vscext,
    "--root-config", w.config,
    "--root-repo-amicode", w.repoAmicode,
    "--root-repo-fork", w.repoFork,
    "--root-staging", w.staging,
    ...extra,
  ];
}

interface ReceiptLine {
  receipt_version: number;
  verb: string;
  timestamp: string;
  outcome: string;
  pre: SurfaceRecord[] | null;
  post: SurfaceRecord[] | null;
  source_digests: Record<string, unknown>;
  verification: boolean | string | null;
  detail?: string[];
}

function readReceipts(rootReceipts: string): ReceiptLine[] {
  const p = join(rootReceipts, "upgrade-receipts.jsonl");
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as ReceiptLine);
}

const lastReceipt = (rootReceipts: string): ReceiptLine => {
  const all = readReceipts(rootReceipts);
  expect(all.length).toBeGreaterThan(0);
  return all[all.length - 1];
};

const bySurface = (records: SurfaceRecord[], name: string): SurfaceRecord =>
  records.find((r) => r.surface === name)!;

function receiptsDir(w: DoctorWorld): string {
  // default receipts root derives from the injected --root-server (hermetic
  // by construction); tests use it explicitly for readability
  return join(w.server, "upgrade-receipts");
}

// ── the skills verb (the simplest full verb — exercises the shared plumbing) ─

describe("upgrade skills — stale staged set", () => {
  test("tampered staged skill → upgraded: receipt complete, JSONL appended, staged set converged", async () => {
    const w = buildDoctorWorld();
    // stage stale: tamper one staged skill's bytes (digest drift)
    writeFileSync(join(w.staging, "skills", "beta", "SKILL.md"), "# beta\nDRIFTED\n");

    const r = await upgradeVerb(verbArgs(w, "skills", ["--root-receipts", receiptsDir(w)]));
    expect(r.code).toBe(0);
    const receipt = r.json as ReceiptLine;
    expect(receipt.outcome).toBe("upgraded");
    expect(receipt.verb).toBe("skills");
    expect(receipt.verification).toBe(true);
    expect(receipt.receipt_version).toBe(1);
    expect(receipt.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // pre/post surface records: pre stale, post current — both in the receipt
    expect(receipt.pre).not.toBeNull();
    expect(bySurface(receipt.pre!, "staged-skills").verdict).toBe("stale");
    expect(receipt.post).not.toBeNull();
    expect(bySurface(receipt.post!, "staged-skills").verdict).toBe("current");

    // source digests present (the VSIX set + staged set identities)
    expect(receipt.source_digests.vsix_set).toMatch(/^sha256:/);
    expect(receipt.source_digests.staged_before).toMatch(/^sha256:/);
    expect(receipt.source_digests.staged_after).toMatch(/^sha256:/);

    // the JSONL store carries the same receipt, appended
    expect(lastReceipt(receiptsDir(w)).outcome).toBe("upgraded");

    // the staged set ACTUALLY converged (byte-match restored)
    const post = await surfaceInventory(ctxForWorld(w));
    expect(bySurface(post.surfaces, "staged-skills").verdict).toBe("current");
    cleanup();
  });

  test("verification independence: receipt.post equals an independent doctor re-run, field for field", async () => {
    const w = buildDoctorWorld();
    writeFileSync(join(w.staging, "skills", "alpha", "SKILL.md"), "# alpha\nDRIFTED\n");
    await upgradeVerb(verbArgs(w, "skills", ["--root-receipts", receiptsDir(w)]));
    const receipt = lastReceipt(receiptsDir(w));
    const independent = await surfaceInventory(ctxForWorld(w));
    expect(receipt.post).toEqual([
      bySurface(independent.surfaces, "staged-skills"),
    ]);
    cleanup();
  });

  test("missing staged skill → recreated by the re-stage", async () => {
    const w = buildDoctorWorld();
    rmSync(join(w.staging, "skills", "beta"), { recursive: true, force: true });
    const r = await upgradeVerb(verbArgs(w, "skills", ["--root-receipts", receiptsDir(w)]));
    expect(r.code).toBe(0);
    expect((r.json as ReceiptLine).outcome).toBe("upgraded");
    expect(existsSync(join(w.staging, "skills", "beta", "SKILL.md"))).toBe(true);
    cleanup();
  });
});

describe("upgrade skills — idempotence (the AC fixture: stale → upgraded → no-op)", () => {
  test("run 2 on a converged surface: exit 0, outcome no-op, staged dir digests byte-unchanged", async () => {
    const w = buildDoctorWorld();
    writeFileSync(join(w.staging, "skills", "beta", "SKILL.md"), "# beta\nDRIFTED\n");
    const args = verbArgs(w, "skills", ["--root-receipts", receiptsDir(w)]);

    const run1 = await upgradeVerb(args);
    expect(run1.code).toBe(0);
    expect((run1.json as ReceiptLine).outcome).toBe("upgraded");

    // harness digest of the ENUMERATED destination set: the staged skills dir
    const after1 = await dirDigest(join(w.staging, "skills"));

    const run2 = await upgradeVerb(args);
    expect(run2.code).toBe(0);
    const receipt2 = run2.json as ReceiptLine;
    expect(receipt2.outcome).toBe("no-op");
    expect(receipt2.verification).toBe(true);
    expect(receipt2.pre).not.toBeNull();
    expect(bySurface(receipt2.pre!, "staged-skills").verdict).toBe("current");

    // receipt store excluded from destination digests by definition; the
    // staged set itself is byte-unchanged
    const after2 = await dirDigest(join(w.staging, "skills"));
    expect(after2).toBe(after1);
    expect(lastReceipt(receiptsDir(w)).outcome).toBe("no-op");
    cleanup();
  });
});

describe("upgrade skills — pre-flight gates", () => {
  test("already-current surface → no-op WITHOUT executing (staged dir untouched)", async () => {
    const w = buildDoctorWorld();
    const before = await dirDigest(join(w.staging, "skills"));
    const r = await upgradeVerb(verbArgs(w, "skills", ["--root-receipts", receiptsDir(w)]));
    expect(r.code).toBe(0);
    const receipt = r.json as ReceiptLine;
    expect(receipt.outcome).toBe("no-op");
    expect(await dirDigest(join(w.staging, "skills"))).toBe(before);
    cleanup();
  });

  test("unknown source (no VSIX skills set) → aborted-unknown, exit 1, receipt recorded", async () => {
    const w = buildDoctorWorld();
    rmSync(w.vscext, { recursive: true, force: true });
    const before = await dirDigest(join(w.staging, "skills"));
    const r = await upgradeVerb(verbArgs(w, "skills", ["--root-receipts", receiptsDir(w)]));
    expect(r.code).toBe(1);
    const receipt = r.json as ReceiptLine;
    expect(receipt.outcome).toBe("aborted-unknown");
    expect(receipt.verification).toBeNull();
    expect(receipt.post).toBeNull();
    expect(lastReceipt(receiptsDir(w)).outcome).toBe("aborted-unknown");
    expect(await dirDigest(join(w.staging, "skills"))).toBe(before); // nothing executed
    cleanup();
  });

  test("internal-only staged skills (extras) are PRESERVED: no byte change, honest no-op, post records the drift", async () => {
    // the live staged set deliberately carries internal-only skills the VSIX
    // never ships (stage-internal-skills.sh) — the verb re-stages the VSIX
    // set without deleting them (the server script's no-delete re-stage).
    // Doctor flags extras as drift; the verb converges the SHAREABLE set and
    // reports the residual honestly instead of deleting fleet skills.
    const w = buildDoctorWorld();
    mkdirSync(join(w.staging, "skills", "fleet"), { recursive: true });
    writeFileSync(join(w.staging, "skills", "fleet", "SKILL.md"), "# fleet\ninternal-only\n");
    const before = await dirDigest(join(w.staging, "skills"));

    const r = await upgradeVerb(verbArgs(w, "skills", ["--root-receipts", receiptsDir(w)]));
    expect(r.code).toBe(0);
    const receipt = r.json as ReceiptLine;
    expect(receipt.outcome).toBe("no-op"); // the re-stage changed nothing: VSIX set already converged
    expect(existsSync(join(w.staging, "skills", "fleet"))).toBe(true); // preserved, never deleted
    expect(await dirDigest(join(w.staging, "skills"))).toBe(before);
    // the post record does not lie: doctor still sees the extra as drift
    expect(bySurface(receipt.post!, "staged-skills").verdict).toBe("stale");
    expect(bySurface(receipt.post!, "staged-skills").evidence.join(" ")).toMatch(/extra in staged set/);
    cleanup();
  });
});

// ── the shared lock (flock semantics: crash-release via PID liveness) ───────

describe("upgrade lock — single operator", () => {
  test("a held lock → aborted-locked, exit 1, no execution", async () => {
    const w = buildDoctorWorld();
    const rr = receiptsDir(w);
    const lock = await acquireUpgradeLock(rr);
    expect(lock.acquired).toBe(true);
    try {
      const r = await upgradeVerb(verbArgs(w, "skills", ["--root-receipts", rr]));
      expect(r.code).toBe(1);
      const receipt = r.json as ReceiptLine;
      expect(receipt.outcome).toBe("aborted-locked");
      expect(receipt.pre).toBeNull(); // refused before even probing
      expect(lastReceipt(rr).outcome).toBe("aborted-locked");
    } finally {
      await lock.release();
    }
    // after release the same verb proceeds normally
    const r2 = await upgradeVerb(verbArgs(w, "skills", ["--root-receipts", rr]));
    expect((r2.json as ReceiptLine).outcome).toBe("no-op");
    cleanup();
  });

  test("a stale lock (dead holder) is stolen — crash-release is free", async () => {
    const w = buildDoctorWorld();
    const rr = receiptsDir(w);
    // a holder that died: spawn a process, let it exit, forge its lockfile
    const dead = execFileSync("sh", ["-c", "echo $$; exit 0"], { encoding: "utf8" }).trim();
    mkdirSync(rr, { recursive: true });
    const { writeFileSync: wf } = await import("node:fs");
    wf(join(rr, ".lock"), `${dead}\n`);
    const r = await upgradeVerb(verbArgs(w, "skills", ["--root-receipts", rr]));
    expect(r.code).toBe(0);
    expect((r.json as ReceiptLine).outcome).toBe("no-op"); // proceeded past the stolen lock
    cleanup();
  });
});

// ── usage surface ────────────────────────────────────────────────────────────

describe("upgrade verb — usage errors", () => {
  test("no surface → usage error 64", async () => {
    const r = await upgradeVerb([]);
    expect(r.code).toBe(64);
  });
  test("unknown surface → usage error 64", async () => {
    const r = await upgradeVerb(["sidecar-bin"]);
    expect(r.code).toBe(64);
  });
  test("unknown flag → usage error 64", async () => {
    const r = await upgradeVerb(["skills", "--frobnicate"]);
    expect(r.code).toBe(64);
  });
});
