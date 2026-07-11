// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import * as vscode from "vscode";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createDeviceInspectorView } from "../media/ui/views/device_inspector";
import { registerDeviceInspector, revealDeviceInspector, DEVICE_INSPECTOR_CONTEXT_KEY } from "../src/device_inspector";
import type { DeviceStatus, NextAction } from "../src/device_status";

// C4/C5 — the device view IS unit-tested here (happy-dom, mirroring
// inspector_webview_view.test.ts + inspector_view_contract.test.ts): the
// device-keyed pane router, locked-qilc rendering, the shell⇄view CSP seam, and
// host buffering / replay-on-reopen.

const status = (rollup: DeviceStatus["qubits"]): DeviceStatus => ({
  driveLines: [
    { id: "ch0", target: "Q1", kind: "drive", online: true },
    { id: "ch2", target: "Q2", kind: "drive", online: false },
  ],
  qubits: rollup,
  metrics: { T1: { value: 55.2, ts: "2026-07-06T21:00:00Z", ageSeconds: 3600, status: "calibrated", node: "T1" } },
  calibrationParams: { pi_amp: 0.031 },
  nodes: [],
});

const lockedAction: NextAction = {
  node: "cz_gate",
  recommendedNode: "cz_gate_standard",
  status: "uncharacterized",
  action: "calibrate",
  impl: "qilc",
  locked: true,
  reason: "qilc calibration locked (unentitled) → fall back to 'cz_gate_standard'",
};
const openAction: NextAction = {
  node: "pi_amp",
  recommendedNode: "pi_amp",
  status: "stale",
  action: "check",
  impl: "standard",
  locked: false,
  reason: "stale",
};

const panes = (v: { el: HTMLElement }) => [...v.el.querySelectorAll(".device-pane")];
const activePane = (v: { el: HTMLElement }) => v.el.querySelector(".device-pane.active");
const nameOf = (pane: Element | null | undefined) => pane?.querySelector(".device-name")?.textContent;

describe("Device Inspector view router (device-keyed panes)", () => {
  it("activate shows exactly one pane and hides the empty-state hint", () => {
    const v = createDeviceInspectorView(() => {});
    const emptyHint = v.el.firstElementChild as HTMLElement;
    expect(emptyHint.style.display).not.toBe("none");

    v.onMessage({ type: "device-status", device: "snowbird", status: status([{ qubit: "Q1", status: "suspect", nodeCount: 3 }]) });
    v.onMessage({ type: "device-status", device: "multimode", status: status([{ qubit: "Q1", status: "calibrated", nodeCount: 2 }]) });
    expect(panes(v)).toHaveLength(2);
    expect(v.el.querySelectorAll(".device-pane.active")).toHaveLength(0);

    v.onMessage({ type: "activate", device: "snowbird" });
    expect(v.el.querySelectorAll(".device-pane.active")).toHaveLength(1);
    expect(nameOf(activePane(v))).toContain("snowbird");
    expect(emptyHint.style.display).toBe("none");
  });

  it("a background device's status never mutates the active pane (no cross-talk)", () => {
    const v = createDeviceInspectorView(() => {});
    v.onMessage({ type: "activate", device: "snowbird" });
    v.onMessage({ type: "device-status", device: "snowbird", status: status([{ qubit: "Q1", status: "suspect", nodeCount: 3 }]) });
    const active = activePane(v)!;
    expect(nameOf(active)).toContain("snowbird");
    // multimode arrives in the background — its own pane, not snowbird's.
    v.onMessage({ type: "device-status", device: "multimode", status: status([{ qubit: "Q1", status: "calibrated", nodeCount: 2 }]) });
    expect(nameOf(activePane(v))).toContain("snowbird");
    expect(panes(v)).toHaveLength(2);
  });

  it("renders drive-line online/offline chips and a locked qilc action greyed", () => {
    const v = createDeviceInspectorView(() => {});
    v.onMessage({ type: "activate", device: "snowbird" });
    v.onMessage({ type: "device-status", device: "snowbird", status: status([{ qubit: "Q1", status: "suspect", nodeCount: 3 }]) });
    v.onMessage({ type: "actions", device: "snowbird", actions: [openAction, lockedAction] });
    const pane = activePane(v)!;
    // drive-line online state is visible
    expect(pane.querySelectorAll(".drive-line.online").length).toBe(1);
    expect(pane.querySelectorAll(".drive-line.offline").length).toBe(1);
    // the qilc action is rendered locked/greyed; the standard one is not
    expect(pane.querySelectorAll(".action.locked").length).toBe(1);
    expect(pane.querySelector(".action.locked")?.textContent).toContain("cz_gate");
    // honesty: T1 metric present with its value
    expect(pane.textContent).toContain("55.2");
  });
});

// --- Host shell contract + buffering (mirrors inspector_view_contract.test.ts) ---

const PKG_ROOT = join(__dirname, "..");

function makeView() {
  const posted: Array<Record<string, unknown>> = [];
  let disposeCb: () => void = () => undefined;
  let capturedHtml = "";
  const view = {
    webview: {
      options: {},
      cspSource: "vscode-webview://unit",
      asWebviewUri: (u: { fsPath?: string }) => ({ toString: () => "vscode-webview://unit/" + (u?.fsPath ?? String(u)) }),
      postMessage: (m: Record<string, unknown>) => { posted.push(m); },
      onDidReceiveMessage: () => ({ dispose() {} }),
      set html(v: string) { capturedHtml = v; },
      get html() { return capturedHtml; },
    },
    onDidDispose: (cb: () => void) => { disposeCb = cb; return { dispose() {} }; },
  };
  return { view, posted, dispose: () => disposeCb(), html: () => capturedHtml };
}

function harness() {
  const ctx = { extensionUri: { fsPath: PKG_ROOT }, subscriptions: [] as unknown[] };
  return registerDeviceInspector(ctx as never);
}

describe("Device Inspector shell contract (plumbing ⇄ TS-composed view)", () => {
  it("links brand.css + layout.css + the device view bundle under a nonce'd CSP", () => {
    const inspector = harness();
    const v = makeView();
    inspector.resolveWebviewView(v.view as never);
    const html = v.html();
    expect(html).toMatch(/<link[^>]+href="vscode-webview:\/\/unit\/[^"]*brand\.css"/);
    expect(html).toMatch(/<link[^>]+href="vscode-webview:\/\/unit\/[^"]*layout\.css"/);
    expect(html).toMatch(/<script nonce="[^"]+" src="vscode-webview:\/\/unit\/[^"]*device_inspector_webview\.js"/);
    const styleSrc = html.match(/style-src([^;]*)/)?.[1] ?? "";
    expect(styleSrc).toContain("vscode-webview://unit");
    expect(html).toMatch(/script-src 'nonce-/);
    const fontSrc = html.match(/font-src([^;]*)/)?.[1] ?? "";
    expect(fontSrc).toContain("vscode-webview://unit");
  });

  it("design-owned stylesheets exist on disk", () => {
    expect(existsSync(join(PKG_ROOT, "media", "brand.css"))).toBe(true);
    expect(readFileSync(join(PKG_ROOT, "media", "brand.css"), "utf8")).toMatch(/--color-accent/);
  });
});

describe("Device Inspector host buffering (replay-on-reopen, device-keyed)", () => {
  it("buffers status+actions per device pre-materialization and replays them; activate is last", () => {
    const inspector = harness();
    inspector.postDeviceStatus("snowbird", status([{ qubit: "Q1", status: "suspect", nodeCount: 3 }]));
    inspector.postActions("snowbird", [lockedAction]);
    inspector.postDeviceStatus("multimode", status([{ qubit: "Q1", status: "calibrated", nodeCount: 2 }]));
    inspector.activate("snowbird");

    const v = makeView();
    inspector.resolveWebviewView(v.view as never);
    // both devices' status replayed
    expect(v.posted.filter((m) => m.type === "device-status" && m.device === "snowbird")).toHaveLength(1);
    expect(v.posted.filter((m) => m.type === "device-status" && m.device === "multimode")).toHaveLength(1);
    expect(v.posted.filter((m) => m.type === "actions" && m.device === "snowbird")).toHaveLength(1);
    // activate is the last word (names the visible pane)
    expect(v.posted[v.posted.length - 1]).toMatchObject({ type: "activate", device: "snowbird" });
  });

  it("rebuilds every device pane on reopen (dispose → re-resolve replays all)", () => {
    const inspector = harness();
    const a = makeView();
    inspector.resolveWebviewView(a.view as never);
    inspector.postDeviceStatus("snowbird", status([{ qubit: "Q1", status: "suspect", nodeCount: 3 }]));
    inspector.postActions("snowbird", [openAction]);
    inspector.activate("snowbird");
    a.dispose();

    const b = makeView();
    inspector.resolveWebviewView(b.view as never);
    expect(b.posted.filter((m) => m.type === "device-status" && m.device === "snowbird")).toHaveLength(1);
    expect(b.posted.filter((m) => m.type === "actions" && m.device === "snowbird")).toHaveLength(1);
    expect(b.posted[b.posted.length - 1]).toMatchObject({ type: "activate", device: "snowbird" });
  });
});

// --- Open-on-button gate (aligns to #117's run-inspector idiom) ------------
// The view is gated in package.json behind a `when` context key that starts
// false and is never persisted, so VS Code can't restore/auto-open the panel;
// the ONLY reveal path flips the key true then focuses. Mirrors run_inspector's
// INSPECTOR_CONTEXT_KEY / revealInspector, so the device panel is button-only.

describe("Device Inspector open-on-button gate", () => {
  it("revealDeviceInspector flips the reveal context key true, then focuses the view", async () => {
    const calls: Array<{ cmd: string; args: unknown[] }> = [];
    const d1 = vscode.commands.registerCommand("setContext", (...a: unknown[]) => {
      calls.push({ cmd: "setContext", args: a });
    });
    const d2 = vscode.commands.registerCommand("amicode.deviceInspector.focus", (...a: unknown[]) => {
      calls.push({ cmd: "focus", args: a });
    });
    try {
      await revealDeviceInspector();
    } finally {
      d1.dispose();
      d2.dispose();
    }
    // setContext(<key>, true) fires FIRST (allow the gated view), THEN focus.
    expect(calls).toEqual([
      { cmd: "setContext", args: [DEVICE_INSPECTOR_CONTEXT_KEY, true] },
      { cmd: "focus", args: [] },
    ]);
    expect(DEVICE_INSPECTOR_CONTEXT_KEY).toBe("amicode.deviceInspectorRevealed");
  });

  it("package.json gates the deviceInspector view behind the reveal context key", () => {
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"));
    const view = (pkg.contributes.views["amicode-panel"] as Array<{ id: string; when?: string }>).find(
      (v) => v.id === "amicode.deviceInspector",
    );
    expect(view?.when).toBe(DEVICE_INSPECTOR_CONTEXT_KEY);
  });
});
