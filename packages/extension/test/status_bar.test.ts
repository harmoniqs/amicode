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

// "Am I burning cloud credits right now?" is a status-bar question: it is the one
// surface visible with the Inspector closed. A cloud run and a local run used to
// render an identical label.
describe("statusBarLabel names Harmoniqs Cloud while a cloud run is in flight", () => {
  it("running on cloud carries the cloud icon and still shows iter N", () => {
    const { text, tooltip } = statusBarLabel(true, run("running", { latestIter: 42, cloud: true }));
    expect(text).toContain("$(cloud)");
    expect(text).toContain("42"); // the location is additive — it never costs the progress
    expect(tooltip).toMatch(/Harmoniqs Cloud/);
  });

  it("a cloud run that is still queued says queued, not warming", () => {
    // "warming" describes Julia precompiling locally, which is exactly what does
    // NOT happen on the cloud tier (the runner image is pre-baked) — so the local
    // word would be a lie about where the wait is coming from.
    const { text, tooltip } = statusBarLabel(true, run("starting", { cloud: true }));
    expect(text).toMatch(/queued/i);
    expect(text).not.toMatch(/warming/i);
    expect(tooltip).toMatch(/Harmoniqs Cloud/);
  });

  it("a LOCAL run is byte-identical to before — no cloud chrome anywhere", () => {
    expect(statusBarLabel(true, run("running", { latestIter: 42 })).text).toBe(
      "$(gear~spin) Amicode · iter 42",
    );
    expect(statusBarLabel(true, run("starting")).text).toBe("$(sync~spin) Amicode · warming…");
  });

  it("once a cloud run finishes, its OUTCOME is the story — no lingering badge", () => {
    // The badge answers "where is this running"; a finished run isn't running.
    const { text } = statusBarLabel(true, run("completed", { fidelity: 0.9993, cloud: true }));
    expect(text).toContain("0.9993");
    expect(text).not.toContain("$(cloud)");
  });
});
