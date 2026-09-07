import { describe, it, expect, afterEach } from "vitest";
import * as vscode from "vscode";
import { ChatPanel } from "../src/chat_panel";
import { readFileSync } from "fs";
import { join } from "path";

type CapturedPanel = { webview: { html: string }; dispose(): void };

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

describe("package.json keybinding declaration (#878)", () => {
  it("declares shift+tab bound to amicode.cycleAgent when the chat panel is active", () => {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, "../package.json"), "utf-8"),
    );
    const keybindings: Array<{ command: string; key: string; when?: string }> =
      pkg.contributes?.keybindings ?? [];
    const binding = keybindings.find((kb) => kb.command === "amicode.cycleAgent");
    expect(binding).toBeTruthy();
    expect(binding!.key).toBe("shift+tab");
    expect(binding!.when).toContain("amicode.chat");
  });
});

describe("extension.ts command handler (#878)", () => {
  it("registers amicode.cycleAgent and calls ChatPanel.postToAll with agent-cycle", () => {
    const src = readFileSync(join(__dirname, "../src/extension.ts"), "utf-8");
    expect(src).toContain('"amicode.cycleAgent"');
    expect(src).toContain('"agent-cycle"');
    expect(src).toContain("ChatPanel.postToAll");
  });
});

describe("lane 2 relay includes agent-cycle (#878)", () => {
  let restore: (() => void) | undefined;
  let created: CapturedPanel[] = [];
  afterEach(() => {
    for (const p of created) p.dispose();
    restore?.();
    restore = undefined;
    created = [];
  });

  it("standard HTML relay includes agent-cycle in the allowlist", () => {
    const cap = capturePanel();
    restore = cap.restore;
    created = cap.created;
    ChatPanel.openOrReveal(fakeCtx(), new URL("http://127.0.0.1:43117/"));
    expect(cap.created[0].webview.html).toContain('"agent-cycle"');
  });

  it("both relay HTML renderers include agent-cycle (structural)", () => {
    const src = readFileSync(join(__dirname, "../src/chat_panel.ts"), "utf-8");
    const matches = src.match(/"agent-cycle"/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("postToAll delivers an agent-cycle envelope to a live panel", () => {
    const cap = capturePanel();
    restore = cap.restore;
    created = cap.created;
    ChatPanel.openOrReveal(fakeCtx(), new URL("http://127.0.0.1:43117/"));
    const msgs: unknown[] = [];
    (cap.created[0] as unknown as {
      webview: { postMessage: (m: unknown) => Promise<boolean> };
    }).webview.postMessage = (m: unknown) => {
      msgs.push(m);
      return Promise.resolve(true);
    };
    ChatPanel.postToAll({ source: "amicode", kind: "agent-cycle" });
    expect(msgs).toContainEqual({ source: "amicode", kind: "agent-cycle" });
  });
});
