import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { checkBuildInfo, pinFromRelease, stampBuildInfo } from "../scripts/opencode_dev.mjs";
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

  it("pins an explicit fork repository when the committed lock defaults to upstream", () => {
    const manifest = { ...RELEASE_LOCK };
    delete (manifest as { repo?: string }).repo;
    const root = rootWith(manifest);
    const seen: string[] = [];
    const download = (repo: string, tag: string, asset: string) => {
      seen.push(`${repo}@${tag}/${asset}`);
      return Buffer.from(asset);
    };

    pinFromRelease({
      root,
      repo: "harmoniqs/opencode",
      tag: "v0.3.4-amicode.23",
      ref: "ef".repeat(20),
      download,
    });

    expect(seen).toEqual([
      "harmoniqs/opencode@v0.3.4-amicode.23/opencode-darwin-arm64.zip",
      "harmoniqs/opencode@v0.3.4-amicode.23/opencode-linux-x64.tar.gz",
    ]);
    expect(loadManifest(root).repo).toBe("harmoniqs/opencode");
  });
});

describe("build provenance (.buildinfo)", () => {
  const amicodeRoot = join(fileURLToPath(import.meta.url), "..", "..", "..");

  it("stamps fork branch+commit next to the vendored binary", () => {
    const root = mkdtempSync(join(tmpdir(), "ocdev-"));
    const dir = join(root, "vendor", "opencode", "linux-x64");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "opencode"), "fake-binary");

    stampBuildInfo({ source: "local", repo: "harmoniqs/opencode", version: "1.18.10", cloneDir: amicodeRoot, root });

    const info = JSON.parse(readFileSync(join(dir, ".buildinfo"), "utf8"));
    expect(info.source).toBe("local");
    expect(info.repo).toBe("harmoniqs/opencode");
    expect(info.version).toBe("1.18.10");
    // A real branch name, or the honest detached/unknown fallbacks — CI checks
    // out the merge ref, so the stamp there comes from GITHUB_HEAD_REF/GITHUB_REF_NAME.
    expect(info.branch).toMatch(/^(?:[a-zA-Z0-9_./-]+|\(unknown\)|\(detached\))$/);
    expect(info.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof info.dirty).toBe("boolean");
    expect(info.builtAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("skips dirs without a binary and survives a missing vendor dir", () => {
    const root = mkdtempSync(join(tmpdir(), "ocdev-"));
    expect(() => stampBuildInfo({ source: "release", version: "1.18.10", root })).not.toThrow();
    mkdirSync(join(root, "vendor", "opencode", "darwin-arm64"), { recursive: true }); // no binary inside
    stampBuildInfo({ source: "release", version: "1.18.10", root });
    expect(checkBuildInfo(root)).toMatch(/no vendored binary|darwin-arm64/);
  });

  it("checkBuildInfo reports release stamps too", () => {
    const root = mkdtempSync(join(tmpdir(), "ocdev-"));
    const dir = join(root, "vendor", "opencode", "linux-x64");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "opencode"), "fake-binary");
    stampBuildInfo({ source: "release", repo: "harmoniqs/opencode", version: "1.18.10", tag: "v1.18.10-amicode.4", root });
    expect(checkBuildInfo(root)).toContain("v1.18.10-amicode.4");
  });
});

describe("assert_ui_gate.sh", () => {
  // #823 re-based the gate's invariants for the M3 cutover: the framed app
  // comes from the service's SHELF (the app-bundle dist), so "the ENGINE's
  // embedded UI shows amicode surfaces" is no longer the contract. What the
  // vendored ENGINE must guarantee now: (1) it IS the pinned build — its
  // `--version` equals the lock's version; (2) it carries the `auth_token`
  // carrier machinery — the framed path's bootstrap seam (the panel iframe's
  // credential-less document GET, and the split-frame/websocket paths, all
  // ride ?auth_token=). These tests build the lock+vendor tree shape the
  // script resolves (fixture binaries are shell scripts).
  const script = fileURLToPath(new URL("../scripts/assert_ui_gate.sh", import.meta.url));

  /** The vendor tree shape: <root>/opencode.lock.json +
   *  <root>/vendor/opencode/<platform>/opencode (a fake that prints `version`
   *  on --version and otherwise contains `body`). `platform` defaults to THIS
   *  machine's (so the same-arch version check always fires); pass a foreign
   *  name to exercise the honest skip. */
  const fixture = (
    version: string,
    body: string,
    opts: { lockVersion?: string; platform?: string } = {},
  ): { bin: string; root: string } => {
    const platform = opts.platform ?? `${process.platform}-${process.arch}`;
    const root = mkdtempSync(join(tmpdir(), "gate-"));
    const dir = join(root, "vendor", "opencode", platform);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(root, "opencode.lock.json"),
      JSON.stringify({ version: opts.lockVersion ?? version, source: "release", platforms: {} }),
    );
    const f = join(dir, "opencode");
    writeFileSync(f, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi\n# ${body}\n`);
    chmodSync(f, 0o755);
    return { bin: f, root };
  };
  const run = (bin: string) => execFileSync("bash", [script, bin], { encoding: "utf8" });

  it("passes when the binary is the pinned build AND carries the auth_token carrier", () => {
    const { bin } = fixture("1.18.29", 'const AUTH_TOKEN_QUERY = "auth_token"');
    const out = run(bin);
    expect(out).toMatch(/pinned build \(1\.18\.29\)/);
    expect(out).toMatch(/auth_token/);
  });
  it("fails closed when the binary reports a version the lock does not pin", () => {
    const { bin } = fixture("1.18.10", 'const AUTH_TOKEN_QUERY = "auth_token"', { lockVersion: "1.18.29" });
    expect(() => run(bin)).toThrow();
  });
  it("fails closed when the auth_token carrier machinery is absent (the framed path would 401)", () => {
    const { bin } = fixture("1.18.29", "nothing relevant here");
    expect(() => run(bin)).toThrow();
  });
  it("fails when there is no lock beside the vendor tree (an unmoored binary)", () => {
    const { bin, root } = fixture("1.18.29", "auth_token machinery");
    rmSync(join(root, "opencode.lock.json"));
    expect(() => run(bin)).toThrow();
  });
  it("a foreign-arch binary skips the version re-assertion honestly (the sha download gate holds the pin) but the carrier grep still applies", () => {
    // "win32-x64" never matches a runner platform mapping — deterministic on
    // every machine. The version is deliberately WRONG: the skip means the
    // gate does not execute a foreign binary; the auth_token grep still runs.
    const ok = fixture("9.9.9", 'const AUTH_TOKEN_QUERY = "auth_token"', {
      platform: "win32-x64",
      lockVersion: "1.18.29",
    });
    expect(run(ok.bin)).toMatch(/foreign-arch/);
    const noCarrier = fixture("1.18.29", "nothing relevant here", { platform: "win32-x64" });
    expect(() => run(noCarrier.bin)).toThrow();
  });
});
