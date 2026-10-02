import { describe, it, expect } from "vitest";
import { statusBarLabel } from "../src/status_bar";

describe("statusBarLabel", () => {
  it("booting when server not ready", () => {
    expect(statusBarLabel(false).text).toMatch(/booting/i);
  });
  it("ready shows Amicode", () => {
    expect(statusBarLabel(true).text).toMatch(/Amicode/);
  });
  it("ready tooltip mentions chat + Work Column", () => {
    expect(statusBarLabel(true).tooltip).toMatch(/Work Column/i);
  });

  // L1, #638 — honest stream states: "thinking" is never unbacked
  it("live stream shows the normal Amicode state", () => {
    expect(statusBarLabel(true, "live").text).toMatch(/Amicode$/);
  });
  it("stalled stream says so, never 'thinking'", () => {
    const s = statusBarLabel(true, "stale");
    expect(s.text).toMatch(/stream stalled/i);
    expect(s.tooltip).toMatch(/reconnect/i);
  });
  it("dead stream says unreachable and promises the work survives", () => {
    const s = statusBarLabel(true, "dead");
    expect(s.text).toMatch(/unreachable/i);
    expect(s.tooltip).toMatch(/not lost/i);
  });
  it("connecting stream shows an honest spinner", () => {
    expect(statusBarLabel(true, "connecting").tooltip).toMatch(/Connecting/i);
  });
  it("stalled/dead states never override the booting label", () => {
    expect(statusBarLabel(false, "stale").text).toMatch(/booting/i);
    expect(statusBarLabel(false, "dead").text).toMatch(/booting/i);
  });

  // #1272 — window mode surfaced in status (an axis ORTHOGONAL to link-health
  // posture / stream state). Reflected only when Remote-SSH; local / unknown
  // leave the label untouched, and it never uses the posture `standalone` token.
  it("a remote-ssh window mode is reflected in the status (text + tooltip)", () => {
    const s = statusBarLabel(true, "live", "remote-ssh");
    expect(s.text).toMatch(/remote/i);
    expect(s.tooltip).toMatch(/Remote-SSH/i);
  });
  it("a local window mode leaves the label unchanged (no window annotation)", () => {
    const s = statusBarLabel(true, "live", "local");
    expect(s.text).toMatch(/Amicode$/);
    expect(s.text).toEqual(statusBarLabel(true, "live").text); // identical to the no-window-mode label
  });
  it("the window reflection never emits the link-health `standalone` token (AC1)", () => {
    const s = statusBarLabel(true, "live", "remote-ssh");
    expect(s.text).not.toMatch(/standalone/i);
    expect(s.tooltip).not.toMatch(/standalone/i);
  });
  it("the window reflection composes with an unhealthy stream (still says stalled, plus remote)", () => {
    const s = statusBarLabel(true, "stale", "remote-ssh");
    expect(s.text).toMatch(/stream stalled/i); // stream honesty preserved
    expect(s.tooltip).toMatch(/Remote-SSH/i); // window mode still reflected
  });
});
