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

// #1571 — the stale-engine notice (#1190) is a one-shot toast; while the
// engine is stale the status bar must carry a PERSISTENT indicator.
describe("statusBarLabel — stale-engine indicator (#1571)", () => {
  it("a stale engine is flagged in the text and the tooltip offers the restart", () => {
    const s = statusBarLabel(true, "live", undefined, "engine binary");
    expect(s.text).toMatch(/stale/i);
    expect(s.text).toMatch(/\$\(warning\)/);
    expect(s.tooltip).toMatch(/engine binary/);
    expect(s.tooltip).toMatch(/restart/i);
  });
  it("no stale detail leaves the label byte-identical", () => {
    expect(statusBarLabel(true, "live", undefined, undefined)).toEqual(statusBarLabel(true, "live"));
  });
  it("composes with an unhealthy stream and the window mode (all claims preserved)", () => {
    const s = statusBarLabel(true, "stale", "remote-ssh", "config");
    expect(s.text).toMatch(/stream stalled/i);
    expect(s.text).toMatch(/engine stale/i);
    expect(s.tooltip).toMatch(/Remote-SSH/i);
  });
});

describe("StatusBarManager.setEngineStale (#1571)", () => {
  it("shows the indicator and routes the click to the restart; clears back to openChat", async () => {
    const vscodeMock = (await import("vscode")) as unknown as { window: Record<string, unknown> };
    const item: { text: string; tooltip: string; command?: string; backgroundColor?: unknown; show(): void; dispose(): void } = {
      text: "", tooltip: "", show() {}, dispose() {},
    };
    const prev = vscodeMock.window.createStatusBarItem;
    vscodeMock.window.createStatusBarItem = () => item;
    try {
      const { StatusBarManager } = await import("../src/status_bar");
      const m = new StatusBarManager();
      m.setServerReady(true);
      expect(item.text).not.toMatch(/stale/i);
      expect(item.command).toBe("amicode.openChat");
      m.setEngineStale("engine binary");
      expect(item.text).toMatch(/engine stale/i);
      expect(item.command).toBe("amicode.restartStaleEngine");
      m.setEngineStale(undefined);
      expect(item.text).not.toMatch(/stale/i);
      expect(item.command).toBe("amicode.openChat");
    } finally {
      vscodeMock.window.createStatusBarItem = prev;
    }
  });
});
