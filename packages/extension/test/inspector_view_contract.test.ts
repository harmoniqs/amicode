import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { registerRunInspector } from "../src/run_inspector";

// Pins the plumbing⇄view contract that the run_inspector.ts split now straddles:
// the markup (media/inspector.html) and styling (media/inspector.css) are owned
// by the design lane, while run_inspector.ts + inspector_webview.ts are the
// plumbing. This test reds if a look-and-feel change drops a DOM id or a CSP
// grant the webview script depends on — i.e. it lets design iterate freely while
// guarding the exact seam the two lanes share. Renders through the public
// WebviewViewProvider surface (resolveWebviewView), not internals.

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

// The contract is derived from the script source, not hand-listed: every id the
// webview script reads/writes MUST exist in the design-owned markup, else the
// live inspector silently breaks with no test failure.
const SCRIPT = readFileSync(join(PKG_ROOT, "src", "inspector_webview.ts"), "utf8");
function idsReferencedByScript(): string[] {
  const ids = new Set<string>();
  for (const m of SCRIPT.matchAll(/\$\(\s*"([^"]+)"\s*\)/g)) ids.add(m[1]);
  for (const m of SCRIPT.matchAll(/getElementById\(\s*"([^"]+)"\s*\)/g)) ids.add(m[1]);
  return [...ids];
}

describe("Run Inspector view contract (plumbing ⇄ media/inspector.{html,css})", () => {
  const html = renderInspectorHtml();

  it("renders every DOM id the webview script depends on", () => {
    const ids = idsReferencedByScript();
    expect(ids.length).toBeGreaterThan(0); // guard the regex itself
    for (const id of ids) {
      expect(html, `markup is missing id="${id}" (inspector_webview.ts drives it)`).toContain(`id="${id}"`);
    }
  });

  it("links the external stylesheet and keeps the CSP authorizing it + the nonce'd script", () => {
    expect(html).toMatch(/<link[^>]+rel="stylesheet"[^>]+href="vscode-webview:\/\/unit\/[^"]*inspector\.css"/);
    expect(html).toMatch(/style-src vscode-webview:\/\/unit/);  // the linked sheet's source must be granted
    expect(html).toMatch(/script-src 'nonce-/);
    expect(html).toMatch(/<script nonce="[^"]+" src="vscode-webview:\/\/unit\/[^"]*inspector_webview\.js"/);
  });

  it("sources markup + styling from the design-owned media files", () => {
    const bodyTpl = readFileSync(join(PKG_ROOT, "media", "inspector.html"), "utf8");
    const css = readFileSync(join(PKG_ROOT, "media", "inspector.css"), "utf8");
    expect(bodyTpl.trim().length).toBeGreaterThan(0);
    expect(css).toMatch(/--amico-accent/);                 // the brand token survived the move
    expect(html).toContain(bodyTpl.trim().split("\n")[0]); // the rendered doc embeds the body template
  });
});
