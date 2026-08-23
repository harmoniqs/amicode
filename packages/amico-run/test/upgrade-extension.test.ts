// upgrade-extension.test.ts — the `amico upgrade extension` verb (#526, spec
// D2): amicode-repo git discipline (fetch, clean, ancestor; clean-but-behind
// → ff-only pull; dirt/divergence → aborted-diverged), package, install (VS
// Code CLI live / --install-command stub), stale-dir removal version-sorted,
// verification against the FETCHED origin/main version. Hermetic: temp roots,
// stub package/install commands.
import { describe, test, expect } from "vitest";
import { readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { surfaceInventory, dirDigest, type SurfaceRecord } from "../src/surfaces.js";
import { upgradeVerb } from "../src/upgrade.js";
import {
  buildDoctorWorld,
  ctxForWorld,
  cleanupTracked,
  bumpExtensionOnRemote,
  fixtureGit,
  type DoctorWorld,
} from "./helpers.js";

const cleanup = cleanupTracked;
const DEAD_REMOTE = "/nonexistent/upgrade-fixture-remote.git";

// the stub command pair (the hermetic package+install seam):
//  - package stub: succeeds (the fixture repo has no pnpm scripts to run)
//  - install stub: materializes the target extension dir — exactly what the
//    real `code --install-extension` does to --root-vscext
const PACKAGE_STUB = "true";
const installStub = (): string =>
  'mkdir -p "$AMICO_UPGRADE_ROOT_VSCEXT/harmoniqs.amicode-$AMICO_UPGRADE_TARGET_VERSION"';

function verbArgs(w: DoctorWorld, extra: string[] = []): string[] {
  return [
    "extension",
    "--root-server", w.server,
    "--root-vscext", w.vscext,
    "--root-config", w.config,
    "--root-repo-amicode", w.repoAmicode,
    "--root-repo-fork", w.repoFork,
    "--root-staging", w.staging,
    "--package-command", PACKAGE_STUB,
    "--install-command", installStub(),
    ...extra,
  ];
}

const receiptsDir = (w: DoctorWorld): string => join(w.server, "upgrade-receipts");
const lastReceipt = (w: DoctorWorld): Record<string, unknown> => {
  const lines = readFileSync(receiptsDir(w) + "/upgrade-receipts.jsonl", "utf8")
    .split("\n")
    .filter((l) => l.trim());
  expect(lines.length).toBeGreaterThan(0);
  return JSON.parse(lines[lines.length - 1]);
};
const bySurface = (records: SurfaceRecord[], name: string): SurfaceRecord =>
  records.find((r) => r.surface === name)!;
const headOf = (w: DoctorWorld): string =>
  execFileSync("git", ["-C", w.repoAmicode, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

/** Stage the canonical stale-extension world: remote bumped to 0.2.7, the
 *  checkout still at 0.2.6 (clean but BEHIND — exercises the ff-only pull). */
function stageBehind(w: DoctorWorld): void {
  bumpExtensionOnRemote(w.remoteAmicode, "0.2.7");
}

describe("upgrade extension — stale (clean-but-behind)", () => {
  test("behind checkout → ff-only pull, package, install, stale dirs removed, verified vs FETCHED version", async () => {
    const w = buildDoctorWorld();
    stageBehind(w);
    const headBefore = headOf(w);

    const r = await upgradeVerb(verbArgs(w, ["--root-receipts", receiptsDir(w)]));
    expect(r.code).toBe(0);
    const receipt = r.json as Record<string, unknown>;
    expect(receipt.outcome).toBe("upgraded");
    expect(receipt.verification).toBe(true);

    // pre stale (0.2.6 behind 0.2.7), post current
    const pre = receipt.pre as SurfaceRecord[];
    expect(bySurface(pre, "extension").verdict).toBe("stale");
    const post = receipt.post as SurfaceRecord[];
    expect(bySurface(post, "extension").verdict).toBe("current");
    expect(bySurface(post, "extension").version).toContain("0.2.7");
    expect(bySurface(post, "extension").source_version).toBe("0.2.7");

    // the checkout was fast-forwarded to origin/main (HEAD moved, ff-only)
    expect(headOf(w)).not.toBe(headBefore);
    const head = headOf(w);
    const originMain = execFileSync("git", ["-C", w.repoAmicode, "rev-parse", "origin/main"], {
      encoding: "utf8",
    }).trim();
    expect(head).toBe(originMain);

    // the new dir exists; the stale dirs (0.2.6, 0.2.4-darwin-arm64) are gone —
    // version-sorted removal, exactly one installed version remains
    const dirs = readdirSync(w.vscext).filter((d) => /^harmoniqs\.amicode-/.test(d));
    expect(dirs.sort()).toEqual(["harmoniqs.amicode-0.2.7"]);

    // source digests carry the heads + versions
    expect(receipt.source_digests).toMatchObject({ fetched_version: "0.2.7" });
    expect(lastReceipt(w).outcome).toBe("upgraded");
    cleanup();
  });

  test("verification independence: receipt.post equals an independent doctor re-run", async () => {
    const w = buildDoctorWorld();
    stageBehind(w);
    await upgradeVerb(verbArgs(w, ["--root-receipts", receiptsDir(w)]));
    const receipt = lastReceipt(w) as { post: SurfaceRecord[] };
    const independent = await surfaceInventory(ctxForWorld(w));
    expect(receipt.post).toEqual([bySurface(independent.surfaces, "extension")]);
    cleanup();
  });
});

describe("upgrade extension — idempotence (the AC fixture)", () => {
  test("run 2: exit 0 no-op, the --root-vscext tree byte-unchanged", async () => {
    const w = buildDoctorWorld();
    stageBehind(w);
    const args = verbArgs(w, ["--root-receipts", receiptsDir(w)]);

    const run1 = await upgradeVerb(args);
    expect(run1.code).toBe(0);
    expect((run1.json as Record<string, unknown>).outcome).toBe("upgraded");
    const after1 = await dirDigest(w.vscext);

    const run2 = await upgradeVerb(args);
    expect(run2.code).toBe(0);
    const receipt2 = run2.json as Record<string, unknown>;
    expect(receipt2.outcome).toBe("no-op");
    expect(receipt2.verification).toBe(true);
    expect(await dirDigest(w.vscext)).toBe(after1); // the enumerated destination set
    expect(lastReceipt(w).outcome).toBe("no-op");
    cleanup();
  });
});

describe("upgrade extension — git discipline aborts", () => {
  test("dirty tree → aborted-diverged, nothing packaged/installed", async () => {
    const w = buildDoctorWorld();
    stageBehind(w);
    writeFileSync(join(w.repoAmicode, "stray.txt"), "dirt\n");
    const r = await upgradeVerb(verbArgs(w, ["--root-receipts", receiptsDir(w)]));
    expect(r.code).toBe(1);
    const receipt = r.json as Record<string, unknown>;
    expect(receipt.outcome).toBe("aborted-diverged");
    expect(receipt.post).toBeNull();
    // no install happened: the extension dirs are untouched
    const dirs = readdirSync(w.vscext).filter((d) => /^harmoniqs\.amicode-/.test(d));
    expect(dirs.sort()).toEqual(["harmoniqs.amicode-0.2.4-darwin-arm64", "harmoniqs.amicode-0.2.6"]);
    expect(lastReceipt(w).outcome).toBe("aborted-diverged");
    cleanup();
  });

  test("diverged checkout (local commit ahead) → aborted-diverged — never reset, never merge", async () => {
    const w = buildDoctorWorld();
    stageBehind(w);
    // a local commit the remote does not carry → HEAD not an ancestor of origin/main
    writeFileSync(join(w.repoAmicode, "local-only.txt"), "local work\n");
    fixtureGit(w.repoAmicode, ["add", "-A"]);
    fixtureGit(w.repoAmicode, ["commit", "-m", "local experiment"]);
    const headBefore = headOf(w);

    const r = await upgradeVerb(verbArgs(w, ["--root-receipts", receiptsDir(w)]));
    expect(r.code).toBe(1);
    expect((r.json as Record<string, unknown>).outcome).toBe("aborted-diverged");
    // the diverged checkout is the human's to resolve — the verb did not touch it
    expect(headOf(w)).toBe(headBefore);
    expect(existsSync(join(w.repoAmicode, "local-only.txt"))).toBe(true);
    cleanup();
  });

  test("unreachable remote → aborted-unknown (pre-flight: never judge blind)", async () => {
    const w = buildDoctorWorld();
    fixtureGit(w.repoAmicode, ["remote", "set-url", "origin", DEAD_REMOTE]);
    const r = await upgradeVerb(verbArgs(w, ["--root-receipts", receiptsDir(w)]));
    expect(r.code).toBe(1);
    expect((r.json as Record<string, unknown>).outcome).toBe("aborted-unknown");
    cleanup();
  });
});
