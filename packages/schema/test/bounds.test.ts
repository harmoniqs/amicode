// $defs.bounds + validateBounds — the WarrantBounds contract the spec-review `budget`
// lens reads. Exists so the lens checks an authored budget against the SHIPPED bound
// vocabulary rather than a prose restatement: the drift that let the long-removed
// `max_duration` into a spec example (plan-20260728 Task 1).
import { describe, it, expect } from "vitest";
import { validateBounds } from "../src/index.js";

describe("validateBounds", () => {
  it("accepts every legal key", () => {
    expect(validateBounds({ max_solves: 8, tier: "free", max_size_class: "MEDIUM", device: "none" }).ok).toBe(true);
  });
  it("accepts an empty object (every bound optional)", () => {
    expect(validateBounds({}).ok).toBe(true);
  });
  it("REJECTS max_duration — removed by G-8, and the exact key a spec author reaches for", () => {
    const r = validateBounds({ max_duration: "30m" });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/max_duration/);
  });
  it("rejects an out-of-enum size class", () => {
    expect(validateBounds({ max_size_class: "LARGE" }).ok).toBe(false);
  });
  it("rejects a non-integer max_solves", () => {
    expect(validateBounds({ max_solves: 1.5 }).ok).toBe(false);
  });
});
