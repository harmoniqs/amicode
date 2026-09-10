import { describe, it, expect } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveOpencodeBinary, OpencodeMissingError, unsupportedHostAdvice, findForkedOpencodeBinary } from "../src/opencode_binary";

const platformKey = `${process.platform}-${process.arch}`;

function rootWithVendored(): string {
  const root = mkdtempSync(join(tmpdir(), "ocbin-"));
  const dir = join(root, "vendor", "opencode", platformKey);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "opencode"), "#!/bin/sh\n");
  chmodSync(join(dir, "opencode"), 0o755);
  return root;
}

describe("resolveOpencodeBinary", () => {
  it("config override wins, verbatim", () => {
    expect(resolveOpencodeBinary(rootWithVendored(), "/custom/opencode")).toEqual({
      path: "/custom/opencode",
      source: "config-override",
    });
  });
  it("falls through to the vendored binary when config is empty", () => {
    const root = rootWithVendored();
    const r = resolveOpencodeBinary(root, "");
    expect(r.source).toBe("vendored");
    expect(r.path).toBe(join(root, "vendor", "opencode", platformKey, "opencode"));
  });
  it("missing vendored binary → actionable hard error, never $PATH", () => {
    const empty = mkdtempSync(join(tmpdir(), "ocbin-empty-"));
    expect(() => resolveOpencodeBinary(empty, "")).toThrow(OpencodeMissingError);
    expect(() => resolveOpencodeBinary(empty, "")).toThrow(/fetch:opencode|reinstall/);
  });
});

// The Marketplace's binary-less cover packages (win32-*, darwin-x64) exist only to
// stop VS Code resolving those clients down to the last universal version, so the
// advice they surface IS the whole feature — an unactionable string wastes the cover.
describe("unsupportedHostAdvice", () => {
  it("points Windows at WSL, on either arch", () => {
    expect(unsupportedHostAdvice("win32", "x64")).toMatch(/WSL/);
    expect(unsupportedHostAdvice("win32", "arm64")).toMatch(/WSL/);
  });
  it("tells an Intel Mac the build is Apple Silicon only, and names its own arch", () => {
    expect(unsupportedHostAdvice("darwin", "x64")).toMatch(/Apple Silicon/);
    expect(unsupportedHostAdvice("darwin", "x64")).toContain("x64");
  });
  it("names the host and the built set for anything else", () => {
    const advice = unsupportedHostAdvice("freebsd", "x64");
    expect(advice).toContain("freebsd-x64");
    expect(advice).toContain("linux-x64");
  });
});

// #943: dev-tools-update's opencode-path validation and dev-tools-rebuild's
// post-build codesign step each carried their OWN candidate list for finding
// a fork checkout's built binary — dev-tools-update's never checked the
// platform-suffixed dist directory real builds actually produce (so a
// genuinely valid repo path was indistinguishable from a typo), and
// dev-tools-rebuild's own list was darwin-only, missing both Linux targets.
// One shared, SUPPORTED-driven helper for both.
function makeExecutable(path: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "#!/bin/sh\n");
  chmodSync(path, 0o755);
}

describe("findForkedOpencodeBinary", () => {
  it("finds a real build's platform-suffixed binary", () => {
    const root = mkdtempSync(join(tmpdir(), "forkbin-"));
    const bin = join(root, "packages", "opencode", "dist", `opencode-${platformKey}`, "bin", "opencode");
    makeExecutable(bin);
    expect(findForkedOpencodeBinary(root)).toEqual({ found: true, path: bin });
  });

  it("falls back to the legacy unsuffixed layout when no platform-suffixed dir exists", () => {
    const root = mkdtempSync(join(tmpdir(), "forkbin-legacy-"));
    const bin = join(root, "packages", "opencode", "dist", "opencode", "bin", "opencode");
    makeExecutable(bin);
    expect(findForkedOpencodeBinary(root)).toEqual({ found: true, path: bin });
  });

  it("reports not-found when nothing resolves", () => {
    const root = mkdtempSync(join(tmpdir(), "forkbin-empty-"));
    expect(findForkedOpencodeBinary(root)).toEqual({ found: false, reason: "not-found" });
  });

  it("reports not-executable distinctly from not-found", () => {
    const root = mkdtempSync(join(tmpdir(), "forkbin-noexec-"));
    const bin = join(root, "packages", "opencode", "dist", `opencode-${platformKey}`, "bin", "opencode");
    mkdirSync(join(bin, ".."), { recursive: true });
    writeFileSync(bin, "#!/bin/sh\n");
    chmodSync(bin, 0o644); // not executable
    expect(findForkedOpencodeBinary(root)).toEqual({ found: false, reason: "not-executable", path: bin });
  });

  it("an earlier non-executable candidate does not shadow a later valid one (regression)", () => {
    // Before this helper existed, dev-tools-update's inline loop mutated a
    // shared reply object across iterations and never reset opencodeValid
    // back to true once a later candidate succeeded — so a genuinely valid
    // binary could still be reported invalid if an earlier candidate merely
    // existed without the executable bit set.
    const root = mkdtempSync(join(tmpdir(), "forkbin-order-"));
    const badFirst = join(root, "packages", "opencode", "dist", "opencode-darwin-arm64", "bin", "opencode");
    mkdirSync(join(badFirst, ".."), { recursive: true });
    writeFileSync(badFirst, "#!/bin/sh\n");
    chmodSync(badFirst, 0o644); // exists, but not executable — should not win
    const goodSecond = join(root, "packages", "opencode", "dist", "opencode-linux-arm64", "bin", "opencode");
    makeExecutable(goodSecond);
    expect(findForkedOpencodeBinary(root)).toEqual({ found: true, path: goodSecond });
  });

  it("treats the input itself as a direct binary path when it isn't a repo root", () => {
    // The Developer Tools field lets a user point straight at a binary
    // instead of a repo root — preserved from the original candidate list.
    const root = mkdtempSync(join(tmpdir(), "forkbin-direct-"));
    const bin = join(root, "opencode");
    makeExecutable(bin);
    expect(findForkedOpencodeBinary(bin)).toEqual({ found: true, path: bin });
  });
});
