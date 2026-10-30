// #1036 — "Find in sidebar": the reveal-in-sidebar relay + bridge + sidebar reveal.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { handleAmicodeBridgeMessage } from "../src/chat_bridge";
import { handleSidebarMessage, type SidebarDownMessage } from "../src/sidebar_bridge";

const read = (rel: string) => readFileSync(resolve(__dirname, "..", rel), "utf8");
const webviewSrc = read("src/sidebar_webview.ts");
const viewSrc = read("src/sidebar_view.ts");
const chatPanelSrc = read("src/chat_panel.ts");
const extSrc = read("src/extension.ts");
const pkg = JSON.parse(read("package.json"));

// Minimal io stub: handleAmicodeBridgeMessage only touches what it needs for
// the reveal path; every other field is inert.
function io(extra: Record<string, unknown> = {}): any {
  return new Proxy({ ...extra }, { get: (t, k) => (k in t ? (t as any)[k] : () => undefined) });
}

describe("reveal-in-sidebar — chat bridge (#1036)", () => {
  it("consumes reveal-in-sidebar and forwards the path", () => {
    const revealed: string[] = [];
    const handled = handleAmicodeBridgeMessage(
      { source: "amicode", kind: "reveal-in-sidebar", path: "/ws/proj/notes/a.md" },
      io({ onRevealInSidebar: (p: string) => revealed.push(p) }),
    );
    expect(handled).toBe(true);
    expect(revealed).toEqual(["/ws/proj/notes/a.md"]);
  });

  it("ignores a non-string or empty path", () => {
    const revealed: string[] = [];
    const host = io({ onRevealInSidebar: (p: string) => revealed.push(p) });
    handleAmicodeBridgeMessage({ source: "amicode", kind: "reveal-in-sidebar", path: 7 }, host);
    handleAmicodeBridgeMessage({ source: "amicode", kind: "reveal-in-sidebar", path: "" }, host);
    expect(revealed).toEqual([]);
  });
});

describe("reveal-in-sidebar — relay allowlist (#1036)", () => {
  it("both inline relay scripts admit reveal-in-sidebar", () => {
    const hits = chatPanelSrc.match(/d\.kind === "reveal-in-sidebar"/g) ?? [];
    expect(hits.length).toBe(2);
  });
});

describe("reveal-in-sidebar — sidebar bridge protocol (#1036)", () => {
  it("reveal-file is a host→webview message with no host handler", () => {
    const posted: SidebarDownMessage[] = [];
    const msg = { kind: "reveal-file", path: "/ws/p/x.md" } as any;
    expect(() =>
      handleSidebarMessage(msg, {
        openChat() {}, newProject() {}, addExisting() {}, newEnvironment() {}, addExistingEnvironment() {},
        getRoots: () => [], getChildren: async () => [], openFile() {},
        fileOp: async () => ({ ok: true }), postMessage: (m) => posted.push(m), setSectionOrder() {}, reorderRoot() {},
      } as any),
    ).not.toThrow();
    expect(posted).toEqual([]);
  });
});

describe("reveal-in-sidebar — host wiring (#1036)", () => {
  it("SidebarViewProvider.revealFile focuses the view and posts reveal-file", () => {
    expect(viewSrc).toMatch(/async revealFile\(filePath: string\)/);
    expect(viewSrc).toMatch(/amicode\.workspace\.focus/);
    expect(viewSrc).toMatch(/kind: "reveal-file"/);
  });

  it("a reveal requested before resolve is replayed in resolveWebviewView", () => {
    expect(viewSrc).toMatch(/pendingRevealPath/);
    const replay = viewSrc.indexOf("#1036 — replay a \"Find in sidebar\"");
    const resolveFn = viewSrc.indexOf("resolveWebviewView(");
    expect(replay).toBeGreaterThan(resolveFn);
  });

  it("extension.ts wires the Preview-tab callback and registers amicode.revealInSidebar", () => {
    expect(extSrc).toMatch(/ChatPanel\.onRevealInSidebar\(/);
    expect(extSrc).toMatch(/registerCommand\("amicode\.revealInSidebar"/);
  });

  it("package.json contributes the amicode.revealInSidebar command", () => {
    const cmds = (pkg.contributes?.commands ?? []).map((c: any) => c.command);
    expect(cmds).toContain("amicode.revealInSidebar");
  });
});

describe("reveal-in-sidebar — webview reveal logic (#1036)", () => {
  it("declares the 3-row offset and 2.5 s highlight", () => {
    expect(webviewSrc).toMatch(/REVEAL_CONTEXT_ROWS = 3/);
    expect(webviewSrc).toMatch(/REVEAL_HIGHLIGHT_MS = 2500/);
  });

  it("uses the find-match highlight token and clears the prior timer", () => {
    expect(webviewSrc).toMatch(/--vscode-editor-findMatchHighlightBackground/);
    expect(webviewSrc).toMatch(/clearTimeout\(revealHighlightTimer\)/);
  });

  it("expands ancestors sequentially, awaiting each level, and handles the reveal message", () => {
    expect(webviewSrc).toMatch(/async function revealFileInTree/);
    expect(webviewSrc).toMatch(/await waitUntil\(\(\) => findRowForPath\(next\)/);
    expect(webviewSrc).toMatch(/case "reveal-file"/);
  });
});
