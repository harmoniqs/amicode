import { describe, it, expect, afterEach } from "vitest";
import * as vscode from "vscode";
import { ChatPanel } from "../src/chat_panel";
import {
  parseRestoredState,
  probeSessionTurn,
  renderInterruptedHtml,
  turnVerdict,
  RESTORE_RESUME_KIND,
} from "../src/chat_restore";

// #705 — VS Code restores chat webview tabs on window reload. A tab whose
// session's turn was killed mid-flight by a server restart must not come back
// as a dead panel.

const done = (completed = 1) => ({ info: { role: "assistant", time: { created: 0, completed } } });
const dangling = { info: { role: "assistant", time: { created: 0 } } };
const user = { info: { role: "user", time: { created: 0 } } };

describe("turnVerdict", () => {
  it("flags an assistant message that never completed when the engine is not running the session", () => {
    expect(turnVerdict([user, dangling], false)).toBe("interrupted");
  });
  it("flags a user message that never got a reply", () => {
    expect(turnVerdict([done(), user], false)).toBe("interrupted");
  });
  it("is ok when the last turn completed", () => {
    expect(turnVerdict([user, done()], false)).toBe("ok");
  });
  it("is ok when the turn recorded an error (it ended, not dangling)", () => {
    expect(turnVerdict([user, { info: { role: "assistant", time: { created: 0 }, error: { name: "x" } } }], false)).toBe("ok");
  });
  it("is ok while the engine is genuinely running the session", () => {
    expect(turnVerdict([user, dangling], true)).toBe("ok");
  });
  it("is ok for an empty or malformed transcript", () => {
    expect(turnVerdict([], false)).toBe("ok");
    expect(turnVerdict({ nope: 1 }, false)).toBe("ok");
  });
});

describe("parseRestoredState", () => {
  it("keeps a session id and drops everything else", () => {
    expect(parseRestoredState({ sessionID: "ses_1", junk: 1 })).toEqual({ sessionID: "ses_1" });
    expect(parseRestoredState({})).toEqual({});
    expect(parseRestoredState(undefined)).toEqual({});
    expect(parseRestoredState({ sessionID: "" })).toEqual({});
    expect(parseRestoredState({ sessionID: 7 })).toEqual({});
  });
});

describe("probeSessionTurn", () => {
  const server = { url: new URL("http://127.0.0.1:43117/"), authorization: "Basic abc" };
  const respond = (routes: Record<string, unknown | number>): typeof fetch =>
    (async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      const body = routes[path];
      if (typeof body === "number") return new Response("{}", { status: body });
      if (body === undefined) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;

  it("reports interrupted for a dangling turn on an idle engine", async () => {
    const f = respond({ "/session/ses_1/message": [user, dangling], "/session/status": {} });
    expect(await probeSessionTurn(server, "ses_1", f)).toBe("interrupted");
  });
  it("reports ok when the engine says the session is busy", async () => {
    const f = respond({ "/session/ses_1/message": [user, dangling], "/session/status": { ses_1: { type: "busy" } } });
    expect(await probeSessionTurn(server, "ses_1", f)).toBe("ok");
  });
  it("never throws: a transport failure or non-ok reply restores normally", async () => {
    const boom = (async () => {
      throw new Error("down");
    }) as typeof fetch;
    expect(await probeSessionTurn(server, "ses_1", boom)).toBe("ok");
    expect(await probeSessionTurn(server, "ses_1", respond({ "/session/ses_1/message": 500 }))).toBe("ok");
  });
});

describe("renderInterruptedHtml", () => {
  it("shows the interrupted state with a resume affordance and escapes the id", () => {
    const html = renderInterruptedHtml('ses_"<x>', "NONCE");
    expect(html).toContain("Turn interrupted");
    expect(html).toContain('id="resume"');
    expect(html).toContain(RESTORE_RESUME_KIND);
    expect(html).not.toContain("<x>");
    expect(html).toContain("script-src 'nonce-NONCE'");
  });
});

// ── ChatPanel.restore (the serializer body) ───────────────────────────────────

type MockPanel = vscode.WebviewPanel & {
  webview: { html: string; _simulateMessage(m: unknown): void };
  title: string;
  _disposed: boolean;
  dispose(): void;
};

function restoredPanel(): MockPanel {
  const w = vscode.window as unknown as { createWebviewPanel: (...a: unknown[]) => unknown };
  const p = w.createWebviewPanel("amicode.chat", "Amicode", 1, {}) as MockPanel;
  return p;
}
const ctx = { extensionUri: { fsPath: "/ext" } } as unknown as vscode.ExtensionContext;
const TARGET = { url: new URL("http://127.0.0.1:43117/"), authToken: "tok" };
const iframeSrc = (html: string): URL => new URL(html.match(/<iframe src="([^"]+)"/)![1]);

describe("ChatPanel.restore", () => {
  const panels: MockPanel[] = [];
  afterEach(() => {
    for (const p of panels.splice(0)) p.dispose();
    ChatPanel.clearAppReadyCallbacks();
  });
  const make = () => {
    const p = restoredPanel();
    panels.push(p);
    return p;
  };

  it("closes the tab instead of leaving a dead panel when no server is reachable", async () => {
    const p = make();
    let disposed = false;
    const orig = p.dispose.bind(p);
    p.dispose = () => {
      disposed = true;
      orig();
    };
    await ChatPanel.restore(p, { sessionID: "ses_1" }, ctx, { resolveServer: async () => undefined });
    expect(disposed).toBe(true);
  });

  it("re-frames a healthy session's tab", async () => {
    const p = make();
    await ChatPanel.restore(p, { sessionID: "ses_1" }, ctx, {
      resolveServer: async () => TARGET,
      probe: async () => "ok",
    });
    expect(iframeSrc(p.webview.html).origin).toBe("http://127.0.0.1:43117");
    expect(p.webview.html).not.toContain("Turn interrupted");
    // the relay persists the session id so the NEXT reload can restore it too
    expect(p.webview.html).toContain("vscode.setState");
    expect(ChatPanel.peek()).toBeDefined();
  });

  it("shows the interrupted state for a dangling turn, then resumes into the live chat", async () => {
    const p = make();
    await ChatPanel.restore(p, { sessionID: "ses_1" }, ctx, {
      resolveServer: async () => TARGET,
      probe: async () => "interrupted",
    });
    expect(p.webview.html).toContain("Turn interrupted");
    expect(p.webview.html).not.toContain("<iframe");
    p.webview._simulateMessage({ source: "amicode", kind: RESTORE_RESUME_KIND });
    expect(p.webview.html).toContain("<iframe");
    expect(p.webview.html).not.toContain("Turn interrupted");
  });

  it("restores a draft tab (no session) without probing", async () => {
    const p = make();
    let probed = false;
    await ChatPanel.restore(p, {}, ctx, {
      resolveServer: async () => TARGET,
      probe: async () => {
        probed = true;
        return "interrupted";
      },
    });
    expect(probed).toBe(false);
    expect(p.webview.html).toContain("<iframe");
  });
});
