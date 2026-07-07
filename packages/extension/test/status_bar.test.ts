import { describe, it, expect } from "vitest";
import { statusBarLabel } from "../src/status_bar";

const run = (status: string, extra: Record<string, unknown> = {}) =>
  ({ runId: "r", outputDir: "/x", startedAt: 0, status, ...extra }) as never;

describe("statusBarLabel", () => {
  it("booting when server not ready", () => {
    expect(statusBarLabel(false).text).toMatch(/booting/i);
  });
  it("warming (starting) shows a spinner + warming", () => {
    expect(statusBarLabel(true, run("starting")).text).toMatch(/warming/i);
  });
  it("running shows iter N", () => {
    expect(statusBarLabel(true, run("running", { latestIter: 42 })).text).toContain("42");
  });
  it("completed shows fidelity", () => {
    expect(statusBarLabel(true, run("completed", { fidelity: 0.9993 })).text).toContain("0.9993");
  });
  it("stopped shows a stopped label", () => {
    expect(statusBarLabel(true, run("stopped")).text).toMatch(/stopped/i);
  });
  it("idle (no run) is the neutral Amicode label", () => {
    expect(statusBarLabel(true, undefined).text).toMatch(/Amicode/);
  });
});

describe("statusBarLabel stalled", () => {
  it("stalled shows a warning label, not a spinner", () => {
    const { text, tooltip } = statusBarLabel(true, run("stalled", { latestIter: 8 }));
    expect(text).toMatch(/stalled/i);
    expect(text).not.toMatch(/spin/);
    expect(tooltip).toMatch(/wedged|10\+ min/i);
  });
});
