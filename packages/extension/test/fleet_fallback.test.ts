import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { enterFallback, exitFallback, isFallbackActive, readFallback, fallbackPath } from "../src/fleet_fallback";

describe("fleet_fallback", () => {
  let tmp: string;
  let p: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-fallback-"));
    p = path.join(tmp, "fallback.json");
  });
  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  });

  it("enter creates active fallback file", () => {
    const s = enterFallback({ path: p, reason: "mini offline" });
    expect(s.active).toBe(true);
    expect(isFallbackActive(p)).toBe(true);
    const r = readFallback(p);
    expect(r?.reason).toBe("mini offline");
    expect(r?.active).toBe(true);
  });

  it("exit removes fallback file", () => {
    enterFallback({ path: p });
    expect(isFallbackActive(p)).toBe(true);
    const prev = exitFallback(p);
    expect(prev?.active).toBe(true);
    expect(isFallbackActive(p)).toBe(false);
    expect(readFallback(p)).toBe(null);
  });

  it("isFallbackActive false when missing", () => {
    expect(isFallbackActive(p)).toBe(false);
  });

  it("fallbackPath helpers", () => {
    expect(fallbackPath(tmp)).toBe(path.join(tmp, "fallback.json"));
    expect(fallbackPath()).toContain(".amico/ops/fleet/fallback.json");
  });
});
