import { describe, it, expect } from "vitest";
import { parseMaxIter, computeEta, formatElapsed, ratePerSec } from "../src/run_timing";

describe("run_timing", () => {
  it("parseMaxIter reads 'max_iter = N'", () => {
    expect(parseMaxIter("foo\nmax_iter   = 60\nbar")).toBe(60);
    expect(parseMaxIter("max_iter=12")).toBe(12);
    expect(parseMaxIter("no such line")).toBeUndefined();
  });
  it("computeEta = remaining/rate; undefined without max or rate", () => {
    expect(computeEta({ iter: 20, maxIter: 60, ratePerSec: 2 })).toBeCloseTo(20, 5);
    expect(computeEta({ iter: 20, maxIter: undefined, ratePerSec: 2 })).toBeUndefined();
    expect(computeEta({ iter: 20, maxIter: 60, ratePerSec: 0 })).toBeUndefined();
    expect(computeEta({ iter: 70, maxIter: 60, ratePerSec: 2 })).toBe(0); // clamped
  });
  it("formatElapsed → compact m/s", () => {
    expect(formatElapsed(9)).toBe("9s");
    expect(formatElapsed(134)).toBe("2m14s");
    expect(formatElapsed(-5)).toBe("0s");
  });
  it("ratePerSec from arrival timestamps", () => {
    expect(ratePerSec([0, 1000, 2000])).toBeCloseTo(1, 5); // 2 gaps / 2s = 1/s
    expect(ratePerSec([1000])).toBeUndefined();
    expect(ratePerSec([5, 5])).toBeUndefined();
  });
});
