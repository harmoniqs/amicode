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

// Every id the webview script reads/writes MUST exist in the design-owned
// markup, else the live inspector silently breaks with no test failure. The
// regex below recovers the literal $("id")/getElementById("id") lookups; the
// computed hot-path lookups it can't see are pinned explicitly just below.
const SCRIPT = readFileSync(join(PKG_ROOT, "src", "inspector_webview.ts"), "utf8");
function idsReferencedByScript(): string[] {
  const ids = new Set<string>();
  for (const m of SCRIPT.matchAll(/\$\(\s*"([^"]+)"\s*\)/g)) ids.add(m[1]);
  for (const m of SCRIPT.matchAll(/getElementById\(\s*"([^"]+)"\s*\)/g)) ids.add(m[1]);
  return [...ids];
}

// Ids addressed only computationally — the double-buffer swap ($("preview-" +
// buffer)) and the metric fan-out (for (const id of [...]) $(id)). The literal
// regex is blind to these; they pass its check today only because they also
// happen to appear as literals elsewhere, so a design edit that drops that
// incidental alias would go unguarded. Listed explicitly rather than parsed out
// of the source on purpose: this single-run seam is temporary (Phase 1.3
// reshapes the inspector into per-run views and this test goes with it), so a
// fully-derived id contract would be throwaway.
const COMPUTED_FORM_IDS = ["preview-a", "preview-b", "m-obj", "m-iter", "m-pr", "m-du"];

describe("Run Inspector view contract (plumbing ⇄ media/inspector.{html,css})", () => {
  const html = renderInspectorHtml();

  it("renders every DOM id the webview script depends on (literal + computed-form)", () => {
    const ids = idsReferencedByScript();
    expect(ids.length).toBeGreaterThan(0); // guard the regex itself
    for (const id of [...new Set([...ids, ...COMPUTED_FORM_IDS])]) {
      expect(html, `markup is missing id="${id}" (inspector_webview.ts drives it)`).toContain(`id="${id}"`);
    }
  });

  it("links the external stylesheet and keeps the CSP authorizing every grant the view depends on", () => {
    expect(html).toMatch(/<link[^>]+rel="stylesheet"[^>]+href="vscode-webview:\/\/unit\/[^"]*inspector\.css"/);

    // Pin grants to their directive, not just "appears somewhere in the CSP".
    const styleSrc = html.match(/style-src([^;]*)/)?.[1] ?? "";
    expect(styleSrc, "style-src must grant the webview source for the linked stylesheet").toContain("vscode-webview://unit");
    // 'unsafe-inline' is the load-bearing grant: the static style="opacity:0"
    // attrs on preview-a/b need it (runtime .style mutations aren't CSP-governed).
    // Drop it and the previews start visible instead of fading in.
    expect(styleSrc, "style-src must keep 'unsafe-inline' for the static style attrs").toContain("'unsafe-inline'");

    // iter-frame PNGs load as asWebviewUri → vscode-webview:// URIs; img-src must grant the source.
    const imgSrc = html.match(/img-src([^;]*)/)?.[1] ?? "";
    expect(imgSrc, "img-src must grant the webview source for iter-frame PNGs").toContain("vscode-webview://unit");

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
