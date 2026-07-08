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
// The message protocol (runId-keyed: runlabel/iteration/warming/completed/
// pulsemeta/pulse/activate/ping) is exercised end-to-end by the watcher tests;
// ids/classes are now internal to the view and free to change.

const PKG_ROOT = join(__dirname, "..");

function renderInspectorHtml(): string {
  const ctx = { extensionUri: { fsPath: PKG_ROOT }, subscriptions: [] as unknown[] };
  const inspector = registerRunInspector(ctx as never);
  let captured = "";
  const view = {
    webview: {
      options: {},
      cspSource: "vscode-webview://unit",
      asWebviewUri: (u: { fsPath?: string }) => ({
        toString: () => "vscode-webview://unit/" + (u?.fsPath ?? String(u)),
      }),
      postMessage: () => undefined,
      onDidReceiveMessage: () => ({ dispose() {} }),
      set html(v: string) {
        captured = v;
      },
      get html() {
        return captured;
      },
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
    expect(styleSrc, "style-src must grant the webview source for the linked stylesheets").toContain(
      "vscode-webview://unit",
    );
    expect(styleSrc, "style-src keeps 'unsafe-inline' for design-lane static style attrs").toContain("'unsafe-inline'");

    expect(html, "no image grants — the view renders from message data (#66)").not.toMatch(/img-src/);
    expect(html).toMatch(/script-src 'nonce-/);

    // font-src must grant the webview source so the JuliaMono @font-face loads
    // (under default-src 'none' a missing font-src silently blocks the fetch).
    const fontSrc = html.match(/font-src([^;]*)/)?.[1] ?? "";
    expect(fontSrc, "font-src must grant the webview source for @font-face").toContain("vscode-webview://unit");
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
// per run and replays them on resolve, BEFORE any buffered terminal state.
//
// 1.3 (#58): every message is runId-keyed. Each run gets its own buffer +
// throttle; resolve replays EVERY pane (S36) and activate names the visible one.
describe("Run Inspector host buffering (#66 pulse events, runId-keyed)", () => {
  const META = { drives: 1, knots: 2, labels: ["a_1"], bounds: [[-0.2, 0.2]] as [number, number][] };
  const rec = (iter: number): { iter: number; dt: number; values: number[][] } => ({
    iter,
    dt: 0.2,
    values: [[iter / 10, iter / 5]],
  });

  function harness() {
    const ctx = { extensionUri: { fsPath: PKG_ROOT }, subscriptions: [] as unknown[] };
    const inspector = registerRunInspector(ctx as never);
    /** Build an independent webview target (its own capture buffer + dispose
     *  hook) — lets a single inspector be resolved twice for the reopen path. */
    const makeView = () => {
      const posted: Array<Record<string, unknown>> = [];
      let disposeCb: () => void = () => undefined;
      const view = {
        webview: {
          options: {},
          cspSource: "vscode-webview://unit",
          asWebviewUri: (u: { fsPath?: string }) => ({
            toString: () => "vscode-webview://unit/" + (u?.fsPath ?? String(u)),
          }),
          postMessage: (m: Record<string, unknown>) => {
            posted.push(m);
          },
          onDidReceiveMessage: () => ({ dispose() {} }),
          set html(_v: string) {
            /* ignore */
          },
          get html() {
            return "";
          },
        },
        onDidDispose: (cb: () => void) => {
          disposeCb = cb;
          return { dispose() {} };
        },
      };
      return { view, posted, dispose: () => disposeCb() };
    };
    const first = makeView();
    return { inspector, makeView, view: first.view, posted: first.posted, dispose: first.dispose };
  }

  it("buffers meta + NEWEST record pre-materialization, replays them (runId-tagged) before a buffered completion", () => {
    const { inspector, view, posted } = harness();
    inspector.postPulse("r1", { type: "meta", meta: META });
    inspector.postPulse("r1", { type: "record", record: rec(1) });
    inspector.postPulse("r1", { type: "record", record: rec(2) });
    inspector.postCompletion("r1", "completed", 0.9999);
    inspector.resolveWebviewView(view as never);

    const r1 = posted.filter((m) => m.runId === "r1");
    expect(r1.every((m) => m.runId === "r1")).toBe(true); // every message carries the runId
    const types = r1.map((m) => m.type);
    expect(types).toContain("pulsemeta");
    expect(types.filter((t) => t === "pulse")).toHaveLength(1); // newest-wins: iter 1 dropped
    expect(r1.find((m) => m.type === "pulse")).toMatchObject({ iter: 2 });
    expect(types.indexOf("pulsemeta")).toBeLessThan(types.indexOf("pulse"));
    expect(types.indexOf("pulse")).toBeLessThan(types.indexOf("completed")); // terminal state stays the last word
  });

  it("throttles live records to the host's 5 Hz policy — trailing edge carries the NEWEST record", () => {
    vi.useFakeTimers();
    const { inspector, view, posted } = harness();
    inspector.resolveWebviewView(view as never);
    inspector.postPulse("r1", { type: "meta", meta: META });
    posted.length = 0;
    inspector.postPulse("r1", { type: "record", record: rec(1) });
    expect(posted.map((m) => m.type)).toEqual(["pulse"]); // leading edge posts immediately
    inspector.postPulse("r1", { type: "record", record: rec(2) });
    inspector.postPulse("r1", { type: "record", record: rec(3) });
    expect(posted).toHaveLength(1); // inside the window: coalesced
    vi.advanceTimersByTime(200);
    expect(posted).toHaveLength(2); // trailing edge: exactly one flush
    expect(posted[1]).toMatchObject({ type: "pulse", iter: 3, runId: "r1" }); // …carrying the newest
  });

  it("posts straight through once the webview is live", () => {
    const { inspector, view, posted } = harness();
    inspector.resolveWebviewView(view as never);
    posted.length = 0;
    inspector.postPulse("r1", { type: "meta", meta: META });
    inspector.postPulse("r1", { type: "record", record: rec(3) });
    expect(posted.map((m) => m.type)).toEqual(["pulsemeta", "pulse"]);
    expect(posted.every((m) => m.runId === "r1")).toBe(true);
  });

  it("keeps a separate pane buffer per run — a background run's record never lands under another runId", () => {
    const { inspector, view, posted } = harness();
    inspector.postPulse("r1", { type: "meta", meta: META });
    inspector.postPulse("r1", { type: "record", record: rec(1) });
    inspector.postPulse("r2", { type: "meta", meta: META });
    inspector.postPulse("r2", { type: "record", record: rec(7) });
    inspector.resolveWebviewView(view as never);

    // r1's pulse is iter 1 under r1; r2's is iter 7 under r2. No cross-key leak.
    expect(posted.filter((m) => m.type === "pulse" && m.runId === "r1")).toMatchObject([{ iter: 1 }]);
    expect(posted.filter((m) => m.type === "pulse" && m.runId === "r2")).toMatchObject([{ iter: 7 }]);
  });

  it("per-run throttle windows are independent — r2's leading edge is not coalesced by r1's open window", () => {
    vi.useFakeTimers();
    const { inspector, view, posted } = harness();
    inspector.resolveWebviewView(view as never);
    posted.length = 0;
    inspector.postPulse("r1", { type: "record", record: rec(1) }); // opens r1's window (posts)
    inspector.postPulse("r2", { type: "record", record: rec(1) }); // r2 has its OWN window (posts)
    expect(posted.filter((m) => m.type === "pulse")).toHaveLength(2);
    expect(posted.map((m) => m.runId).sort()).toEqual(["r1", "r2"]);
  });

  it("activate is replayed LAST on materialize and names the visible pane", () => {
    const { inspector, view, posted } = harness();
    inspector.postPulse("r1", { type: "meta", meta: META });
    inspector.postPulse("r2", { type: "meta", meta: META });
    inspector.activate("r2");
    inspector.resolveWebviewView(view as never);

    const activate = posted.filter((m) => m.type === "activate");
    expect(activate).toHaveLength(1);
    expect(activate[0]).toMatchObject({ runId: "r2" });
    expect(posted.indexOf(activate[0])).toBe(posted.length - 1); // last word = the visible pane
  });

  it("rebuilds EVERY pane on reopen (S36) — dispose then re-resolve replays all runs", () => {
    const { inspector, makeView } = harness();
    const a = makeView();
    inspector.resolveWebviewView(a.view as never);
    inspector.postPulse("r1", { type: "meta", meta: META });
    inspector.postPulse("r1", { type: "record", record: rec(4) });
    inspector.postCompletion("r1", "completed", 0.99);
    inspector.postPulse("r2", { type: "meta", meta: META });
    inspector.postPulse("r2", { type: "record", record: rec(9) });
    inspector.activate("r2");
    a.dispose(); // user closes the panel

    const b = makeView();
    inspector.resolveWebviewView(b.view as never); // reopen — fresh DOM
    // Both panes rebuilt from buffers, each with its newest record, r1 terminal.
    expect(b.posted.filter((m) => m.type === "pulse" && m.runId === "r1")).toMatchObject([{ iter: 4 }]);
    expect(b.posted.filter((m) => m.type === "completed" && m.runId === "r1")).toHaveLength(1);
    expect(b.posted.filter((m) => m.type === "pulse" && m.runId === "r2")).toMatchObject([{ iter: 9 }]);
    expect(b.posted[b.posted.length - 1]).toMatchObject({ type: "activate", runId: "r2" });
  });

  it("setWarmingUp no-ops once the pane has data or terminal state (no clobber of a fanned-in run)", () => {
    const { inspector, view, posted } = harness();
    inspector.resolveWebviewView(view as never);
    inspector.postPulse("r1", { type: "record", record: rec(1) }); // r1 has data
    inspector.postCompletion("r2", "completed", 0.99); // r2 is terminal
    posted.length = 0;
    inspector.setWarmingUp("r1");
    inspector.setWarmingUp("r2");
    inspector.setWarmingUp("r3"); // fresh run → warming IS shown
    expect(posted.filter((m) => m.type === "warming")).toMatchObject([{ runId: "r3" }]);
  });

  it("postTags buffers pre-materialization and replays on resolve, runId-tagged", () => {
    const { inspector, view, posted } = harness();
    inspector.postTags("r1", ["smooth", "fast"]);
    inspector.resolveWebviewView(view as never);
    expect(posted.filter((m) => m.type === "tags")).toMatchObject([{ runId: "r1", tags: ["smooth", "fast"] }]);
  });

  it("postTags posts straight through once the webview is live, per-run isolated", () => {
    const { inspector, view, posted } = harness();
    inspector.resolveWebviewView(view as never);
    posted.length = 0;
    inspector.postTags("r1", ["smooth"]);
    inspector.postTags("r2", ["fast"]);
    expect(posted).toMatchObject([
      { type: "tags", runId: "r1", tags: ["smooth"] },
      { type: "tags", runId: "r2", tags: ["fast"] },
    ]);
  });

  it("postTags survives reopen (S36) — replayed alongside the rest of the pane", () => {
    const { inspector, makeView } = harness();
    const a = makeView();
    inspector.resolveWebviewView(a.view as never);
    inspector.postTags("r1", ["smooth"]);
    a.dispose();

    const b = makeView();
    inspector.resolveWebviewView(b.view as never);
    expect(b.posted.filter((m) => m.type === "tags")).toMatchObject([{ runId: "r1", tags: ["smooth"] }]);
  });
});

afterEach(() => {
  vi.useRealTimers();
});
