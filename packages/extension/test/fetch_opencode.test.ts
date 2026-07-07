import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchOpencode, loadManifest, resolvePlatform, sha256 } from "../scripts/fetch_opencode.mjs";

function rootWith(manifest: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "oc-test-"));
  writeFileSync(join(root, "opencode.lock.json"), JSON.stringify(manifest));
  return root;
}

const GOOD = {
  version: "1.17.3",
  platforms: {
    "darwin-arm64": { asset: "a.zip", sha256: "ab".repeat(32) },
    "linux-x64": { asset: "a.tar.gz", sha256: "cd".repeat(32) },
  },
};

describe("loadManifest", () => {
  it("accepts a well-formed manifest", () => {
    expect(loadManifest(rootWith(GOOD)).version).toBe("1.17.3");
  });
  it("the COMMITTED manifest parses and pins exactly the two supported platforms", () => {
    const m = loadManifest(); // defaults to the real packages/extension root
    expect(Object.keys(m.platforms).sort()).toEqual(["darwin-arm64", "linux-x64"]);
  });
  it("rejects missing version and short hashes", () => {
    expect(() => loadManifest(rootWith({ ...GOOD, version: "" }))).toThrow(/version/);
    expect(() =>
      loadManifest(
        rootWith({
          ...GOOD,
          platforms: { ...GOOD.platforms, "linux-x64": { asset: "a", sha256: "beef" } },
        }),
      ),
    ).toThrow(/sha256/);
  });
  it("source:local requires a 40-hex ref; unknown sources rejected", () => {
    expect(() => loadManifest(rootWith({ ...GOOD, source: "local" }))).toThrow(/ref/);
    expect(() => loadManifest(rootWith({ ...GOOD, source: "local", ref: "b3ad983" }))).toThrow(/ref/);
    expect(() => loadManifest(rootWith({ ...GOOD, source: "npm" }))).toThrow(/source/);
    expect(loadManifest(rootWith({ ...GOOD, source: "local", ref: "ab".repeat(20) })).ref).toBe("ab".repeat(20));
  });
});

describe("resolvePlatform", () => {
  it("honors an explicit valid key and rejects unknown ones", () => {
    expect(resolvePlatform(GOOD, "linux-x64")).toBe("linux-x64");
    expect(() => resolvePlatform(GOOD, "windows-x64")).toThrow(/supported/);
  });
  it("detects the current machine when no flag given", () => {
    const key = `${process.platform}-${process.arch}`;
    if (key in GOOD.platforms) expect(resolvePlatform(GOOD)).toBe(key);
    else expect(() => resolvePlatform(GOOD)).toThrow(/supported/);
  });
});

function fixtureArchive(): { bytes: Buffer; hash: string } {
  const dir = mkdtempSync(join(tmpdir(), "oc-fixture-"));
  writeFileSync(join(dir, "opencode"), "#!/bin/sh\necho fake-opencode\n");
  chmodSync(join(dir, "opencode"), 0o755);
  execFileSync("tar", ["-czf", join(dir, "a.tar.gz"), "-C", dir, "opencode"]);
  const bytes = readFileSync(join(dir, "a.tar.gz"));
  return { bytes, hash: sha256(bytes) };
}

describe("fetchOpencode", () => {
  it("downloads, verifies, unpacks, stamps — then skips on re-run", async () => {
    const { bytes, hash } = fixtureArchive();
    const root = rootWith({ version: "9.9.9", platforms: { "linux-x64": { asset: "a.tar.gz", sha256: hash } } });
    let calls = 0;
    const download = async () => {
      calls++;
      return bytes;
    };
    const r1 = await fetchOpencode({ root, platform: "linux-x64", download });
    expect(r1.skipped).toBe(false);
    const bin = join(root, "vendor", "opencode", "linux-x64", "opencode");
    expect(existsSync(bin)).toBe(true);
    expect(readFileSync(join(root, "vendor", "opencode", "linux-x64", ".sha256"), "utf8").trim()).toBe(hash);
    const r2 = await fetchOpencode({ root, platform: "linux-x64", download });
    expect(r2.skipped).toBe(true);
    expect(calls).toBe(1); // idempotent: no second download
  });
  it("hard-fails on hash mismatch, printing expected vs actual, installing nothing", async () => {
    const { bytes } = fixtureArchive();
    const root = rootWith({
      version: "9.9.9",
      platforms: { "linux-x64": { asset: "a.tar.gz", sha256: "ee".repeat(32) } },
    });
    await expect(fetchOpencode({ root, platform: "linux-x64", download: async () => bytes })).rejects.toThrow(
      /expected ee.*actual/s,
    );
    expect(existsSync(join(root, "vendor", "opencode", "linux-x64", "opencode"))).toBe(false);
  });
});

function fixtureClone(): { clone: string; head: string; artifact: string } {
  const clone = mkdtempSync(join(tmpdir(), "oc-clone-"));
  const g = (...args: string[]) =>
    execFileSync("git", ["-C", clone, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" });
  g("init", "-q");
  writeFileSync(join(clone, "README.md"), "fork\n");
  writeFileSync(join(clone, ".gitignore"), "dist/\n"); // the real fork gitignores build output
  g("add", ".");
  g("commit", "-qm", "init");
  const head = g("rev-parse", "HEAD").trim();
  const artifactDir = join(clone, "packages", "opencode", "dist", "opencode-linux-x64", "bin");
  mkdirSync(artifactDir, { recursive: true });
  const artifact = join(artifactDir, "opencode");
  writeFileSync(artifact, "#!/bin/sh\necho local-build\n");
  chmodSync(artifact, 0o755);
  return { clone, head, artifact };
}

const localManifest = (ref: string) => ({
  version: "9.9.9",
  repo: "harmoniqs/opencode",
  tag: "v9.9.9-amicode.1",
  source: "local",
  ref,
  platforms: { "linux-x64": { asset: "a.tar.gz", sha256: "cd".repeat(32) } },
});

describe("fetchOpencode — local source", () => {
  it("installs from a clean clone at the pinned ref, stamping the ACTUAL sha + provenance", async () => {
    const { clone, head, artifact } = fixtureClone();
    const root = rootWith(localManifest(head));
    const r = await fetchOpencode({ root, platform: "linux-x64", localDir: clone, noBuild: true });
    expect(r.skipped).toBe(false);
    expect(r.source).toBe(`local ${head}`);
    const dest = join(root, "vendor", "opencode", "linux-x64");
    expect(readFileSync(join(dest, "opencode"), "utf8")).toBe(readFileSync(artifact, "utf8"));
    expect(readFileSync(join(dest, ".sha256"), "utf8").trim()).toBe(sha256(readFileSync(artifact)));
    expect(readFileSync(join(dest, ".source"), "utf8").trim()).toBe(`local ${head}`);
  });
  it("refuses a ref mismatch or dirty tree unless anyRef; +dirty lands in provenance", async () => {
    const { clone, head } = fixtureClone();
    const root = rootWith(localManifest("0f".repeat(20)));
    await expect(
      fetchOpencode({ root, platform: "linux-x64", localDir: clone, noBuild: true }),
    ).rejects.toThrow(/pins 0f0f0f0f0f/);
    writeFileSync(join(clone, "README.md"), "edited\n"); // dirty
    const rootAtHead = rootWith(localManifest(head));
    await expect(
      fetchOpencode({ root: rootAtHead, platform: "linux-x64", localDir: clone, noBuild: true }),
    ).rejects.toThrow(/uncommitted/);
    const r = await fetchOpencode({ root: rootAtHead, platform: "linux-x64", localDir: clone, noBuild: true, anyRef: true });
    expect(r.source).toBe(`local ${head}+dirty`);
  });
  it("runs the injected build with the manifest version; missing artifact is a hard error", async () => {
    const { clone, head, artifact } = fixtureClone();
    const root = rootWith(localManifest(head));
    const calls: string[] = [];
    const build = (dir: string, version: string) => {
      calls.push(`${dir}@${version}`);
      writeFileSync(artifact, "#!/bin/sh\necho rebuilt\n");
    };
    const r = await fetchOpencode({ root, platform: "linux-x64", localDir: clone, build });
    expect(calls).toEqual([`${clone}@9.9.9`]);
    expect(readFileSync(r.path, "utf8")).toContain("rebuilt");
    rmSync(artifact);
    await expect(
      fetchOpencode({ root, platform: "linux-x64", localDir: clone, build: () => {} }),
    ).rejects.toThrow(/built binary missing/);
  });
  it("manifest-driven local falls back to the pinned release when the clone is absent; explicit --local hard-fails", async () => {
    const { bytes, hash } = fixtureArchive();
    const gone = join(tmpdir(), "oc-no-such-clone");
    const m = { ...localManifest("ab".repeat(20)), repo: undefined, tag: undefined };
    m.platforms["linux-x64"].sha256 = hash;
    const root = rootWith(m);
    const r = await fetchOpencode({ root, platform: "linux-x64", localDir: gone, download: async () => bytes });
    expect(r.skipped).toBe(false);
    expect(r.source).toMatch(/^release /);
    await expect(
      fetchOpencode({ root, platform: "linux-x64", mode: "local", localDir: gone, download: async () => bytes }),
    ).rejects.toThrow(/no local clone/);
  });
});

describe("releaseCoords — fork-mirror pinning", async () => {
  const { releaseCoords, assetUrl } = await import("../scripts/fetch_opencode.mjs");
  const platforms = { "linux-x64": { asset: "opencode-linux-x64.tar.gz", sha256: "a".repeat(64) } };
  it("defaults to upstream at v<version>, public", () => {
    const m = { version: "1.17.3", platforms };
    expect(releaseCoords(m)).toEqual({ repo: "sst/opencode", tag: "v1.17.3", private: false });
    expect(assetUrl(m, "linux-x64")).toBe(
      "https://github.com/sst/opencode/releases/download/v1.17.3/opencode-linux-x64.tar.gz",
    );
  });
  it("repo+tag repoint to the private mirror", () => {
    const m = { version: "1.17.3", repo: "harmoniqs/opencode", tag: "v1.17.3-amicode.1", platforms };
    expect(releaseCoords(m)).toEqual({ repo: "harmoniqs/opencode", tag: "v1.17.3-amicode.1", private: true });
    expect(assetUrl(m, "linux-x64")).toBe(
      "https://github.com/harmoniqs/opencode/releases/download/v1.17.3-amicode.1/opencode-linux-x64.tar.gz",
    );
  });
});
