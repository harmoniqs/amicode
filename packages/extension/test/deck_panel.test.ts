import { describe, it, expect, afterEach } from "vitest";
import * as vscode from "vscode";
import { DeckPanel } from "../src/deck_panel";
import { mintServerPassword, serverAuthToken } from "../src/server_auth";

// ============================================================================
// DeckPanel host seam: the bootstrap config (origin, boot credential, scheme)
// lands in the html, the CSP frames ONLY the server origin, the shell bundle
// loads from dist/, and the panel stays a singleton (one deck, N panes).
// ============================================================================

type CapturedPanel = { webview: { html: string }; revealCount: number; dispose(): void };

function capturePanels(): { created: CapturedPanel[]; restore: () => void } {
  const created: CapturedPanel[] = [];
  const w = vscode.window as unknown as { createWebviewPanel: (...a: unknown[]) => CapturedPanel };
  const orig = w.createWebviewPanel;
  w.createWebviewPanel = (...a: unknown[]) => {
    const p = orig(...a);
    created.push(p);
    return p;
  };
  return { created, restore: () => (w.createWebviewPanel = orig) };
}

function fakeCtx(): vscode.ExtensionContext {
  return { extensionUri: { fsPath: "/ext" } } as unknown as vscode.ExtensionContext;
}

describe("DeckPanel — host seam", () => {
  let restore: (() => void) | undefined;
  let created: CapturedPanel[] = [];
  afterEach(() => {
    for (const p of created) p.dispose();
    restore?.();
    restore = undefined;
    created = [];
  });

  it("injects the bootstrap config: origin, auth credential, boot scheme — and CSP frames only the server origin", () => {
    const cap = capturePanels();
    restore = cap.restore;
    created = cap.created;
    const password = mintServerPassword();
    const token = serverAuthToken(password);
    DeckPanel.openOrReveal(fakeCtx(), new URL("http://127.0.0.1:43117/"), token, "/scaffold/dir");
    expect(created).toHaveLength(1);
    const html = created[0].webview.html;
    const m = html.match(/window\.__AMICODE_DECK__ = (\{.*?\});/);
    expect(m).toBeTruthy();
    const boot = JSON.parse(m![1]);
    expect(boot.origin).toBe("http://127.0.0.1:43117");
    expect(boot.authToken).toBe(token);
    expect(boot.colorScheme).toBe("dark");
    expect(boot.hideProjectDir).toBe("/scaffold/dir");
    expect(html).toContain("frame-src http://127.0.0.1:43117");
    expect(html).toContain("deck_shell.js");
    // the raw password never appears anywhere
    expect(html).not.toContain(password);
  });

  it("stays a singleton: a second openOrReveal reveals, never duplicates", () => {
    const cap = capturePanels();
    restore = cap.restore;
    created = cap.created;
    DeckPanel.openOrReveal(fakeCtx(), new URL("http://127.0.0.1:43117/"));
    DeckPanel.openOrReveal(fakeCtx(), new URL("http://127.0.0.1:43117/"));
    expect(created).toHaveLength(1);
    expect(created[0].revealCount).toBe(1);
  });
});
