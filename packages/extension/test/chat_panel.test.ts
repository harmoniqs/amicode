import { describe, it, expect, afterEach, vi } from "vitest";
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

describe("ChatPanel — the amicode_bug_report boot param (amicode#250 AC5)", () => {
  let restore: (() => void) | undefined;
  let created: CapturedPanel[] = [];
  afterEach(() => {
    for (const p of created) p.dispose();
    restore?.();
    restore = undefined;
    created = [];
    ChatPanel.setBugReportAvailable(false); // static feature flag — reset between tests
  });

  it("sets amicode_bug_report=1 on the iframe src when the staged skills include report-a-bug", () => {
    const cap = capturePanel();
    restore = cap.restore;
    created = cap.created;
    ChatPanel.setBugReportAvailable(true);
    ChatPanel.openOrReveal(fakeCtx(), new URL("http://127.0.0.1:43117/"));
    expect(iframeSrc(cap.created[0].webview.html).searchParams.get("amicode_bug_report")).toBe("1");
  });

  it("omits the param when report-a-bug was not staged — no dead button on Marketplace installs", () => {
    const cap = capturePanel();
    restore = cap.restore;
    created = cap.created;
    ChatPanel.setBugReportAvailable(false);
    ChatPanel.openOrReveal(fakeCtx(), new URL("http://127.0.0.1:43117/"));
    expect(iframeSrc(cap.created[0].webview.html).searchParams.has("amicode_bug_report")).toBe(false);
  });

  it("the relay admits the bug-report kinds on both lanes", () => {
    const cap = capturePanel();
    restore = cap.restore;
    created = cap.created;
    ChatPanel.openOrReveal(fakeCtx(), new URL("http://127.0.0.1:43117/"));
    const html = cap.created[0].webview.html;
    // Lane 1 (app → extension): the dock's lifecycle reports.
    expect(html).toContain('"bug-filed"');
    expect(html).toContain('"bug-report-closed"');
    // Lane 2 (extension → app): dock open/close.
    expect(html).toContain('"open-bug-report"');
    expect(html).toContain('"close-bug-report"');
  });
});

describe("ChatPanel — onboarding greeting auto-send (#449)", () => {
  let restore: (() => void) | undefined;
  let created: CapturedPanel[] = [];
  afterEach(() => {
    for (const p of created) p.dispose();
    restore?.();
    restore = undefined;
    created = [];
    ChatPanel.clearPendingOnboardingGreeting();
  });

  it("posts a navigate message with auto-send greeting after onboarding completes", async () => {
    const cap = capturePanel();
    restore = cap.restore;
    created = cap.created;

    // Signal that onboarding just completed
    ChatPanel.setPendingOnboardingGreeting(true);

    // Open the panel (simulates what happens after server restart)
    ChatPanel.openOrReveal(fakeCtx(), new URL("http://127.0.0.1:43117/"));

    // Spy on postMessage
    const messages: unknown[] = [];
    const panel = cap.created[0] as unknown as { webview: { postMessage: (m: unknown) => Promise<boolean> } };
    panel.webview.postMessage = (m: unknown) => { messages.push(m); return Promise.resolve(true); };

    // Give the delayed postMessage time to fire
    await new Promise((r) => setTimeout(r, 2200));

    // Find the navigate message
    const navigateMsg = messages.find(
      (m) => (m as { source?: string; kind?: string }).source === "amicode" && (m as { kind?: string }).kind === "navigate",
    ) as { source: string; kind: string; path: string } | undefined;

    expect(navigateMsg).toBeDefined();
    expect(navigateMsg!.path).toContain("/new-session");
    expect(navigateMsg!.path).toContain("autoSend=1");
    expect(navigateMsg!.path).toContain("prompt=");
  });

  it("does NOT post greeting when onboarding flag is not set", async () => {
    const cap = capturePanel();
    restore = cap.restore;
    created = cap.created;

    // No pending greeting flag
    ChatPanel.openOrReveal(fakeCtx(), new URL("http://127.0.0.1:43117/"));

    const messages: unknown[] = [];
    const panel = cap.created[0] as unknown as { webview: { postMessage: (m: unknown) => Promise<boolean> } };
    panel.webview.postMessage = (m: unknown) => { messages.push(m); return Promise.resolve(true); };

    await new Promise((r) => setTimeout(r, 2200));

    const navigateMsg = messages.find(
      (m) => (m as { source?: string; kind?: string }).source === "amicode" && (m as { kind?: string }).kind === "navigate",
    );

    expect(navigateMsg).toBeUndefined();
  });

  it("clears the greeting flag after posting (one-shot)", async () => {
    const cap = capturePanel();
    restore = cap.restore;
    created = cap.created;

    ChatPanel.setPendingOnboardingGreeting(true);
    ChatPanel.openOrReveal(fakeCtx(), new URL("http://127.0.0.1:43117/"));

    // Wait for the greeting to fire
    await new Promise((r) => setTimeout(r, 2200));

    // Dispose and re-create — second panel should NOT get the greeting
    for (const p of created) p.dispose();
    created = [];

    const cap2 = capturePanel();
    restore = cap2.restore;
    created = cap2.created;

    ChatPanel.openOrReveal(fakeCtx(), new URL("http://127.0.0.1:43117/"));

    const messages2: unknown[] = [];
    const panel2 = cap2.created[0] as unknown as { webview: { postMessage: (m: unknown) => Promise<boolean> } };
    panel2.webview.postMessage = (m: unknown) => { messages2.push(m); return Promise.resolve(true); };

    await new Promise((r) => setTimeout(r, 2200));

    const navigateMsg2 = messages2.find(
      (m) => (m as { source?: string; kind?: string }).source === "amicode" && (m as { kind?: string }).kind === "navigate",
    );

    expect(navigateMsg2).toBeUndefined();
  });
});
