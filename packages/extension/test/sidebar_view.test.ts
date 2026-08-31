import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as vscode from "vscode";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeWebviewView() {
  const messageCbs: Array<(msg: unknown) => void> = [];
  let html = "";
  return {
    webview: {
      get html() { return html; },
      set html(v: string) { html = v; },
      cspSource: "https://test.vscode-resource.vscode-cdn.net",
      options: {} as Record<string, unknown>,
      asWebviewUri: (uri: { fsPath: string }) => `vscode-resource:${uri.fsPath}`,
      onDidReceiveMessage: (cb: (msg: unknown) => void) => {
        messageCbs.push(cb);
        return { dispose() {} };
      },
      postMessage: vi.fn().mockResolvedValue(true),
      _simulateMessage(msg: unknown) { for (const cb of messageCbs) cb(msg); },
    },
    _messageCbs: messageCbs,
  };
}

function makeExtensionUri(base = "/ext") {
  return vscode.Uri.file(base);
}

// ── SidebarViewProvider ──────────────────────────────────────────────────────

describe("SidebarViewProvider", () => {
  let SidebarViewProvider: any;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../src/sidebar_view");
    SidebarViewProvider = mod.SidebarViewProvider;
  });

  it("resolves a webview with CSP nonce, script tag, and both buttons", () => {
    const provider = new SidebarViewProvider(makeExtensionUri());
    const view = makeWebviewView();

    provider.resolveWebviewView(view, {}, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });

    const html = view.webview.html;
    // CSP with nonce
    expect(html).toMatch(/Content-Security-Policy/);
    expect(html).toMatch(/nonce-[a-z0-9]+/);
    // Script tag loads the bundled entry point
    expect(html).toContain("sidebar_webview.js");
    // Both header buttons present
    expect(html).toContain("Chat with Amico");
    expect(html).toContain("New Project");
  });
});

// ── Sidebar bridge ───────────────────────────────────────────────────────────

describe("sidebar bridge — handleSidebarMessage", () => {
  let handleSidebarMessage: any;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../src/sidebar_bridge");
    handleSidebarMessage = mod.handleSidebarMessage;
  });

  it("handles open-chat without throwing", () => {
    const openChat = vi.fn();
    const newProject = vi.fn();
    expect(() =>
      handleSidebarMessage({ kind: "open-chat" }, { openChat, newProject })
    ).not.toThrow();
    expect(openChat).toHaveBeenCalled();
  });

  it("handles new-project without throwing", () => {
    const openChat = vi.fn();
    const newProject = vi.fn();
    expect(() =>
      handleSidebarMessage({ kind: "new-project" }, { openChat, newProject })
    ).not.toThrow();
    expect(newProject).toHaveBeenCalled();
  });

  it("handles chat-active message kind", () => {
    const openChat = vi.fn();
    const newProject = vi.fn();
    expect(() =>
      handleSidebarMessage({ kind: "chat-active", active: true }, { openChat, newProject })
    ).not.toThrow();
  });
});

// ── Build pipeline ───────────────────────────────────────────────────────────

describe("sidebar build pipeline", () => {
  it("esbuild config declares sidebar_webview.ts as a browser entry point", () => {
    const configSrc = readFileSync(
      resolve(__dirname, "..", "esbuild.config.mjs"),
      "utf8",
    );
    expect(configSrc).toContain("sidebar_webview.ts");
    expect(configSrc).toContain("dist/sidebar_webview.js");
  });

  it("package.json registers amicode.workspace as type webview", () => {
    const pkg = JSON.parse(
      readFileSync(resolve(__dirname, "..", "package.json"), "utf8"),
    );
    const views = pkg.contributes?.views?.amicode ?? [];
    const wsView = views.find((v: any) => v.id === "amicode.workspace");
    expect(wsView).toBeDefined();
    expect(wsView.type).toBe("webview");
  });

  it("package.json has no viewsWelcome for amicode.workspace", () => {
    const pkg = JSON.parse(
      readFileSync(resolve(__dirname, "..", "package.json"), "utf8"),
    );
    const welcome = pkg.contributes?.viewsWelcome ?? [];
    const wsWelcome = welcome.find((w: any) => w.view === "amicode.workspace");
    expect(wsWelcome).toBeUndefined();
  });

  it("package.json has no tree-scoped context menu contributions for amicode.workspace", () => {
    const pkg = JSON.parse(
      readFileSync(resolve(__dirname, "..", "package.json"), "utf8"),
    );
    const menus = pkg.contributes?.menus ?? {};
    // view/item/context entries should not reference amicode.workspace
    const itemContext = menus["view/item/context"] ?? [];
    const wsMenus = itemContext.filter((m: any) =>
      m.when && m.when.includes("amicode.workspace"),
    );
    expect(wsMenus).toHaveLength(0);
  });
});
