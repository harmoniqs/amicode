import { describe, it, expect } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveOpencodeBinary, OpencodeMissingError } from "../src/opencode_binary";

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
