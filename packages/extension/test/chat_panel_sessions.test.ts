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
});
