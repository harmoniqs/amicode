// opencode_updater tests (#451, M4) — the adopt gate's every stage, using a
// FAKE binary packed into a real archive so extraction/atomicity run for real;
// the boot stage is injected (the real boot smoke + plugin stamp was validated
// against actual canonical v1.18.19 in the M0 probe and the live drill).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, symlinkSync, renameSync as fsRename, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  adoptRelease,
  checkForUpdate,
  consistentDbCopy,
  currentVersion,
  isNewer,
  managedBinary,
  type FetchLike,
  type ReleaseCandidate,
} from "../src/opencode_updater";

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

let root: string;
let work: string;
const log = { lines: [] as string[], appendLine(l: string) { this.lines.push(l); } };

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "updater-test-"));
  root = join(work, "canonical");
  mkdirSync(root, { recursive: true });
  log.lines = [];
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

/** A fake opencode binary: `--version` prints the given version. Packed into
 *  a zip alongside the real release layout (nested dir), digest computed. */
function fakeRelease(version: string, opts: { nested?: boolean } = {}): {
  candidate: ReleaseCandidate;
  bytes: Buffer;
} {
  const dir = join(work, `build-${version}`);
  mkdirSync(dir, { recursive: true });
  const script = `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi\nexit 1\n`;
  const inner = opts.nested === false ? dir : join(dir, "opencode-darwin-arm64");
  mkdirSync(inner, { recursive: true });
  const bin = join(inner, "opencode");
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  const archive = join(work, `opencode-${version}.zip`);
  execFileSync("zip", ["-q", "-r", archive, opts.nested === false ? "opencode" : "opencode-darwin-arm64"], { cwd: dir });
  const bytes = Buffer.from(execFileSync("cat", [archive]));
  rmSync(dir, { recursive: true, force: true });
  rmSync(archive, { force: true });
  return {
    candidate: {
      version,
      tag: `v${version}`,
      assetName: "opencode-darwin-arm64.zip",
      assetUrl: `https://example.invalid/opencode-${version}.zip`,
      digest: `sha256:${sha256(bytes)}`,
    },
    bytes,
  };
}

/** fetchImpl serving the fake release bytes. */
function fakeFetch(routes: Record<string, { json?: unknown; bytes?: Buffer; ok?: boolean }>): FetchLike {
  return async (url: string) => {
    const hit = routes[url];
    if (!hit) return { ok: false, status: 404 };
    return {
      ok: hit.ok ?? true,
      status: 200,
      json: hit.json !== undefined ? async () => hit.json : undefined,
      arrayBuffer: hit.bytes !== undefined ? async () => hit.bytes.buffer.slice(hit.bytes.byteOffset, hit.bytes.byteOffset + hit.bytes.length) : undefined,
    };
  };
}

const okProbe = async () => undefined;

describe("isNewer", () => {
  it("compares dotted versions and ignores the v prefix", () => {
    expect(isNewer("1.18.19", "1.18.10")).toBe(true);
    expect(isNewer("v1.19.0", "1.18.99")).toBe(true);
    expect(isNewer("1.18.10", "1.18.10")).toBe(false);
    expect(isNewer("1.18.9", "1.18.10")).toBe(false);
  });
});

describe("checkForUpdate", () => {
  const latestUrl = "https://api.github.com/repos/anomalyco/opencode/releases/latest";
  const latestBody = {
    tag_name: "v1.18.20",
    assets: [
      { name: "opencode-darwin-arm64.zip", digest: `sha256:${"a".repeat(64)}`, size: 1, browser_download_url: "https://example.invalid/oc.zip" },
    ],
  };

  it("reports an update with the asset's digest", async () => {
    const r = await checkForUpdate({ current: "1.18.19", fetchImpl: fakeFetch({ [latestUrl]: { json: latestBody } }), root });
    expect(r.kind).toBe("update");
    expect(r.candidate?.version).toBe("1.18.20");
    expect(r.candidate?.digest).toBe(`sha256:${"a".repeat(64)}`);
  });

  it("reports current when the installed version is at least the latest", async () => {
    const r = await checkForUpdate({ current: "1.18.20", fetchImpl: fakeFetch({ [latestUrl]: { json: latestBody } }), root });
    expect(r.kind).toBe("current");
  });

  it("never throws on fetch failure — stays on last-known-good", async () => {
    const failing: FetchLike = async () => { throw new Error("network down"); };
    const r = await checkForUpdate({ current: "1.18.19", fetchImpl: failing, root });
    expect(r.kind).toBe("current");
  });

  it("reads the current version from the root's symlink when not given", async () => {
    mkdirSync(join(root, "versions", "1.0.0"), { recursive: true });
    writeFileSync(join(root, "versions", "1.0.0", "opencode"), "stub");
    const linkTmp = join(root, ".l");
    symlinkSync("versions/1.0.0", linkTmp);
    fsRename(linkTmp, join(root, "current"));
    const r = await checkForUpdate({ fetchImpl: fakeFetch({ [latestUrl]: { json: latestBody } }), root });
    expect(r.kind).toBe("update");
    expect(r.current).toBe("1.0.0");
  });
});

describe("adoptRelease — the gate", () => {
  it("adopts a good release: verify → extract → version probe → boot probe → atomic swap", async () => {
    const { candidate, bytes } = fakeRelease("1.18.20");
    const probes: string[] = [];
    const r = await adoptRelease({
      candidate,
      root,
      fetchImpl: fakeFetch({ [candidate.assetUrl]: { bytes } }),
      log,
      probeBoot: async (_bin, env) => {
        probes.push(env.AMICODE_UPDATER_PROBE_DB ? "db" : "fresh");
      },
    });
    expect(r.ok).toBe(true);
    expect(r.version).toBe("1.18.20");
    expect(currentVersion(root)).toBe("1.18.20");
    expect(managedBinary(root)).toBeDefined();
    expect(existsSync(join(root, "current", "opencode"))).toBe(true);
    expect(probes.length).toBe(1); // no liveDbPath → fresh boot only
  });

  it("REFUSES on digest absence (never verify-less)", async () => {
    const { candidate, bytes } = fakeRelease("1.18.20");
    const r = await adoptRelease({
      candidate: { ...candidate, digest: undefined },
      root,
      fetchImpl: fakeFetch({ [candidate.assetUrl]: { bytes } }),
      log,
      probeBoot: okProbe,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("no sha256 digest");
    expect(currentVersion(root)).toBeUndefined();
  });

  it("REFUSES on sha256 mismatch and keeps last-known-good current", async () => {
    // First adopt a good 1.18.19, then try a corrupted 1.18.20.
    const first = fakeRelease("1.18.19");
    await adoptRelease({
      candidate: first.candidate,
      root,
      fetchImpl: fakeFetch({ [first.candidate.assetUrl]: { bytes: first.bytes } }),
      log,
      probeBoot: okProbe,
    });
    expect(currentVersion(root)).toBe("1.18.19");

    const bad = fakeRelease("1.18.20");
    const corrupted = Buffer.from(bad.bytes);
    corrupted[corrupted.length - 1] ^= 0xff;
    const r = await adoptRelease({
      candidate: bad.candidate,
      root,
      fetchImpl: fakeFetch({ [bad.candidate.assetUrl]: { bytes: corrupted } }),
      log,
      probeBoot: okProbe,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("sha256 mismatch");
    expect(currentVersion(root)).toBe("1.18.19"); // untouched
    expect(managedBinary(root)).toBeDefined(); // LKG survives
  });

  it("REFUSES when --version doesn't print the candidate version", async () => {
    const { candidate, bytes } = fakeRelease("9.9.9", { nested: false });
    const r = await adoptRelease({
      candidate: { ...candidate, version: "1.18.20", tag: "v1.18.20" }, // mismatch on purpose
      root,
      fetchImpl: fakeFetch({ [candidate.assetUrl]: { bytes } }),
      log,
      probeBoot: okProbe,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("--version probe");
    expect(currentVersion(root)).toBeUndefined();
  });

  it("REFUSES when the boot probe fails (server won't boot)", async () => {
    const { candidate, bytes } = fakeRelease("1.18.20");
    const r = await adoptRelease({
      candidate,
      root,
      fetchImpl: fakeFetch({ [candidate.assetUrl]: { bytes } }),
      log,
      probeBoot: async () => {
        throw new Error("probe server exited early (code 1)");
      },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("probe server exited early");
    expect(currentVersion(root)).toBeUndefined();
  });

  it("runs the DB-compat probe against a consistent copy when a live DB is given", async () => {
    const { candidate, bytes } = fakeRelease("1.18.20");
    const dbBoots: (string | undefined)[] = [];
    const liveDb = join(work, "live.db");
    spawnSync("sqlite3", [liveDb, "create table t(x); insert into t values (1);"], { encoding: "utf8" });
    const r = await adoptRelease({
      candidate,
      root,
      fetchImpl: fakeFetch({ [candidate.assetUrl]: { bytes } }),
      log,
      liveDbPath: existsSync(liveDb) ? liveDb : undefined,
      probeBoot: async (_bin, env) => {
        dbBoots.push(env.AMICODE_UPDATER_PROBE_DB || undefined);
      },
    });
    if (!existsSync(liveDb)) {
      // sqlite3 unavailable on this runner: the fresh boot still must have run
      expect(r.ok).toBe(true);
      expect(dbBoots).toEqual([undefined]);
      return;
    }
    expect(r.ok).toBe(true);
    expect(dbBoots.length).toBe(2); // fresh boot + DB-copy boot
    expect(dbBoots[0]).toBeUndefined();
    expect(dbBoots[1]).toMatch(/db-copy-/);
  });

  it("prunes to the newest two versions (current + rollback)", async () => {
    for (const v of ["1.18.10", "1.18.15", "1.18.19"]) {
      const rel = fakeRelease(v);
      const r = await adoptRelease({
        candidate: rel.candidate,
        root,
        fetchImpl: fakeFetch({ [rel.candidate.assetUrl]: { bytes: rel.bytes } }),
        log,
        probeBoot: okProbe,
      });
      expect(r.ok).toBe(true);
    }
    expect(currentVersion(root)).toBe("1.18.19");
    const versions = readdirSync(join(root, "versions")).filter((v) => !v.startsWith("."));
    expect(versions.length).toBe(2);
    expect(versions).toContain("1.18.19");
    expect(versions).toContain("1.18.15");
    expect(versions).not.toContain("1.18.10");
  });

  it("re-adopting the same version replaces it cleanly (idempotent path)", async () => {
    const { candidate, bytes } = fakeRelease("1.18.20");
    for (let i = 0; i < 2; i++) {
      const r = await adoptRelease({
        candidate,
        root,
        fetchImpl: fakeFetch({ [candidate.assetUrl]: { bytes } }),
        log,
        probeBoot: okProbe,
      });
      expect(r.ok).toBe(true);
    }
    expect(currentVersion(root)).toBe("1.18.20");
  });
});

describe("consistentDbCopy", () => {
  it("produces an openable copy via the sqlite backup API (or reports unavailability)", () => {
    const src = join(work, "src.db");
    const m = spawnSync("sqlite3", [src, "create table t(x); insert into t values (42);"], { encoding: "utf8" });
    if (m.status !== 0) return; // sqlite3 missing on this runner — degraded path is exercised elsewhere
    const copy = consistentDbCopy(src, work);
    expect(copy).toBeDefined();
    const read = spawnSync("sqlite3", [copy!, "select x from t;"], { encoding: "utf8" });
    expect(read.stdout.trim()).toBe("42");
  });
});
