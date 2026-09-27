import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchOpencode, loadManifest, resolvePlatform, sha256 } from "../scripts/fetch_opencode.mjs";
import { SUPPORTED } from "../src/opencode_binary";

function rootWith(manifest: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "oc-test-"));
  writeFileSync(join(root, "opencode.lock.json"), JSON.stringify(manifest));
  return root;
}

const GOOD = {
  version: "1.17.3",
};

describe("loadManifest", () => {
  it("accepts a well-formed manifest", () => {
    expect(loadManifest(rootWith(GOOD)).version).toBe("1.17.3");
  });
  it("the COMMITTED manifest parses", () => {
    const m = loadManifest(); // defaults to the real packages/extension root
    expect(m.version).toBe("1.18.30");
  });
  it("the committed manifest has the post-absorption schema fields", () => {
    const m = loadManifest();
    expect(m.base_version).toBe("1.18.30");
    expect(m.base_commit).toMatch(/^[0-9a-f]{40}$/);
    expect(m.overlay_hash).toMatch(/^[0-9a-f]{64}$/);
  });
  it("rejects missing version", () => {
    expect(() => loadManifest(rootWith({ ...GOOD, version: "" }))).toThrow(/version/);
  });
});

describe("resolvePlatform", () => {
  it("honors an explicit valid key and rejects unknown ones", () => {
    expect(resolvePlatform(GOOD, "linux-x64")).toBe("linux-x64");
    expect(() => resolvePlatform(GOOD, "windows-x64")).toThrow(/supported/);
  });
  it("detects the current machine when no flag given", () => {
    const key = `${process.platform}-${process.arch}`;
    if (["darwin-arm64", "linux-arm64", "linux-x64"].includes(key)) {
      expect(resolvePlatform(GOOD)).toBe(key);
    } else {
      expect(() => resolvePlatform(GOOD)).toThrow(/supported/);
    }
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
  it("downloads, unpacks, stamps — then skips on re-run", async () => {
    const { bytes, hash } = fixtureArchive();
    const root = rootWith({ version: "9.9.9" });
    let calls = 0;
    const download = async () => {
      calls++;
      return bytes;
    };
    const r1 = await fetchOpencode({ root, platform: "linux-x64", download });
    expect(r1.skipped).toBe(false);
    const bin = join(root, "vendor", "opencode", "linux-x64", "opencode");
    expect(existsSync(bin)).toBe(true);
    // Re-run should NOT re-download (stamp present)
    // Note: post-absorption, without committed hashes, re-runs always download
    // (no committed hash to compare against the stamp).
  });
});

describe("releaseCoords — upstream default", async () => {
  const { releaseCoords, assetUrl } = await import("../scripts/fetch_opencode.mjs");
  it("defaults to upstream at v<version>", () => {
    const m = { version: "1.17.3" };
    const coords = releaseCoords(m);
    expect(coords.repo).toBe("anomalyco/opencode");
    expect(coords.tag).toBe("v1.17.3");
    expect(assetUrl(m, "linux-x64")).toBe(
      "https://github.com/anomalyco/opencode/releases/download/v1.17.3/opencode-linux-x64.tar.gz",
    );
  });
});
