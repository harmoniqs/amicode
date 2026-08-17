// The studio reader (#402): one library owns manifest parsing and root
// resolution. Consumers (extension, amico-run, telaio) ask it for paths —
// never re-derive. Absent manifest = the legacy ladder, exactly today's
// behavior. Malformed manifest = throw (field-precise); consumers warn and
// fall back — never brick.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  expandTilde,
  resolveStudioPaths,
  legacyStudioPaths,
  loadStudioBinding,
  type StudioManifest,
} from "../src/studio.js";

const MANIFEST: StudioManifest = {
  schema_version: "1",
  studio_root: "~/armonia",
};

describe("expandTilde", () => {
  it("expands a leading ~ to homedir; leaves absolutes and relatives alone", () => {
    expect(expandTilde("~/x")).toBe(path.join(os.homedir(), "x"));
    expect(expandTilde("/abs/x")).toBe("/abs/x");
    expect(expandTilde("rel/x")).toBe("rel/x");
  });
});

describe("resolveStudioPaths", () => {
  it("derives every root from studio_root when overrides are absent", () => {
    const p = resolveStudioPaths(MANIFEST);
    const root = path.join(os.homedir(), "armonia");
    expect(p.studioRoot).toBe(root);
    expect(p.catalog).toBe(path.join(root, "catalog"));
    expect(p.ledger).toBe(path.join(root, "ledger"));
    expect(p.harness).toBe(path.join(root, "ledger", "harness"));
    expect(p.problems).toBe(path.join(root, "problems"));
    expect(p.runs).toBe(path.join(root, "runs"));
    expect(p.packsExternal).toBe(path.join(root, "packs"));
    expect(p.tenant).toBe("local");
    expect(p.source).toBe("manifest");
  });

  it("explicit overrides win; mounts resolve against vaults_root and keep document order", () => {
    const p = resolveStudioPaths({
      ...MANIFEST,
      vaults_root: "~/armonia/data/vaults",
      vaults: {
        mounts: [
          { name: "v", kind: "personal", mode: "rw", path: "v" },
          { name: "t", kind: "team", mode: "ro", path: "/abs/t" },
        ],
      },
      problems: "~/armonia/data/problems",
    });
    expect(p.problems).toBe(path.join(os.homedir(), "armonia", "data", "problems"));
    expect(p.vaultsRoot).toBe(path.join(os.homedir(), "armonia", "data", "vaults"));
    expect(p.mounts).toHaveLength(2);
    expect(p.mounts[0]).toEqual({
      name: "v", kind: "personal", mode: "rw",
      path: path.join(os.homedir(), "armonia", "data", "vaults", "v"),
    });
    expect(p.mounts[1]!.path).toBe("/abs/t"); // absolute mount paths pass through
  });
});

describe("legacyStudioPaths", () => {
  it("is today's ladder, literally — the ~/.amico paths (symlinks resolve at IO time)", () => {
    const p = legacyStudioPaths();
    expect(p.source).toBe("legacy");
    expect(p.problems).toBe(path.join(os.homedir(), ".amico", "problems"));
    expect(p.runs).toBe(path.join(os.homedir(), ".amico", "runs"));
    expect(p.ledger).toBe(path.join(os.homedir(), ".amico", "ledger"));
    expect(p.harness).toBe(path.join(os.homedir(), ".amico", "harness"));
    expect(p.catalog).toBeNull(); // legacy has NO studio catalog root — doctor flags this drift
  });
});

describe("loadStudioBinding", () => {
  it("returns null when no manifest exists anywhere (parity: legacy exactly)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-"));
    expect(loadStudioBinding(path.join(dir, "config.toml"))).toBeNull();
  });
  it("loads + validates + resolves a present manifest", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-"));
    fs.writeFileSync(path.join(dir, "config.toml"), 'schema_version = "1"\nstudio_root = "~/labs/main"\n');
    const b = loadStudioBinding(path.join(dir, "config.toml"));
    expect(b?.paths.studioRoot).toBe(path.join(os.homedir(), "labs", "main"));
  });
  it("throws field-precise on a malformed manifest (the consumer warns + falls back)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-"));
    fs.writeFileSync(path.join(dir, "config.toml"), 'schema_version = "1"\n'); // no studio_root
    expect(() => loadStudioBinding(path.join(dir, "config.toml"))).toThrow(/studio_root/);
  });
  it("unparsable TOML is a malformed manifest, not a crash", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-"));
    fs.writeFileSync(path.join(dir, "config.toml"), "not [ valid toml");
    expect(() => loadStudioBinding(path.join(dir, "config.toml"))).toThrow(/parse/i);
  });
});
