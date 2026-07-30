import { describe, it, expect } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveOpencodeBinary, OpencodeMissingError, unsupportedHostAdvice } from "../src/opencode_binary";

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
