// #2180: a slow suite that skips must say why, instead of vanishing silently.
import { describe, it, expect, vi } from "vitest";
import { slowSkipReason, gateSlowSuite } from "./slow_gate";

describe("slow-suite env gate (#2180)", () => {
  it("has no skip reason when every required var is set", () => {
    expect(slowSkipReason({ AMICO_TEST_JULIA_PROJECT: "/p" }, ["AMICO_TEST_JULIA_PROJECT"])).toBeNull();
  });

  it("names every missing var and how to supply it", () => {
    const reason = slowSkipReason({}, ["AMICO_TEST_JULIA_PROJECT", "AMICO_TEST_REHEARSAL_PROJECT"]);
    expect(reason).toMatch(/AMICO_TEST_JULIA_PROJECT/);
    expect(reason).toMatch(/AMICO_TEST_REHEARSAL_PROJECT/);
  });

  it("treats an empty value as missing", () => {
    expect(slowSkipReason({ AMICO_TEST_JULIA_PROJECT: "" }, ["AMICO_TEST_JULIA_PROJECT"])).not.toBeNull();
  });

  it("logs the reason when it skips, and reports run=false", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const gate = gateSlowSuite("slow: demo", ["AMICO_TEST_JULIA_PROJECT"], {});
    expect(gate.run).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/slow: demo.*skipped.*AMICO_TEST_JULIA_PROJECT/s));
    warn.mockRestore();
  });

  it("stays quiet and reports run=true when the env is supplied", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const gate = gateSlowSuite("slow: demo", ["AMICO_TEST_JULIA_PROJECT"], { AMICO_TEST_JULIA_PROJECT: "/p" });
    expect(gate.run).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
