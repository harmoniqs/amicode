// fleet_version_skew.test.ts (@amicode/schema) — #1319: the pure version-skew
// verdict is HOISTED here from the extension so `amico fleet enroll` (in
// @amicode/amico-run, which cannot import the extension) can reuse it for the
// enroll-time pin check (AC4). This pins the SHARED contract: the same pure
// verdict the extension's relay-start gate consumes now lives at the
// cross-package home, and the extension re-exports it (its own suite is the
// regression guard on that re-export).
import { describe, it, expect } from "vitest";
import { versionSkewVerdict, type SkewTolerance, type VersionSkewVerdict } from "../src/index.js";

describe("versionSkewVerdict — hoisted to @amicode/schema (#1319 AC4 reuse)", () => {
  it("is exported from @amicode/schema and agrees within the default (minor) tolerance", () => {
    const v: VersionSkewVerdict = versionSkewVerdict("v1.18.29", "v1.18.30");
    expect(v.agree).toBe(true);
    expect(v.tolerance).toBe("minor");
  });

  it("refuses a major-version disagreement, naming both versions actionably (never a bare timeout)", () => {
    const v = versionSkewVerdict("v1.18.29", "v2.0.0");
    expect(v.agree).toBe(false);
    expect(v.reason).toContain("1.18.29");
    expect(v.reason).toContain("2.0.0");
  });

  it("honors the selectable tolerance the enroll pin check passes", () => {
    const exact: SkewTolerance = "exact";
    expect(versionSkewVerdict("v1.18.29", "v1.18.30", exact).agree).toBe(false);
    expect(versionSkewVerdict("v1.18.29", "v1.19.0", "major").agree).toBe(true);
  });

  it("falls back to strict string equality for unparseable versions (never a false agree)", () => {
    expect(versionSkewVerdict("dev", "dev").agree).toBe(true);
    expect(versionSkewVerdict("dev", "v1.18.29").agree).toBe(false);
  });
});
