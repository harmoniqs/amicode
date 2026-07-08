import { describe, it, expect } from "vitest";
import { controlEnablement } from "../media/ui/control-state";

describe("controlEnablement", () => {
  it("idle: nothing actionable", () => {
    expect(controlEnablement("idle", false)).toEqual({ stop: false, save: false, open: false });
  });
  it("warming: stop enabled, save not yet, open yes", () => {
    expect(controlEnablement("warming", false)).toEqual({ stop: true, save: false, open: true });
  });
  it("running with data: stop + save + open", () => {
    expect(controlEnablement("running", true)).toEqual({ stop: true, save: true, open: true });
  });
  it("completed: save enabled (terminal), stop off", () => {
    expect(controlEnablement("completed", false)).toEqual({ stop: false, save: true, open: true });
  });
  it("stopped: save enabled (partial pulse), stop off", () => {
    expect(controlEnablement("stopped", false)).toEqual({ stop: false, save: true, open: true });
  });
  it("failed with no data: open only", () => {
    expect(controlEnablement("failed", false)).toEqual({ stop: false, save: false, open: true });
  });
  it("failed after some data: save allowed (partial pulse may exist)", () => {
    expect(controlEnablement("failed", true)).toEqual({ stop: false, save: true, open: true });
  });
});
