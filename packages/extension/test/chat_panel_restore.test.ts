import { describe, it, expect, afterEach } from "vitest";
import * as vscode from "vscode";
import { ChatPanel, CHAT_VIEW_TYPE, registerChatPanelSerializer } from "../src/chat_panel";

// amicode#705: after a hub restart + window reload, VS Code re-opened the
// "amicode.chat" editor tabs of sessions killed mid-turn as dead panels (their
// shell is bound to the previous boot's origin + auth token; no stream will ever
// arrive). The extension never registered a serializer for the view type, so
// nothing owned the restored panels. Contract: restored panels are not kept —
// they are disposed, and the live chat comes from the normal (autoOpen) path.

type FakePanel = { disposed: boolean; dispose(): void };
type Serializer = { deserializeWebviewPanel(panel: FakePanel, state: unknown): Thenable<void> };

function fakeRestoredPanel(): FakePanel {
  const p: FakePanel = { disposed: false, dispose() { p.disposed = true; } };
  return p;
}

describe("ChatPanel restore after reload (amicode#705)", () => {
  const registered: Array<{ viewType: string; serializer: Serializer }> = [];
  const w = vscode.window as unknown as {
    registerWebviewPanelSerializer?: (viewType: string, serializer: Serializer) => { dispose(): void };
  };
  const orig = w.registerWebviewPanelSerializer;
  afterEach(() => {
    w.registerWebviewPanelSerializer = orig;
    registered.length = 0;
  });
  const capture = () => {
    w.registerWebviewPanelSerializer = (viewType, serializer) => {
      registered.push({ viewType, serializer });
      return { dispose() {} };
    };
  };

  it("registers a serializer for the amicode.chat view type", () => {
    capture();
    registerChatPanelSerializer();
    expect(CHAT_VIEW_TYPE).toBe("amicode.chat");
    expect(registered.map((r) => r.viewType)).toEqual(["amicode.chat"]);
  });

  it("disposes a restored (dead) chat panel instead of leaving it hung", async () => {
    capture();
    registerChatPanelSerializer();
    const restored = fakeRestoredPanel();
    await registered[0].serializer.deserializeWebviewPanel(restored, undefined);
    expect(restored.disposed).toBe(true);
  });

  it("does not register a restored panel as a live ChatPanel", async () => {
    capture();
    registerChatPanelSerializer();
    const before = ChatPanel.peek();
    await registered[0].serializer.deserializeWebviewPanel(fakeRestoredPanel(), { anything: 1 });
    expect(ChatPanel.peek()).toBe(before);
  });

  it("createPanel and the serializer agree on the view type", () => {
    const seen: string[] = [];
    const ws = vscode.window as unknown as { createWebviewPanel: (...a: unknown[]) => { dispose(): void } };
    const o = ws.createWebviewPanel;
    ws.createWebviewPanel = (...a: unknown[]) => { seen.push(a[0] as string); return o(...a); };
    try {
      const p = ChatPanel.openNew({ extensionUri: { fsPath: "/ext" } } as unknown as vscode.ExtensionContext, new URL("http://127.0.0.1:1/"));
      expect(seen).toEqual([CHAT_VIEW_TYPE]);
      p.dispose();
    } finally {
      ws.createWebviewPanel = o;
    }
  });
});
