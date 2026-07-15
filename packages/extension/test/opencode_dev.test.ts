import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { pinFromRelease } from "../scripts/opencode_dev.mjs";
import { loadManifest, sha256 } from "../scripts/fetch_opencode.mjs";

const RELEASE_LOCK = {
  version: "1.17.3",
  repo: "harmoniqs/opencode",
  tag: "v1.17.3-amicode.4",
  source: "release",
  ref: "ab".repeat(20),
  platforms: {
    "darwin-arm64": { asset: "opencode-darwin-arm64.zip", sha256: "11".repeat(32) },
    "linux-x64": { asset: "opencode-linux-x64.tar.gz", sha256: "22".repeat(32) },
  },
};

function rootWith(manifest: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "ocdev-"));
  writeFileSync(join(root, "opencode.lock.json"), JSON.stringify(manifest, null, 2) + "\n");
  return root;
}

describe("committed opencode.lock.json", () => {
  it("defaults vendoring to `release` — a plain install needs no clone/bun", () => {
    const m = loadManifest(); // real packages/extension root
    expect(m.source ?? "release").toBe("release");
  });
});

describe("pinFromRelease", () => {
  it("downloads each platform asset, stamps the ACTUAL sha, sets tag+ref, rewrites the lock", () => {
    const root = rootWith(RELEASE_LOCK);
    const bytesFor = (asset: string) => Buffer.from(`fake-binary-for-${asset}`);
    const seen: string[] = [];
    const download = (repo: string, tag: string, asset: string) => {
      seen.push(`${repo}@${tag}/${asset}`);
      return bytesFor(asset);
    };
    const r = pinFromRelease({ root, tag: "v1.17.3-amicode.5", ref: "cd".repeat(20), download });

    expect(seen).toEqual([
      "harmoniqs/opencode@v1.17.3-amicode.5/opencode-darwin-arm64.zip",
      "harmoniqs/opencode@v1.17.3-amicode.5/opencode-linux-x64.tar.gz",
    ]);
    expect(r.tag).toBe("v1.17.3-amicode.5");
    expect(r.ref).toBe("cd".repeat(20));
    expect(r.platforms["linux-x64"]).toBe(sha256(bytesFor("opencode-linux-x64.tar.gz")));

    // persisted, re-parseable, and still schema-valid
    const written = readFileSync(join(root, "opencode.lock.json"), "utf8");
    expect(written.endsWith("\n")).toBe(true);
    const m = loadManifest(root);
    expect(m.tag).toBe("v1.17.3-amicode.5");
    expect(m.platforms["darwin-arm64"].sha256).toBe(sha256(bytesFor("opencode-darwin-arm64.zip")));
  });

  it("requires a tag and rejects a non-40-hex ref", () => {
    const root = rootWith(RELEASE_LOCK);
    expect(() => pinFromRelease({ root, download: () => Buffer.from("x") })).toThrow(/tag is required/);
    expect(() => pinFromRelease({ root, tag: "v1", ref: "nope", download: () => Buffer.from("x") })).toThrow(/40-hex/);
  });
});

describe("assert_ui_gate.sh", () => {
  const script = fileURLToPath(new URL("../scripts/assert_ui_gate.sh", import.meta.url));
  const fixture = (content: string): string => {
    const f = join(mkdtempSync(join(tmpdir(), "gate-")), "opencode");
    writeFileSync(f, content);
    chmodSync(f, 0o755);
    return f;
  };
  const run = (bin: string) => execFileSync("bash", [script, bin], { encoding: "utf8" });

  it("passes when the gate default is ON (VAR=!0)", () => {
    const out = run(fixture("x=general?.newLayoutDesigns,RG);more;RG=!0;end"));
    expect(out).toMatch(/gate ON/);
  });
  it("fails closed when the gate default is OFF (VAR=!1)", () => {
    expect(() => run(fixture("x=general?.newLayoutDesigns,RG);more;RG=!1;end"))).toThrow();
  });
  it("fails when the gate pattern is absent (minifier drift)", () => {
    expect(() => run(fixture("nothing relevant here"))).toThrow();
  });
});
