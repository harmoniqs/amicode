import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAmicoRunBinDir, resolveRunsRoot, inspectorResourceRootDirs } from "../src/opencode_paths";

describe("resolveAmicoRunBinDir", () => {
  it("prefers the staged bin/launcher when present (packaged VSIX)", () => {
    const ext = mkdtempSync(join(tmpdir(), "ext-"));
    mkdirSync(join(ext, "bin", "launcher"), { recursive: true });
    writeFileSync(join(ext, "bin", "launcher", "amico-run"), "#!/usr/bin/env bash\n");
    expect(resolveAmicoRunBinDir(ext)).toBe(join(ext, "bin", "launcher"));
  });
  it("falls back to the workspace sibling launcher (dev Extension Host)", () => {
    const pkgs = mkdtempSync(join(tmpdir(), "pkgs-"));
    const ext = join(pkgs, "extension");
    mkdirSync(ext, { recursive: true });
    const sib = join(pkgs, "amico-run", "launcher");
    mkdirSync(sib, { recursive: true });
    writeFileSync(join(sib, "amico-run"), "#!/usr/bin/env bash\n");
    expect(resolveAmicoRunBinDir(ext)).toBe(sib);
  });
  it("returns undefined when neither exists", () => {
    expect(resolveAmicoRunBinDir(mkdtempSync(join(tmpdir(), "none-")))).toBeUndefined();
  });
});

describe("resolveRunsRoot", () => {
  it("defaults to ~/.amico/runs/default computed via homedir", () => {
    expect(resolveRunsRoot("")).toBe(join(homedir(), ".amico", "runs", "default"));
  });
  it("expands a leading ~ in a configured value", () => {
    expect(resolveRunsRoot("~/custom/runs")).toBe(join(homedir(), "custom", "runs"));
  });
  it("passes an absolute path through", () => {
    expect(resolveRunsRoot("/var/runs")).toBe("/var/runs");
  });
});

describe("inspectorResourceRootDirs", () => {
  it("grants extension assets only — no run-dir roots (the view renders from message data)", () => {
    const roots = inspectorResourceRootDirs("/ext");
    expect(roots).toEqual(["/ext/dist", "/ext/media"]);
  });
});
