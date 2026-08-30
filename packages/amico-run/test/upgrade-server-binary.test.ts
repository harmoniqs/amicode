// upgrade-server-binary.test.ts — the `amico upgrade server-binary` verb
// (#526, spec D2): the full 9-step chain — env preflight, fork git discipline
// (clean+ancestor or aborted-diverged), bun install + build --single (live
// only — fixtures use --skip-build), smoke --version, freeze with opencode.prev
// preserved, launchctl kickstart kick, poll health + running-sha==sidecar with
// 120s timeout + one re-kick retry, restore-from-prev with sidecar REWRITE on
// failure, prev deletion on success/verified-restore. Hermetic per the
// kick-stub contract: the kick stub copies the frozen binary to the
// --running-binary path; the health stub shapes the verify phases.
import { describe, test, expect } from "vitest";
import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { surfaceInventory, fileSha, type SurfaceRecord } from "../src/surfaces.js";
import { upgradeVerb } from "../src/upgrade.js";
import {
  buildDoctorWorld,
  ctxForWorld,
  cleanupTracked,
  trackTmp,
  fakeBin,
  fixtureGit,
  bumpForkHead,
  sha256File,
  FUTURE_BUILD,
  PAST_BUILD,
  type DoctorWorld,
} from "./helpers.js";

const cleanup = cleanupTracked;
const DEAD_REMOTE = "/nonexistent/upgrade-sb-remote.git";

// ── the stub command contract ────────────────────────────────────────────────

/** THE KICK STUB (spec D2's contract): make the running-binary evidence match
 *  the frozen artifact — copy frozen → running. Serves the initial kick, the
 *  re-kick retry, AND the restore kick (frozen is then prev's bytes). */
const KICK_STUB = 'cp "$AMICO_UPGRADE_FROZEN_BIN" "$AMICO_UPGRADE_RUNNING_BIN"';

/** health stubs: exit 0 = healthy; phase-aware for the restore fixture. */
const HEALTH_OK = "true";
const HEALTH_FAIL_VERIFY_ONLY =
  'case "$AMICO_UPGRADE_PHASE" in verify*) exit 1;; *) exit 0;; esac';
const HEALTH_FAIL_ALWAYS = "exit 1";

/** THE DIST-BUILD STUB (#643): fabricates every declared bundle in the
 * fixture checkout's packages/amico-run/dist — the hermetic seam for the
 * verb-router dist rebuild the server-binary upgrade now performs (the real
 * build is `pnpm run build` in that dir; CI's bundle-build-gate lane proves
 * the real one on every push). Each stub bundle is ESM (`export {};`) so the
 * module-type warning test discriminates. */
const DIST_BUILD_STUB =
  'mkdir -p dist && for n in amico-run amico amico-pasqal amico-git-credential gh; do printf "export {};\\n" > "dist/$n.js"; done';

function verbArgs(w: DoctorWorld, extra: string[]): string[] {
  return [
    "server-binary",
    "--root-server", w.server,
    "--root-vscext", w.vscext,
    "--root-config", w.config,
    "--root-repo-amicode", w.repoAmicode,
    "--root-repo-fork", w.repoFork,
    "--root-staging", w.staging,
    "--running-binary", w.running,
    "--dist-build-command", DIST_BUILD_STUB,
    ...extra,
  ];
}

const receiptsDir = (w: DoctorWorld): string => join(w.server, "upgrade-receipts");
const lastReceipt = (w: DoctorWorld): Record<string, any> => {
  const lines = readFileSync(join(receiptsDir(w), "upgrade-receipts.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim());
  expect(lines.length).toBeGreaterThan(0);
  return JSON.parse(lines[lines.length - 1]);
};
const bySurface = (records: SurfaceRecord[], name: string): SurfaceRecord =>
  records.find((r) => r.surface === name)!;

/** A fresh artifact for --skip-build: a fake binary printing a FUTURE build
 *  date (≥ the fixture fork's pinned HEAD commit date). */
function freshArtifact(): string {
  return fakeBin(trackTmp("upgrade-artifact-"), "opencode-new", FUTURE_BUILD);
}

/** The canonical success-run argv (version-stale world → upgraded). */
function successArgs(w: DoctorWorld, artifact: string): string[] {
  return verbArgs(w, [
    "--root-receipts", receiptsDir(w),
    "--skip-build", artifact,
    "--kick-command", KICK_STUB,
    "--health-command", HEALTH_OK,
    "--verify-timeout-ms", "2000",
  ]);
}

/** Stage the VERSION-stale branch: frozen prints PAST_BUILD (< the fork's
 *  pinned HEAD commit date), running == frozen bytes, integrity intact. */
function stageVersionStale(): DoctorWorld {
  return buildDoctorWorld({ frozenVersion: PAST_BUILD });
}

// ── the success chain ────────────────────────────────────────────────────────

describe("upgrade server-binary — version-stale → upgraded (the full chain)", () => {
  test("skip-build + kick/health stubs: freeze, kick, verify, prev deleted, receipt complete", async () => {
    const w = stageVersionStale();
    const artifact = freshArtifact();
    const newSha = await fileSha(artifact);

    const r = await upgradeVerb(successArgs(w, artifact));
    expect(r.code).toBe(0);
    const receipt = r.json as Record<string, any>;
    expect(receipt.outcome).toBe("upgraded");
    expect(receipt.verification).toBe(true);

    // pre: stale (version); post: current — both records in the receipt
    expect(bySurface(receipt.pre, "server-binary").verdict).toBe("stale");
    expect(bySurface(receipt.post, "server-binary").verdict).toBe("current");

    // the frozen binary IS the artifact; sidecar matches; running matches
    expect(await fileSha(join(w.server, "bin", "opencode"))).toBe(newSha);
    const sidecar = readFileSync(join(w.server, "bin", "opencode.sha256"), "utf8");
    expect(sidecar).toContain(newSha);
    expect(await fileSha(w.running)).toBe(newSha);

    // success deletes opencode.prev (its verification passed)
    expect(existsSync(join(w.server, "bin", "opencode.prev"))).toBe(false);

    // source digests: the artifact + the fork state
    expect(receipt.source_digests.artifact_sha256).toBe(newSha);
    expect(receipt.source_digests.frozen_sha256).toBe(newSha);
    expect(lastReceipt(w).outcome).toBe("upgraded");
    cleanup();
  });

  test("verification independence: receipt.post equals an independent doctor re-run", async () => {
    const w = stageVersionStale();
    const r = await upgradeVerb(successArgs(w, freshArtifact()));
    expect(r.code).toBe(0);
    const receipt = r.json as Record<string, any>;
    const independent = await surfaceInventory(ctxForWorld(w));
    expect(receipt.post).toEqual([bySurface(independent.surfaces, "server-binary")]);
    expect(bySurface(independent.surfaces, "server-binary").verdict).toBe("current");
    cleanup();
  });
});

describe("upgrade server-binary — idempotence (the AC fixture, VERSION-stale branch)", () => {
  test("run 2: exit 0 no-op; frozen binary + sidecar byte-unchanged (prev out of scope — run 1 deleted it)", async () => {
    const w = stageVersionStale();
    const artifact = freshArtifact();
    const args = successArgs(w, artifact);

    const run1 = await upgradeVerb(args);
    expect(run1.code).toBe(0);
    expect((run1.json as Record<string, any>).outcome).toBe("upgraded");
    // the ENUMERATED digest set: the frozen binary + the sidecar
    const digestSet = async (): Promise<string> =>
      `${await fileSha(join(w.server, "bin", "opencode"))}/${await fileSha(join(w.server, "bin", "opencode.sha256"))}`;
    const after1 = await digestSet();

    const run2 = await upgradeVerb(args);
    expect(run2.code).toBe(0);
    const receipt2 = run2.json as Record<string, any>;
    expect(receipt2.outcome).toBe("no-op");
    expect(receipt2.verification).toBe(true);
    expect(bySurface(receipt2.pre, "server-binary").verdict).toBe("current");
    expect(await digestSet()).toBe(after1);
    expect(lastReceipt(w).outcome).toBe("no-op");
    cleanup();
  });
});

// ── the git discipline aborts ────────────────────────────────────────────────

describe("upgrade server-binary — fork git discipline", () => {
  test("dirty fork → aborted-diverged; nothing frozen, no receipt lie", async () => {
    const w = stageVersionStale();
    writeFileSync(join(w.repoFork, "stray.txt"), "dirt\n");
    const r = await upgradeVerb(successArgs(w, freshArtifact()));
    expect(r.code).toBe(1);
    const receipt = r.json as Record<string, any>;
    expect(receipt.outcome).toBe("aborted-diverged");
    expect(receipt.post).toBeNull();
    // the frozen binary was NOT touched
    expect(readFileSync(join(w.server, "bin", "opencode.sha256"), "utf8")).toContain(
      await fileSha(join(w.server, "bin", "opencode")),
    );
    expect(lastReceipt(w).outcome).toBe("aborted-diverged");
    cleanup();
  });

  test("diverged fork (local commit ahead) → aborted-diverged — never reset, never merge", async () => {
    const w = stageVersionStale();
    writeFileSync(join(w.repoFork, "local-experiment.txt"), "local\n");
    fixtureGit(w.repoFork, ["add", "-A"]);
    fixtureGit(w.repoFork, ["commit", "-m", "local experiment"]);
    const r = await upgradeVerb(successArgs(w, freshArtifact()));
    expect(r.code).toBe(1);
    expect((r.json as Record<string, any>).outcome).toBe("aborted-diverged");
    // the diverged checkout is the human's to resolve
    expect(existsSync(join(w.repoFork, "local-experiment.txt"))).toBe(true);
    cleanup();
  });

  test("clean-but-behind fork is fast-forwarded to the ref before freezing", async () => {
    const w = stageVersionStale();
    bumpForkHead(w.remoteFork); // remote moves; the checkout stays clean-behind
    const artifact = freshArtifact();
    const r = await upgradeVerb(successArgs(w, artifact));
    expect(r.code).toBe(0);
    const receipt = r.json as Record<string, any>;
    expect(receipt.outcome).toBe("upgraded");
    expect(receipt.source_digests.fork_head_after).toBe(receipt.source_digests.fork_head_at_ref);
    // the checkout's HEAD == origin/local/amicode (fast-forwarded, not reset)
    expect(
      (await import("node:child_process")).execFileSync("git",
        ["-C", w.repoFork, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    ).toBe(
      (await import("node:child_process")).execFileSync("git",
        ["-C", w.repoFork, "rev-parse", "origin/local/amicode"], { encoding: "utf8" }).trim(),
    );
    cleanup();
  });

  test("unreachable fork remote → aborted-unknown (pre-flight)", async () => {
    const w = stageVersionStale();
    fixtureGit(w.repoFork, ["remote", "set-url", "origin", DEAD_REMOTE]);
    const r = await upgradeVerb(successArgs(w, freshArtifact()));
    expect(r.code).toBe(1);
    expect((r.json as Record<string, any>).outcome).toBe("aborted-unknown");
    cleanup();
  });
});

// ── --no-kick: freeze only ───────────────────────────────────────────────────

describe("upgrade server-binary — --no-kick (freeze only)", () => {
  test("verification deferred, prev RETAINED (until a later verify passes), exit 0", async () => {
    const w = stageVersionStale();
    const artifact = freshArtifact();
    const args = verbArgs(w, [
      "--root-receipts", receiptsDir(w),
      "--skip-build", artifact,
      "--no-kick",
    ]);
    const r = await upgradeVerb(args);
    expect(r.code).toBe(0);
    const receipt = r.json as Record<string, any>;
    expect(receipt.outcome).toBe("upgraded");
    expect(receipt.verification).toBe("deferred");
    // frozen is the new artifact, sidecar matches…
    expect(await fileSha(join(w.server, "bin", "opencode"))).toBe(await fileSha(artifact));
    // …but prev is retained and the running process still has the OLD bytes
    expect(existsSync(join(w.server, "bin", "opencode.prev"))).toBe(true);
    expect(await fileSha(w.running)).not.toBe(await fileSha(artifact));
    // the post record is honest: restart pending (running ≠ frozen)
    expect(bySurface(receipt.post, "server-binary").verdict).toBe("stale");
    expect(bySurface(receipt.post, "server-binary").evidence.join(" ")).toMatch(/restart pending/);
    cleanup();
  });
});

// ── the verb-router dist rebuild (#643) ──────────────────────────────────────

describe("upgrade server-binary — the verb-router dist rebuild (#643)", () => {
  test("a deployed upgrade rebuilds the dists and refreshes BOTH copies, with receipt evidence", async () => {
    const w = stageVersionStale();
    const artifact = freshArtifact();

    const r = await upgradeVerb(successArgs(w, artifact));
    expect(r.code).toBe(0);
    const receipt = r.json as Record<string, any>;
    expect(receipt.outcome).toBe("upgraded");

    // BOTH copies refreshed: the build output AND the extension-side byte-copy
    // the PATH-first launcher execs — byte-identical, for every declared bundle
    const arDist = join(w.repoAmicode, "packages", "amico-run", "dist");
    const extBin = join(w.repoAmicode, "packages", "extension", "bin");
    for (const n of ["amico-run", "amico", "amico-pasqal", "amico-git-credential", "gh"]) {
      const built = readFileSync(join(arDist, `${n}.js`));
      const staged = readFileSync(join(extBin, "dist", `${n}.js`));
      expect(staged.equals(built)).toBe(true);
    }

    // receipt evidence: the router's sha on BOTH sides + the source commit
    const routerSha = sha256File(join(arDist, "amico.js"));
    expect(receipt.source_digests.verb_router_sha256).toBe(routerSha);
    expect(receipt.source_digests.verb_router_staged_sha256).toBe(routerSha);
    expect(receipt.source_digests.amicode_head).toBe(
      execFileSync("git", ["-C", w.repoAmicode, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    );
    // the human story names the refresh
    expect(receipt.detail.join(" ")).toMatch(/verb-router|dist/i);
    cleanup();
  });

  test("dist build failure → aborted-build BEFORE the freeze: server surface untouched, no receipt lie", async () => {
    const w = stageVersionStale();
    const frozenShaBefore = await fileSha(join(w.server, "bin", "opencode"));
    const args = verbArgs(w, [
      "--root-receipts", receiptsDir(w),
      "--skip-build", freshArtifact(),
      "--kick-command", KICK_STUB,
      "--health-command", HEALTH_OK,
      "--verify-timeout-ms", "2000",
      "--dist-build-command", "exit 3",
    ]);

    const r = await upgradeVerb(args);
    expect(r.code).toBe(1);
    const receipt = r.json as Record<string, any>;
    expect(receipt.outcome).toBe("aborted-build");
    // nothing frozen: the old binary + sidecar still agree, no prev, no staged copy
    expect(await fileSha(join(w.server, "bin", "opencode"))).toBe(frozenShaBefore);
    expect(readFileSync(join(w.server, "bin", "opencode.sha256"), "utf8")).toContain(frozenShaBefore!);
    expect(existsSync(join(w.server, "bin", "opencode.prev"))).toBe(false);
    expect(existsSync(join(w.repoAmicode, "packages", "extension", "bin", "dist", "amico.js"))).toBe(false);
    expect(lastReceipt(w).outcome).toBe("aborted-build");
    cleanup();
  });

  test("a half-built dist set (declared bundle missing) → aborted-build", async () => {
    const w = stageVersionStale();
    const args = verbArgs(w, [
      "--root-receipts", receiptsDir(w),
      "--skip-build", freshArtifact(),
      "--kick-command", KICK_STUB,
      "--health-command", HEALTH_OK,
      "--verify-timeout-ms", "2000",
      "--dist-build-command", 'mkdir -p dist && printf "export {};\\n" > dist/amico.js',
    ]);

    const r = await upgradeVerb(args);
    expect(r.code).toBe(1);
    expect((r.json as Record<string, any>).outcome).toBe("aborted-build");
    expect((r.json as Record<string, any>).detail.join(" ")).toMatch(/amico-pasqal/);
    cleanup();
  });
});

// ── the restore paths ────────────────────────────────────────────────────────

describe("upgrade server-binary — restore (verify fails → rollback to prev)", () => {
  test("health fails on verify, succeeds on restore → outcome restored: prev back, sidecar REWRITTEN, running == prev, prev deleted", async () => {
    const w = stageVersionStale();
    const oldFrozen = join(w.server, "bin", "opencode");
    const prevSha = await fileSha(oldFrozen); // PAST_BUILD bytes
    const artifact = freshArtifact();
    const args = verbArgs(w, [
      "--root-receipts", receiptsDir(w),
      "--skip-build", artifact,
      "--kick-command", KICK_STUB,
      "--health-command", HEALTH_FAIL_VERIFY_ONLY,
      "--verify-timeout-ms", "400",
    ]);

    const r = await upgradeVerb(args);
    // the upgrade FAILED and rolled back — the receipt says so, exit non-zero
    expect(r.code).toBe(1);
    const receipt = r.json as Record<string, any>;
    expect(receipt.outcome).toBe("restored");
    expect(receipt.verification).toBe(false);
    expect(receipt.detail.join(" ")).toMatch(/restore/);

    // prev is back as the frozen binary; the sidecar was REWRITTEN to prev's
    // sha (else the surface would read integrity-failed forever)
    expect(await fileSha(oldFrozen)).toBe(prevSha);
    expect(readFileSync(`${oldFrozen}.sha256`, "utf8")).toContain(prevSha);
    // the running process runs prev's bytes (the restore kick + verify passed)
    expect(await fileSha(w.running)).toBe(prevSha);
    // a VERIFIED restore deletes prev too (its verification passed — the restore's own)
    expect(existsSync(join(w.server, "bin", "opencode.prev"))).toBe(false);

    // verification independence on the restored state
    const independent = await surfaceInventory(ctxForWorld(w));
    expect(receipt.post).toEqual([bySurface(independent.surfaces, "server-binary")]);
    // the surface is honestly stale (rolled back to the old version) — never
    // integrity-failed, never current
    expect(bySurface(independent.surfaces, "server-binary").verdict).toBe("stale");
    expect(lastReceipt(w).outcome).toBe("restored");
    cleanup();
  });

  test("health fails ALWAYS → restore-failed: prev retained, verification false, exit non-zero", async () => {
    const w = stageVersionStale();
    const prevSha = await fileSha(join(w.server, "bin", "opencode"));
    const args = verbArgs(w, [
      "--root-receipts", receiptsDir(w),
      "--skip-build", freshArtifact(),
      "--kick-command", KICK_STUB,
      "--health-command", HEALTH_FAIL_ALWAYS,
      "--verify-timeout-ms", "300",
    ]);

    const r = await upgradeVerb(args);
    expect(r.code).toBe(1);
    const receipt = r.json as Record<string, any>;
    expect(receipt.outcome).toBe("restore-failed");
    expect(receipt.verification).toBe(false);

    // the restore still ran as far as it could: frozen = prev, sidecar = prev
    expect(await fileSha(join(w.server, "bin", "opencode"))).toBe(prevSha);
    expect(readFileSync(join(w.server, "bin", "opencode.sha256"), "utf8")).toContain(prevSha);
    // server down: prev RETAINED (the only good copy — never deleted on failure)
    expect(existsSync(join(w.server, "bin", "opencode.prev"))).toBe(true);
    expect(lastReceipt(w).outcome).toBe("restore-failed");
    cleanup();
  });
});
