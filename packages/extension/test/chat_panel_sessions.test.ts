import { describe, it, expect, afterEach } from "vitest";
import * as vscode from "vscode";
import { ChatPanel } from "../src/chat_panel";
import { mintServerPassword, serverAuthToken } from "../src/server_auth";

// ============================================================================
// Side-by-side chat sessions: ChatPanel is a multi-instance registry, not a
// singleton. `openOrReveal` keeps its primary semantics (one front door), and
// `openNew` always spawns an ADDITIONAL editor tab — pointed at the app's
// /new-session draft route — so tabs can be split across editor groups.
// ============================================================================

type CapturedPanel = { webview: { html: string }; revealCount: number; dispose(): void };
type CreatedArgs = { viewType: string; title: string; column: unknown };

/** Wrap the mock's createWebviewPanel to capture both the panel and the
 *  constructor args (title/column never land on the mock panel itself). */
function capturePanels(): { created: CapturedPanel[]; args: CreatedArgs[]; restore: () => void } {
  const created: CapturedPanel[] = [];
  const args: CreatedArgs[] = [];
  const w = vscode.window as unknown as {
    createWebviewPanel: (viewType: string, title: string, column?: unknown, opts?: unknown) => CapturedPanel;
  };
  const orig = w.createWebviewPanel;
  w.createWebviewPanel = (viewType: string, title: string, column?: unknown, opts?: unknown) => {
    const p = orig(viewType, title, column, opts);
    created.push(p);
    args.push({ viewType, title, column });
    return p;
  };
  return {
    created,
    args,
    restore: () => {
      w.createWebviewPanel = orig;
    },
  };
}

function fakeCtx(): vscode.ExtensionContext {
  return { extensionUri: { fsPath: "/ext" } } as unknown as vscode.ExtensionContext;
}

const iframeSrc = (html: string): URL => {
  const m = html.match(/<iframe src="([^"]+)"/);
  expect(m).toBeTruthy();
  return new URL(m![1]);
};

const BASE = new URL("http://127.0.0.1:43117/");
const DRAFT = new URL("http://127.0.0.1:43117/new-session");

describe("ChatPanel — side-by-side sessions (multi-instance registry)", () => {
  let restore: (() => void) | undefined;
  let created: CapturedPanel[] = [];
  let args: CreatedArgs[] = [];
  afterEach(() => {
    // live-registry is module state: dispose every created panel so tests
    // don't leak into each other (dispose() removes from the registry).
    for (const p of created) p.dispose();
    restore?.();
    restore = undefined;
    created = [];
    args = [];
  });

  it("openNew adds a SECOND panel; openOrReveal keeps revealing only the primary", () => {
    const cap = capturePanels();
    restore = cap.restore;
    created = cap.created;
    args = cap.args;

    ChatPanel.openOrReveal(fakeCtx(), BASE);
    ChatPanel.openNew(fakeCtx(), DRAFT);
    expect(created).toHaveLength(2);

    // Re-running the plain open command must not spawn a third tab — it pops
    // the primary forward and leaves the extra untouched.
    ChatPanel.openOrReveal(fakeCtx(), BASE);
    expect(created).toHaveLength(2);
    expect(created[0].revealCount).toBe(1);
    expect(created[1].revealCount).toBe(0);
  });

  it("openNew reveals BESIDE the active editor (split, not stacked)", () => {
    const cap = capturePanels();
    restore = cap.restore;
    created = cap.created;
    args = cap.args;

    ChatPanel.openNew(fakeCtx(), DRAFT);
    expect(args).toHaveLength(1);
    expect(args[0].viewType).toBe("amicode.chat");
    expect(args[0].column).toBe(vscode.ViewColumn.Beside);
  });

  it("tab titles number sequentially and reuse the lowest free number", () => {
    const cap = capturePanels();
    restore = cap.restore;
    created = cap.created;
    args = cap.args;

    ChatPanel.openOrReveal(fakeCtx(), BASE); // primary
    ChatPanel.openNew(fakeCtx(), DRAFT);
    ChatPanel.openNew(fakeCtx(), DRAFT);
    expect(args.map((a) => a.title)).toEqual(["Amicode Chat", "Amicode Chat 2", "Amicode Chat 3"]);

    // Closing tab 2 frees its number; the next new tab reuses it. Existing
    // tabs are never retitled.
    created[1].dispose();
    ChatPanel.openNew(fakeCtx(), DRAFT);
    expect(args.map((a) => a.title)).toEqual([
      "Amicode Chat",
      "Amicode Chat 2",
      "Amicode Chat 3",
      "Amicode Chat 2",
    ]);
  });

  it("openNew iframes the draft URL with auth + boot theme, and never leaks the raw password", () => {
    const cap = capturePanels();
    restore = cap.restore;
    created = cap.created;
    args = cap.args;

    const password = mintServerPassword();
    const token = serverAuthToken(password);
    ChatPanel.openNew(fakeCtx(), DRAFT, token);
    const src = iframeSrc(created[0].webview.html);
    expect(src.pathname).toBe("/new-session");
    expect(src.searchParams.get("auth_token")).toBe(token);
    expect(src.searchParams.get("colorScheme")).toBe("dark");
    expect(created[0].webview.html).not.toContain(password);
  });

  it("disposing the primary frees openOrReveal to create a fresh front door titled plainly", () => {
    const cap = capturePanels();
    restore = cap.restore;
    created = cap.created;
    args = cap.args;

    ChatPanel.openOrReveal(fakeCtx(), BASE);
    created[0].dispose();
    ChatPanel.openOrReveal(fakeCtx(), BASE);
    expect(created).toHaveLength(2);
    expect(args[1].title).toBe("Amicode Chat");
  });

  it("snapshots the last focused panel's settled session and clears draft context", () => {
    const cap = capturePanels();
    restore = cap.restore;
    created = cap.created;
    args = cap.args;

    ChatPanel.openOrReveal(fakeCtx(), BASE, "token");
    ChatPanel.openNew(fakeCtx(), DRAFT, "token");
    const primary = created[0] as unknown as {
      webview: { _simulateMessage(msg: unknown): void };
      _simulateViewState(active: boolean, visible: boolean): void;
    };
    const secondary = created[1] as unknown as {
      webview: { _simulateMessage(msg: unknown): void };
      _simulateViewState(active: boolean, visible: boolean): void;
    };
    primary.webview._simulateMessage({ source: "amicode", kind: "session-context", sessionID: "ses_primary" });
    secondary.webview._simulateMessage({ source: "amicode", kind: "session-context", sessionID: "ses_secondary" });
    primary._simulateViewState(true, true);

    expect(ChatPanel.lastFocusedMutationContext()).toMatchObject({ sessionID: "ses_primary" });

    primary.webview._simulateMessage({ source: "amicode", kind: "session-context", draft: true });
    expect(ChatPanel.lastFocusedMutationContext()).toBeUndefined();
  });

  it("relays session context upstream and opaque reassessment invalidations downstream in both iframe shells", () => {
    const source = require("node:fs").readFileSync(require("node:path").resolve(__dirname, "..", "src", "chat_panel.ts"), "utf8");
    expect(source.match(/d\.kind === "session-context"/g)?.length).toBeGreaterThanOrEqual(2);
    expect(source.match(/d\.kind === "assessed-diff-invalidate"/g)?.length).toBeGreaterThanOrEqual(2);
  });

  // ── #1788 (S3): the host's follow set, derived from live panel state ──────
  // Follow = a session this client has opened or pinned — a live chat tab
  // showing it. These accessors are what the followed-session watcher reads.

  function openPanels(n: number) {
    const cap = capturePanels();
    restore = cap.restore;
    created = cap.created;
    args = cap.args;
    ChatPanel.openOrReveal(fakeCtx(), BASE);
    for (let i = 1; i < n; i++) ChatPanel.openNew(fakeCtx(), DRAFT);
    return cap;
  }

  it("#1788 — followedSessionIds is every LIVE tab's settled session (drafts and closed routes follow nothing)", () => {
    openPanels(3);
    const [p0, p1, p2] = created as unknown as Array<{
      webview: { _simulateMessage(msg: unknown): void };
    }>;
    p0.webview._simulateMessage({ source: "amicode", kind: "session-context", sessionID: "ses_a" });
    p1.webview._simulateMessage({ source: "amicode", kind: "session-context", sessionID: "ses_b" });
    // A draft route (the third tab) holds no session and follows nothing.
    p2.webview._simulateMessage({ source: "amicode", kind: "session-context", draft: true });

    expect(new Set(ChatPanel.followedSessionIds())).toEqual(new Set(["ses_a", "ses_b"]));

    // Closing a tab drops its session from the follow set (derived live).
    p1.dispose();
    expect(new Set(ChatPanel.followedSessionIds())).toEqual(new Set(["ses_a"]));
  });

  it("#1788 — focusedSessionId is the FOCUSED panel's session; an unfocused window reports none", () => {
    openPanels(2);
    const [p0, p1] = created as unknown as Array<{
      webview: { _simulateMessage(msg: unknown): void };
      _simulateViewState(active: boolean, visible: boolean): void;
    }>;
    p0.webview._simulateMessage({ source: "amicode", kind: "session-context", sessionID: "ses_a" });
    p1.webview._simulateMessage({ source: "amicode", kind: "session-context", sessionID: "ses_b" });
    p0._simulateViewState(true, true);

    expect(ChatPanel.focusedSessionId()).toBe("ses_a");

    // The user focuses a text editor: no chat panel is the active editor, so
    // the window reports no focused session ("you're already there" lifts).
    p0._simulateViewState(false, true);
    expect(ChatPanel.focusedSessionId()).toBeUndefined();
  });

  it("#1788 — revealSession reveals the live tab showing that session (the notification click action)", () => {
    openPanels(2);
    const [p0, p1] = created as unknown as Array<{
      webview: { _simulateMessage(msg: unknown): void };
      revealCount: number;
    }>;
    p0.webview._simulateMessage({ source: "amicode", kind: "session-context", sessionID: "ses_a" });
    p1.webview._simulateMessage({ source: "amicode", kind: "session-context", sessionID: "ses_b" });

    expect(ChatPanel.revealSession("ses_b")).toBe(true);
    expect(p1.revealCount).toBe(1);
    expect(p0.revealCount).toBe(0);

    // A session no tab shows (unfollowed by construction) cannot be revealed.
    expect(ChatPanel.revealSession("ses_nowhere")).toBe(false);
  });
});
