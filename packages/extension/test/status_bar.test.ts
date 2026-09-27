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

  // #1572 follow-up: deferred activation (chat.autoOpen=false) must not show
  // "(booting)" — no boot was ever triggered, so that label would be a lie.
  it("idle shows a distinct label, not booting", () => {
    const s = statusBarLabel(false, "live", true);
    expect(s.text).toMatch(/idle/i);
    expect(s.text).not.toMatch(/booting/i);
  });
  it("idle overrides serverReady=true too", () => {
    expect(statusBarLabel(true, "live", true).text).toMatch(/idle/i);
  });
});
