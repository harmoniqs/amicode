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

describe("ChatPanel — Explorer icon theme bridge", () => {
  let restore: (() => void) | undefined;
  let created: CapturedPanel[] = [];
  afterEach(() => {
    for (const p of created) p.dispose();
    restore?.();
    restore = undefined;
    created = [];
  });

  it("relays the explicit icon-theme request up and the opaque reply down in both chat render paths", () => {
    const cap = capturePanel();
    restore = cap.restore;
    created = cap.created;
    ChatPanel.openOrReveal(fakeCtx(), new URL("http://127.0.0.1:43117/"));
    const html = created[0].webview.html;

    expect(html).toContain("explorer-icon-theme-request");
    expect(html).toContain("explorer-icon-theme");
  });

  it("pushes a replacement icon theme when the Explorer or color theme changes", () => {
    const cap = capturePanel();
    restore = cap.restore;
    created = cap.created;
    ChatPanel.openOrReveal(fakeCtx(), new URL("http://127.0.0.1:43117/"));
    const messages: unknown[] = [];
    const webview = created[0] as unknown as { webview: { postMessage: (message: unknown) => Promise<boolean> } };
    webview.webview.postMessage = (message) => { messages.push(message); return Promise.resolve(true); };

    (vscode.workspace as unknown as { _fireConfigurationChange(section: string): void })._fireConfigurationChange("workbench.iconTheme");
    expect(messages).toContainEqual(expect.objectContaining({ kind: "explorer-icon-theme" }));

    messages.length = 0;
    (vscode.window as unknown as { _fireActiveColorTheme(kind: number): void })._fireActiveColorTheme(vscode.ColorThemeKind.Light);
    expect(messages).toContainEqual({ source: "amicode", kind: "theme", colorScheme: "light" });
    expect(messages).toContainEqual(expect.objectContaining({ kind: "explorer-icon-theme" }));
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
    ChatPanel.clearAppReadyCallbacks();
  });

  it("posts the navigate message only AFTER app-ready fires (event-driven, not blind timer)", async () => {
    const cap = capturePanel();
    restore = cap.restore;
    created = cap.created;

    const panel = ChatPanel.openOrReveal(fakeCtx(), new URL("http://127.0.0.1:43117/"));

    const messages: unknown[] = [];
    const webview = cap.created[0] as unknown as { webview: { postMessage: (m: unknown) => Promise<boolean>; _simulateMessage: (msg: unknown) => void } };
    webview.webview.postMessage = (m: unknown) => { messages.push(m); return Promise.resolve(true); };

    // Call postOnboardingGreeting — should NOT post immediately
    panel.postOnboardingGreeting();

    // Wait a tick — no navigate message yet (no blind timer should fire this fast)
    await new Promise((r) => setTimeout(r, 50));
    const earlyNavigate = messages.find(
      (m) => (m as { kind?: string }).kind === "navigate",
    );
    expect(earlyNavigate).toBeUndefined();

    // Now simulate app-ready — the message should fire
    webview.webview._simulateMessage({ source: "amicode", kind: "app-ready" });
    await new Promise((r) => setTimeout(r, 50));

    const navigateMsg = messages.find(
      (m) => (m as { source?: string; kind?: string }).source === "amicode" && (m as { kind?: string }).kind === "navigate",
    ) as { source: string; kind: string; path: string } | undefined;

    expect(navigateMsg).toBeDefined();
    expect(navigateMsg!.path).toContain("/new-session");
    expect(navigateMsg!.path).toContain("autoSend=1");
    expect(navigateMsg!.path).toContain("prompt=" + encodeURIComponent("Let's begin onboarding."));
  });

  it("does NOT post navigate when postOnboardingGreeting was not called (even after app-ready)", async () => {
    const cap = capturePanel();
    restore = cap.restore;
    created = cap.created;

    // Open panel WITHOUT calling postOnboardingGreeting
    ChatPanel.openOrReveal(fakeCtx(), new URL("http://127.0.0.1:43117/"));

    const messages: unknown[] = [];
    const webview = cap.created[0] as unknown as { webview: { postMessage: (m: unknown) => Promise<boolean>; _simulateMessage: (msg: unknown) => void } };
    webview.webview.postMessage = (m: unknown) => { messages.push(m); return Promise.resolve(true); };

    // Simulate app-ready
    webview.webview._simulateMessage({ source: "amicode", kind: "app-ready" });
    await new Promise((r) => setTimeout(r, 50));

    const navigateMsg = messages.find(
      (m) => (m as { source?: string; kind?: string }).source === "amicode" && (m as { kind?: string }).kind === "navigate",
    );
    expect(navigateMsg).toBeUndefined();
  });

  it("consumePendingOnboardingGreeting returns true once then false", () => {
    ChatPanel.setPendingOnboardingGreeting(true);
    expect(ChatPanel.consumePendingOnboardingGreeting()).toBe(true);
    expect(ChatPanel.consumePendingOnboardingGreeting()).toBe(false);
  });

  it("the relay admits app-ready from the iframe (Lane 1 allowlist)", () => {
    const cap = capturePanel();
    restore = cap.restore;
    created = cap.created;
    ChatPanel.openOrReveal(fakeCtx(), new URL("http://127.0.0.1:43117/"));
    const html = cap.created[0].webview.html;
    // app-ready must be in the Lane 1 allowlist (iframe → extension)
    expect(html).toContain('"app-ready"');
  });

  it("fires onAppReady callback when app-ready message arrives from iframe", async () => {
    const cap = capturePanel();
    restore = cap.restore;
    created = cap.created;

    const readyFired: boolean[] = [];
    ChatPanel.onAppReady(() => readyFired.push(true));

    const panel = ChatPanel.openOrReveal(fakeCtx(), new URL("http://127.0.0.1:43117/"));

    // Simulate the app-ready message arriving from the iframe
    const webview = cap.created[0] as unknown as { webview: { _simulateMessage: (msg: unknown) => void } };
    webview.webview._simulateMessage({ source: "amicode", kind: "app-ready" });

    await new Promise((r) => setTimeout(r, 10));
    expect(readyFired).toHaveLength(1);
  });

  it("postOnboardingGreeting falls back to posting after timeout if app-ready never fires", async () => {
    const cap = capturePanel();
    restore = cap.restore;
    created = cap.created;

    const panel = ChatPanel.openOrReveal(fakeCtx(), new URL("http://127.0.0.1:43117/"));

    const messages: unknown[] = [];
    const webview = cap.created[0] as unknown as { webview: { postMessage: (m: unknown) => Promise<boolean>; _simulateMessage: (msg: unknown) => void } };
    webview.webview.postMessage = (m: unknown) => { messages.push(m); return Promise.resolve(true); };

    // Call with a short timeout for testing (pass timeout override)
    panel.postOnboardingGreeting(200);

    // No app-ready — wait for the timeout fallback
    await new Promise((r) => setTimeout(r, 300));

    const navigateMsg = messages.find(
      (m) => (m as { source?: string; kind?: string }).source === "amicode" && (m as { kind?: string }).kind === "navigate",
    );
    expect(navigateMsg).toBeDefined();
  });
});

describe("ChatPanel.adopt — transforms an existing panel into the chat singleton", () => {
  let restore: (() => void) | undefined;
  let created: CapturedPanel[] = [];
  afterEach(() => {
    for (const p of created) p.dispose();
    restore?.();
    restore = undefined;
    created = [];
    ChatPanel.clearPendingOnboardingGreeting();
    ChatPanel.clearAppReadyCallbacks();
  });

  it("adopt wraps an existing WebviewPanel as the ChatPanel singleton (no new panel created)", () => {
    // Create a panel externally BEFORE installing the capture spy
    const existingPanel = vscode.window.createWebviewPanel(
      "amicode.onboarding", "Amicode Setup", vscode.ViewColumn.One, { enableScripts: true },
    ) as unknown as CapturedPanel;
    created.push(existingPanel);

    // Now install the spy — any new panel creation will be captured
    const cap = capturePanel();
    restore = cap.restore;

    // Adopt it
    const chatPanel = ChatPanel.adopt(
      existingPanel as unknown as import("vscode").WebviewPanel,
      fakeCtx(),
      new URL("http://127.0.0.1:43117/"),
    );

    expect(chatPanel).toBeDefined();
    // No NEW panel should have been created via createWebviewPanel
    expect(cap.created).toHaveLength(0);
    // openOrReveal should now return the adopted panel (it's the singleton)
    const revealed = ChatPanel.openOrReveal(fakeCtx(), new URL("http://127.0.0.1:43117/"));
    expect(revealed).toBe(chatPanel);
    // Still no new panel
    expect(cap.created).toHaveLength(0);
  });

  it("adopt sets the panel HTML to the chat iframe content with splash overlay", () => {
    const existingPanel = vscode.window.createWebviewPanel(
      "amicode.onboarding", "Amicode Setup", vscode.ViewColumn.One, { enableScripts: true },
    ) as unknown as CapturedPanel;
    created.push(existingPanel);

    ChatPanel.adopt(
      existingPanel as unknown as import("vscode").WebviewPanel,
      fakeCtx(),
      new URL("http://127.0.0.1:43117/"),
    );

    // The HTML should contain both the iframe and the splash overlay
    const html = existingPanel.webview.html;
    expect(html).toContain("iframe");
    expect(html).toContain("splash-overlay");
    expect(html).toContain("127.0.0.1:43117");
  });

  it("adopt wires app-ready so it fires onAppReady callbacks", async () => {
    const existingPanel = vscode.window.createWebviewPanel(
      "amicode.onboarding", "Amicode Setup", vscode.ViewColumn.One, { enableScripts: true },
    ) as unknown as CapturedPanel;
    created.push(existingPanel);

    const readyFired: boolean[] = [];
    ChatPanel.onAppReady(() => readyFired.push(true));

    ChatPanel.adopt(
      existingPanel as unknown as import("vscode").WebviewPanel,
      fakeCtx(),
      new URL("http://127.0.0.1:43117/"),
    );

    // Simulate app-ready arriving from the iframe
    const webview = existingPanel as unknown as { webview: { _simulateMessage: (msg: unknown) => void } };
    webview.webview._simulateMessage({ source: "amicode", kind: "app-ready" });

    await new Promise((r) => setTimeout(r, 10));
    expect(readyFired).toHaveLength(1);
  });
});

describe("ChatPanel — workspace-projects bridge relay (#663)", () => {
  let restore: (() => void) | undefined;
  let created: CapturedPanel[] = [];
  afterEach(() => {
    for (const p of created) p.dispose();
    restore?.();
    restore = undefined;
    created = [];
  });

  it("the downstream relay admits 'workspace-projects' messages (extension → iframe)", () => {
    const cap = capturePanel();
    restore = cap.restore;
    created = cap.created;
    ChatPanel.openOrReveal(fakeCtx(), new URL("http://127.0.0.1:43117/"));
    const html = cap.created[0].webview.html;
    expect(html).toContain('"workspace-projects"');
  });

  it("the upstream relay admits 'add-workspace-project' messages (iframe → extension)", () => {
    const cap = capturePanel();
    restore = cap.restore;
    created = cap.created;
    ChatPanel.openOrReveal(fakeCtx(), new URL("http://127.0.0.1:43117/"));
    const html = cap.created[0].webview.html;
    expect(html).toContain('"add-workspace-project"');
  });

  it("the upstream relay admits 'project-selected' messages (iframe → extension)", () => {
    const cap = capturePanel();
    restore = cap.restore;
    created = cap.created;
    ChatPanel.openOrReveal(fakeCtx(), new URL("http://127.0.0.1:43117/"));
    const html = cap.created[0].webview.html;
    expect(html).toContain('"project-selected"');
  });
});

describe("ChatPanel — onProjectSelected callback (#663)", () => {
  let restore: (() => void) | undefined;
  let created: CapturedPanel[] = [];
  afterEach(() => {
    for (const p of created) p.dispose();
    restore?.();
    restore = undefined;
    created = [];
    ChatPanel.onProjectSelected(undefined as unknown as (path: string) => void);
  });

  it("fires the registered callback when a project-selected message arrives from the iframe", () => {
    const selected: string[] = [];
    ChatPanel.onProjectSelected((p) => selected.push(p));
    const cap = capturePanel();
    restore = cap.restore;
    created = cap.created;
    ChatPanel.openOrReveal(fakeCtx(), new URL("http://127.0.0.1:43117/"));
    // Simulate the iframe sending a project-selected envelope
    const panel = cap.created[0] as unknown as { webview: { _simulateMessage(msg: unknown): void } };
    panel.webview._simulateMessage({ source: "amicode", kind: "project-selected", path: "/Users/jj/harmoniqs" });
    expect(selected).toEqual(["/Users/jj/harmoniqs"]);
  });

  it("re-emits last project selection when the panel gains focus (tab switch)", () => {
    const selected: Array<{ path: string | null; mode?: string }> = [];
    ChatPanel.onProjectSelected((p, m) => selected.push({ path: p, mode: m }));
    const cap = capturePanel();
    restore = cap.restore;
    created = cap.created;
    ChatPanel.openOrReveal(fakeCtx(), new URL("http://127.0.0.1:43117/"));
    // Simulate project selection
    const panel = cap.created[0] as unknown as {
      webview: { _simulateMessage(msg: unknown): void };
      _simulateViewState(active: boolean, visible: boolean): void;
    };
    panel.webview._simulateMessage({ source: "amicode", kind: "project-selected", path: "/Users/jj/harmoniqs" });
    selected.length = 0; // clear

    // Simulate tab gaining focus (user switches back)
    panel._simulateViewState(true, true);
    expect(selected).toHaveLength(1);
    expect(selected[0].path).toBe("/Users/jj/harmoniqs");
    // Tab switch uses "expand" — expands the target project but never collapses others
    expect(selected[0].mode).toBe("expand");
  });

  it("emits null when a panel with no project selection gains focus (clears stale highlight)", () => {
    const selected: Array<{ path: string | null; mode?: string }> = [];
    ChatPanel.onProjectSelected((p, m) => selected.push({ path: p, mode: m }));
    const cap = capturePanel();
    restore = cap.restore;
    created = cap.created;
    ChatPanel.openOrReveal(fakeCtx(), new URL("http://127.0.0.1:43117/"));
    // No project-selected message — this session never picked a project
    const panel = cap.created[0] as unknown as {
      _simulateViewState(active: boolean, visible: boolean): void;
    };
    panel._simulateViewState(true, true);
    expect(selected).toHaveLength(1);
    expect(selected[0].path).toBeNull();
    expect(selected[0].mode).toBe("expand");
  });

  it("explicit dropdown selection passes mode 'reset' through the callback", () => {
    const selected: Array<{ path: string | null; mode?: string }> = [];
    ChatPanel.onProjectSelected((p, m) => selected.push({ path: p, mode: m }));
    const cap = capturePanel();
    restore = cap.restore;
    created = cap.created;
    ChatPanel.openOrReveal(fakeCtx(), new URL("http://127.0.0.1:43117/"));
    const panel = cap.created[0] as unknown as { webview: { _simulateMessage(msg: unknown): void } };
    // Simulate the iframe sending a project-selected envelope (explicit click — mode defaults to "reset")
    panel.webview._simulateMessage({ source: "amicode", kind: "project-selected", path: "/Users/jj/harmoniqs" });
    expect(selected).toHaveLength(1);
    expect(selected[0].path).toBe("/Users/jj/harmoniqs");
    expect(selected[0].mode).toBe("reset");
  });
});

describe("ChatPanel — persistent app-ready handlers (#870)", () => {
  let restore: (() => void) | undefined;
  let created: CapturedPanel[] = [];
  afterEach(() => {
    for (const p of created) p.dispose();
    restore?.();
    restore = undefined;
    created = [];
    ChatPanel.clearAppReadyCallbacks();
  });

  it("persistent callbacks fire on every app-ready, not just the first (AC2)", async () => {
    const cap = capturePanel();
    restore = cap.restore;
    created = cap.created;

    let fireCount = 0;
    ChatPanel.onAppReadyPersistent(() => { fireCount++; });

    ChatPanel.openOrReveal(fakeCtx(), new URL("http://127.0.0.1:43117/"));
    const webview = cap.created[0] as unknown as {
      webview: { _simulateMessage: (msg: unknown) => void };
    };

    // First app-ready
    webview.webview._simulateMessage({ source: "amicode", kind: "app-ready" });
    await new Promise((r) => setTimeout(r, 10));
    expect(fireCount).toBe(1);

    // Second app-ready — persistent callback should fire again
    webview.webview._simulateMessage({ source: "amicode", kind: "app-ready" });
    await new Promise((r) => setTimeout(r, 10));
    expect(fireCount).toBe(2);
  });

  it("persistent callbacks survive even after one-shot callbacks are drained", async () => {
    const cap = capturePanel();
    restore = cap.restore;
    created = cap.created;

    let persistentFired = 0;
    let oneShotFired = 0;
    ChatPanel.onAppReady(() => { oneShotFired++; });
    ChatPanel.onAppReadyPersistent(() => { persistentFired++; });

    ChatPanel.openOrReveal(fakeCtx(), new URL("http://127.0.0.1:43117/"));
    const webview = cap.created[0] as unknown as {
      webview: { _simulateMessage: (msg: unknown) => void };
    };

    // First app-ready — both fire
    webview.webview._simulateMessage({ source: "amicode", kind: "app-ready" });
    await new Promise((r) => setTimeout(r, 10));
    expect(oneShotFired).toBe(1);
    expect(persistentFired).toBe(1);

    // Second app-ready — only persistent fires (one-shot was drained)
    webview.webview._simulateMessage({ source: "amicode", kind: "app-ready" });
    await new Promise((r) => setTimeout(r, 10));
    expect(oneShotFired).toBe(1); // still 1
    expect(persistentFired).toBe(2);
  });

  it("clearAppReadyCallbacks clears both one-shot and persistent callbacks", async () => {
    const cap = capturePanel();
    restore = cap.restore;
    created = cap.created;

    let fired = false;
    ChatPanel.onAppReadyPersistent(() => { fired = true; });
    ChatPanel.clearAppReadyCallbacks();

    ChatPanel.openOrReveal(fakeCtx(), new URL("http://127.0.0.1:43117/"));
    const webview = cap.created[0] as unknown as {
      webview: { _simulateMessage: (msg: unknown) => void };
    };

    webview.webview._simulateMessage({ source: "amicode", kind: "app-ready" });
    await new Promise((r) => setTimeout(r, 10));
    expect(fired).toBe(false);
  });
});

describe("ChatPanel — postToAll broadcasts to every live panel (#870 AC3)", () => {
  let restore: (() => void) | undefined;
  let created: CapturedPanel[] = [];
  afterEach(() => {
    for (const p of created) p.dispose();
    restore?.();
    restore = undefined;
    created = [];
    ChatPanel.clearAppReadyCallbacks();
  });

  it("postToAll sends a message to both the primary and a side-by-side panel", () => {
    const cap = capturePanel();
    restore = cap.restore;
    created = cap.created;

    ChatPanel.openOrReveal(fakeCtx(), new URL("http://127.0.0.1:43117/"));
    ChatPanel.openNew(fakeCtx(), new URL("http://127.0.0.1:43117/new-session"));
    expect(cap.created).toHaveLength(2);

    // Spy on postMessage for both panels
    const msgs0: unknown[] = [];
    const msgs1: unknown[] = [];
    (cap.created[0] as unknown as { webview: { postMessage: (m: unknown) => Promise<boolean> } }).webview.postMessage =
      (m: unknown) => { msgs0.push(m); return Promise.resolve(true); };
    (cap.created[1] as unknown as { webview: { postMessage: (m: unknown) => Promise<boolean> } }).webview.postMessage =
      (m: unknown) => { msgs1.push(m); return Promise.resolve(true); };

    const envelope = { source: "amicode", kind: "workspace-projects", projects: [] };
    ChatPanel.postToAll(envelope);

    expect(msgs0).toContainEqual(envelope);
    expect(msgs1).toContainEqual(envelope);
  });

  it("postToAll is a no-op when no panels are live", () => {
    // No panels created — should not throw
    expect(() => ChatPanel.postToAll({ source: "amicode", kind: "test" })).not.toThrow();
  });

  it("postToAll reaches a panel even after the primary is disposed (AC4 — folder-change push)", () => {
    const cap = capturePanel();
    restore = cap.restore;
    created = cap.created;

    ChatPanel.openOrReveal(fakeCtx(), new URL("http://127.0.0.1:43117/"));
    ChatPanel.openNew(fakeCtx(), new URL("http://127.0.0.1:43117/new-session"));

    // Dispose the primary — the secondary is still live
    cap.created[0].dispose();

    const msgs: unknown[] = [];
    (cap.created[1] as unknown as { webview: { postMessage: (m: unknown) => Promise<boolean> } }).webview.postMessage =
      (m: unknown) => { msgs.push(m); return Promise.resolve(true); };

    const envelope = { source: "amicode", kind: "workspace-projects", projects: [{ name: "new-folder" }] };
    ChatPanel.postToAll(envelope);

    // The secondary panel still receives the push — this is the folder-change path
    expect(msgs).toContainEqual(envelope);
  });
});

describe("ChatPanel — clipboard-image-request routes through extension host", () => {
  let restore: (() => void) | undefined;
  let created: CapturedPanel[] = [];
  afterEach(() => {
    for (const p of created) p.dispose();
    restore?.();
    restore = undefined;
    created = [];
  });

  it("the relay forwards clipboard-image-request to the extension host (not navigator.clipboard.read)", () => {
    const cap = capturePanel();
    restore = cap.restore;
    created = cap.created;
    ChatPanel.openOrReveal(fakeCtx(), new URL("http://127.0.0.1:43117/"));
    const html = cap.created[0].webview.html;
    // The outer webview relay should forward clipboard-image-request to the
    // extension via vscode.postMessage — NOT handle it with navigator.clipboard.read
    expect(html).toContain('"clipboard-image-read"');
    // The old client-side replyClipboardImage with navigator.clipboard.read should be gone
    expect(html).not.toContain("navigator.clipboard.read");
  });
});
