import { describe, it, expect, vi, afterEach } from "vitest";
import * as vscode from "vscode";
import { registerStoryboard, _resetStoryboardPanelForTests } from "../src/storyboard_shell";

// Pins the shell⇄view seam for the #46 storyboard prototype: the view is
// TS-composed (media/ui/views/storyboard.ts — builds its own DOM and injects
// styles via constructable stylesheets), so this module owns only the
// security/wiring shell. What's load-bearing, pinned here:
//   1. the shell links brand.css + layout.css and the storyboard view bundle;
//   2. the CSP authorizes every grant the view depends on;
//   3. reopening the command reveals the existing panel rather than duplicating it.

function makeCtx() {
  return { subscriptions: [], extensionUri: vscode.Uri.file("/ext") } as never;
}

describe("Storyboard shell contract (#46)", () => {
  afterEach(() => {
    _resetStoryboardPanelForTests();
  });

  it("links the design-owned stylesheets and the view bundle, with a CSP authorizing them", async () => {
    registerStoryboard(makeCtx());
    const spy = vi.spyOn(vscode.window, "createWebviewPanel");
    await vscode.commands.executeCommand("amicode.openStoryboard");
    const panel = spy.mock.results[0].value as { webview: { html: string } };
    const html = panel.webview.html;

    expect(html).toMatch(/<link[^>]+rel="stylesheet"[^>]+href="[^"]*brand\.css"/);
    expect(html).toMatch(/<link[^>]+rel="stylesheet"[^>]+href="[^"]*layout\.css"/);
    expect(html).toMatch(/<script nonce="[^"]+" src="[^"]*storyboard_webview\.js"/);

    const styleSrc = html.match(/style-src([^;]*)/)?.[1] ?? "";
    expect(styleSrc).toContain("'unsafe-inline'");
    expect(html).toMatch(/script-src 'nonce-/);
    expect(html, "no image grants — the view renders static baked content").not.toMatch(/img-src/);

    spy.mockRestore();
  });

  it("re-invoking the command reveals the existing panel instead of creating a second one", async () => {
    registerStoryboard(makeCtx());
    const spy = vi.spyOn(vscode.window, "createWebviewPanel");
    await vscode.commands.executeCommand("amicode.openStoryboard");
    await vscode.commands.executeCommand("amicode.openStoryboard");
    expect(spy).toHaveBeenCalledTimes(1);
    const panel = spy.mock.results[0].value as { revealCount: number; dispose: () => void };
    expect(panel.revealCount).toBe(1);

    panel.dispose(); // user closes the tab
    await vscode.commands.executeCommand("amicode.openStoryboard");
    expect(spy).toHaveBeenCalledTimes(2); // closed → fresh panel
    spy.mockRestore();
  });
});
