import { describe, it, expect } from "vitest";
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
  const inspector = registerRunInspector(ctx as never, "/tmp/runs-test");
  let captured = "";
  const view = {
    webview: {
      options: {},
      cspSource: "vscode-webview://unit",
      asWebviewUri: (u: { fsPath?: string }) => ({ toString: () => "vscode-webview://unit/" + (u?.fsPath ?? String(u)) }),
      postMessage: () => undefined,
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

    // iter-frame PNGs load as asWebviewUri → vscode-webview:// URIs; img-src must grant the source.
    const imgSrc = html.match(/img-src([^;]*)/)?.[1] ?? "";
    expect(imgSrc, "img-src must grant the webview source for iter-frame PNGs").toContain("vscode-webview://unit");

    expect(html).toMatch(/script-src 'nonce-/);
  });

  it("design-owned stylesheets exist; brand.css carries the brand token", () => {
    expect(existsSync(join(PKG_ROOT, "media", "layout.css"))).toBe(true);
    const brand = readFileSync(join(PKG_ROOT, "media", "brand.css"), "utf8");
    expect(brand).toMatch(/--color-accent/);
  });
});
