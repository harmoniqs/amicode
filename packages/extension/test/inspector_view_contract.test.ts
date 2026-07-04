import { afterEach, describe, it, expect, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { registerRunInspector } from "../src/run_inspector";

// Pins the shell⇄view seam after the 2026-07-01 rewrite: the view is
// TS-composed (media/ui/views/inspector.ts — it builds its own DOM and injects
// atom/component styles via constructable stylesheets), so the old static-id
// markup contract is gone. What remains load-bearing, and is pinned here:
//   1. the shell links brand.css + layout.css and the dist view bundle;
//   2. the CSP authorizes every grant the view depends on;
//   3. the design-owned stylesheets exist and brand.css carries the brand token.
// The message protocol (runlabel/iteration/warming/completed/refresh/ping) is
// exercised end-to-end by the watcher tests; ids/classes are now internal to
// the view and free to change.

const PKG_ROOT = join(__dirname, "..");

function renderInspectorHtml(): string {
  const ctx = { extensionUri: { fsPath: PKG_ROOT }, subscriptions: [] as unknown[] };
  const inspector = registerRunInspector(ctx as never);
  let captured = "";
  const view = {
    webview: {
      options: {},
      cspSource: "vscode-webview://unit",
      asWebviewUri: (u: { fsPath?: string }) => ({ toString: () => "vscode-webview://unit/" + (u?.fsPath ?? String(u)) }),
      postMessage: () => undefined,
      onDidReceiveMessage: () => ({ dispose() {} }),
      set html(v: string) { captured = v; },
      get html() { return captured; },
    },
    onDidDispose: () => ({ dispose() {} }),
  };
  inspector.resolveWebviewView(view as never);
  return captured;
}

describe("Run Inspector shell contract (plumbing ⇄ TS-composed view)", () => {
  const html = renderInspectorHtml();

  it("links the design-owned stylesheets and the view bundle", () => {
    expect(html).toMatch(/<link[^>]+rel="stylesheet"[^>]+href="vscode-webview:\/\/unit\/[^"]*brand\.css"/);
    expect(html).toMatch(/<link[^>]+rel="stylesheet"[^>]+href="vscode-webview:\/\/unit\/[^"]*layout\.css"/);
    expect(html).toMatch(/<script nonce="[^"]+" src="vscode-webview:\/\/unit\/[^"]*inspector_webview\.js"/);
  });

  it("keeps the CSP authorizing every grant the view depends on", () => {
    // Pin grants to their directive, not just "appears somewhere in the CSP".
    const styleSrc = html.match(/style-src([^;]*)/)?.[1] ?? "";
    expect(styleSrc, "style-src must grant the webview source for the linked stylesheets").toContain("vscode-webview://unit");
    expect(styleSrc, "style-src keeps 'unsafe-inline' for design-lane static style attrs").toContain("'unsafe-inline'");

    expect(html, "no image grants — the view renders from message data (#66)").not.toMatch(/img-src/);
    expect(html).toMatch(/script-src 'nonce-/);
  });

  it("design-owned stylesheets exist; brand.css carries the brand token", () => {
    expect(existsSync(join(PKG_ROOT, "media", "layout.css"))).toBe(true);
    const brand = readFileSync(join(PKG_ROOT, "media", "brand.css"), "utf8");
    expect(brand).toMatch(/--color-accent/);
  });
});

// #66 AC7 — pulse events posted before the webview materializes must not be
// lost: the log line is the canonical signal (nothing re-delivers it, unlike
// PNGs which the poll re-offers). The host buffers meta + the NEWEST record
// and replays them on resolve, BEFORE any buffered terminal state.
describe("Run Inspector host buffering (#66 pulse events)", () => {
  const META = { drives: 1, knots: 2, labels: ["a_1"], bounds: [[-0.2, 0.2]] as [number, number][] };

  function harness() {
    const ctx = { extensionUri: { fsPath: PKG_ROOT }, subscriptions: [] as unknown[] };
    const inspector = registerRunInspector(ctx as never);
    const posted: Array<Record<string, unknown>> = [];
    const view = {
      webview: {
        options: {},
        cspSource: "vscode-webview://unit",
        asWebviewUri: (u: { fsPath?: string }) => ({ toString: () => "vscode-webview://unit/" + (u?.fsPath ?? String(u)) }),
        postMessage: (m: Record<string, unknown>) => { posted.push(m); },
        onDidReceiveMessage: () => ({ dispose() {} }),
        set html(_v: string) { /* ignore */ },
        get html() { return ""; },
      },
      onDidDispose: () => ({ dispose() {} }),
    };
    return { inspector, view, posted };
  }

  it("buffers meta + NEWEST record pre-materialization, replays them before a buffered completion", () => {
    const { inspector, view, posted } = harness();
    inspector.postPulse({ type: "meta", meta: META });
    inspector.postPulse({ type: "record", record: { iter: 1, dt: 0.2, values: [[0.1, 0.2]] } });
    inspector.postPulse({ type: "record", record: { iter: 2, dt: 0.2, values: [[0.3, 0.4]] } });
    inspector.postCompletion("completed", 0.9999);
    inspector.resolveWebviewView(view as never);

    const types = posted.map((m) => m.type);
    expect(types).toContain("pulsemeta");
    expect(types.filter((t) => t === "pulse")).toHaveLength(1);            // newest-wins: iter 1 dropped
    expect(posted.find((m) => m.type === "pulse")).toMatchObject({ iter: 2 });
    expect(types.indexOf("pulsemeta")).toBeLessThan(types.indexOf("pulse"));
    expect(types.indexOf("pulse")).toBeLessThan(types.indexOf("completed")); // terminal state stays the last word
  });

  it("throttles live records to the host's 5 Hz policy — trailing edge carries the NEWEST record", () => {
    vi.useFakeTimers();
    const { inspector, view, posted } = harness();
    inspector.resolveWebviewView(view as never);
    inspector.postPulse({ type: "meta", meta: META });
    posted.length = 0;
    inspector.postPulse({ type: "record", record: { iter: 1, dt: 0.2, values: [[0.1, 0.2]] } });
    expect(posted.map((m) => m.type)).toEqual(["pulse"]);                      // leading edge posts immediately
    inspector.postPulse({ type: "record", record: { iter: 2, dt: 0.2, values: [[0.3, 0.4]] } });
    inspector.postPulse({ type: "record", record: { iter: 3, dt: 0.2, values: [[0.5, 0.6]] } });
    expect(posted).toHaveLength(1);                                            // inside the window: coalesced
    vi.advanceTimersByTime(200);
    expect(posted).toHaveLength(2);                                            // trailing edge: exactly one flush
    expect(posted[1]).toMatchObject({ type: "pulse", iter: 3 });               // …carrying the newest
  });

  it("posts straight through once the webview is live", () => {
    const { inspector, view, posted } = harness();
    inspector.resolveWebviewView(view as never);
    posted.length = 0;
    inspector.postPulse({ type: "meta", meta: META });
    inspector.postPulse({ type: "record", record: { iter: 3, dt: 0.2, values: [[0.5, 0.6]] } });
    expect(posted.map((m) => m.type)).toEqual(["pulsemeta", "pulse"]);
  });
});

afterEach(() => { vi.useRealTimers(); });
