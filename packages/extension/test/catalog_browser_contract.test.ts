import { describe, it, expect, vi, afterEach } from "vitest";
import * as vscode from "vscode";
import { registerCatalogBrowser, _resetCatalogBrowserPanelForTests } from "../src/catalog_browser_shell";

// Pins the shell⇄view seam for the #48 catalog-browser (flat) prototype: the
// view is TS-composed, so this module owns only the security/wiring shell.
// What's load-bearing, pinned here:
//   1. the shell links brand.css + layout.css and the catalog-browser view bundle;
//   2. the CSP authorizes every grant the view depends on;
//   3. reopening the command reveals the existing panel rather than duplicating it.

function makeCtx() {
  return { subscriptions: [], extensionUri: vscode.Uri.file("/ext") } as never;
}

describe("Catalog browser shell contract (#48, flat)", () => {
  afterEach(() => {
    _resetCatalogBrowserPanelForTests();
  });

  it("links the design-owned stylesheets and the view bundle, with a CSP authorizing them", async () => {
    registerCatalogBrowser(makeCtx());
    const spy = vi.spyOn(vscode.window, "createWebviewPanel");
    await vscode.commands.executeCommand("amicode.openCatalogBrowser");
    const panel = spy.mock.results[0].value as { webview: { html: string } };
    const html = panel.webview.html;

    expect(html).toMatch(/<link[^>]+rel="stylesheet"[^>]+href="[^"]*brand\.css"/);
    expect(html).toMatch(/<link[^>]+rel="stylesheet"[^>]+href="[^"]*layout\.css"/);
    expect(html).toMatch(/<script nonce="[^"]+" src="[^"]*catalog_browser_webview\.js"/);

    const styleSrc = html.match(/style-src([^;]*)/)?.[1] ?? "";
    expect(styleSrc).toContain("'unsafe-inline'");
    expect(html).toMatch(/script-src 'nonce-/);

    spy.mockRestore();
  });

  it("re-invoking the command reveals the existing panel instead of creating a second one", async () => {
    registerCatalogBrowser(makeCtx());
    const spy = vi.spyOn(vscode.window, "createWebviewPanel");
    await vscode.commands.executeCommand("amicode.openCatalogBrowser");
    await vscode.commands.executeCommand("amicode.openCatalogBrowser");
    expect(spy).toHaveBeenCalledTimes(1);
    const panel = spy.mock.results[0].value as { revealCount: number; dispose: () => void };
    expect(panel.revealCount).toBe(1);

    panel.dispose();
    await vscode.commands.executeCommand("amicode.openCatalogBrowser");
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});
