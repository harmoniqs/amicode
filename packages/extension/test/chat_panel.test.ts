import { describe, it, expect, afterEach } from "vitest";
import * as vscode from "vscode";
import { ChatPanel } from "../src/chat_panel";
import { mintServerPassword, serverAuthToken } from "../src/server_auth";

// ============================================================================
// #163: with the per-boot server password armed, the fork 401s the chat app's
// document and every fetch it makes. The app's EXISTING credential bootstrap
// (verified at v1.17.3-amicode.5, packages/app/src/entry.tsx) reads
// `?auth_token=base64(opencode:pw)` off its URL, adopts it for the
// authenticated-fetch path, and strips it from the URL bar — so the extension
// carries the credential to the app on the iframe src, and ONLY there.
// ============================================================================

type CapturedPanel = { webview: { html: string }; dispose(): void };

/** Wrap the mock's createWebviewPanel to capture the panel openOrReveal builds
 *  (ChatPanel keeps it private; the html is the surface under test). */
function capturePanel(): { created: CapturedPanel[]; restore: () => void } {
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

const iframeSrc = (html: string): URL => {
  const m = html.match(/<iframe src="([^"]+)"/);
  expect(m).toBeTruthy();
  return new URL(m![1]);
};

describe("ChatPanel — auth_token carriage to the fork app (#163)", () => {
  let restore: (() => void) | undefined;
  let created: CapturedPanel[] = [];
  afterEach(() => {
    // the singleton survives tests otherwise (openOrReveal would reuse it)
    for (const p of created) p.dispose();
    restore?.();
    restore = undefined;
    created = [];
  });

  it("puts the boot credential on the iframe src as ?auth_token= — the app's bootstrap param (AC2)", () => {
    const cap = capturePanel();
    restore = cap.restore;
    created = cap.created;
    const password = mintServerPassword();
    const token = serverAuthToken(password);
    ChatPanel.openOrReveal(fakeCtx(), new URL("http://127.0.0.1:43117/"), token);
    expect(cap.created).toHaveLength(1);
    const src = iframeSrc(cap.created[0].webview.html);
    expect(src.searchParams.get("auth_token")).toBe(token); // the app decodes base64(opencode:pw)
    expect(src.searchParams.get("colorScheme")).toBe("dark"); // boot theme still rides along
    expect(src.origin).toBe("http://127.0.0.1:43117");
    // AC3-adjacent: the RAW password never appears anywhere in the webview
    // html — the token is its only (encoded) carriage, on the src alone.
    expect(cap.created[0].webview.html).not.toContain(password);
  });

  it("omits auth_token when no credential is given (unsecured dev-server path unchanged)", () => {
    const cap = capturePanel();
    restore = cap.restore;
    created = cap.created;
    ChatPanel.openOrReveal(fakeCtx(), new URL("http://127.0.0.1:43117/"));
    expect(iframeSrc(cap.created[0].webview.html).searchParams.has("auth_token")).toBe(false);
  });
});
