// #1036 — Preview tab "Find in sidebar": the extension-side pipeline.
// Covers: relay allowlist, chat bridge handler, sidebar bridge message union,
// SidebarViewProvider.revealFile (incl. replay before resolve), the webview
// reveal routine (source contract), and the amicode.revealInSidebar command.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(__dirname, "..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

// ── chat bridge: dedicated message kind carries the path ─────────────────────
import { handleAmicodeBridgeMessage } from "../src/chat_bridge";

function bridgeIo(extra: Record<string, unknown> = {}): any {
  return {
    postToWebview: () => {},
    visible: () => true,
    ...extra,
  };
}

describe("#1036 chat bridge — reveal-in-sidebar", () => {
  it("consumes reveal-in-sidebar and calls onRevealInSidebar with the path", () => {
    const revealed: string[] = [];
    const handled = handleAmicodeBridgeMessage(
      { source: "amicode", kind: "reveal-in-sidebar", path: "/work/proj/data/run.toml" },
      bridgeIo({ onRevealInSidebar: (p: string) => revealed.push(p) }),
    );
    expect(handled).toBe(true);
    expect(revealed).toEqual(["/work/proj/data/run.toml"]);
  });

  it("consumes the message even without onRevealInSidebar wired", () => {
    const handled = handleAmicodeBridgeMessage(
      { source: "amicode", kind: "reveal-in-sidebar", path: "/x" },
      bridgeIo(),
    );
    expect(handled).toBe(true);
  });

  it("ignores reveal-in-sidebar with a non-string or empty path", () => {
    const revealed: string[] = [];
    const host = bridgeIo({ onRevealInSidebar: (p: string) => revealed.push(p) });
    handleAmicodeBridgeMessage({ source: "amicode", kind: "reveal-in-sidebar", path: 42 }, host);
    handleAmicodeBridgeMessage({ source: "amicode", kind: "reveal-in-sidebar", path: "" }, host);
    expect(revealed).toEqual([]);
  });
});

// ── relay allowlist: chat_panel.ts forwards the kind to the bridge ───────────
describe("#1036 relay allowlist", () => {
  it("chat_panel.ts forwards reveal-in-sidebar in both relay allowlists", () => {
    const src = read("src/chat_panel.ts");
    const occurrences = src.split('d.kind === "reveal-in-sidebar"').length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });
});

// ── sidebar bridge: typed host→webview message ───────────────────────────────
describe("#1036 sidebar bridge message", () => {
  it("declares a reveal-file member on SidebarDownMessage", () => {
    const src = read("src/sidebar_bridge.ts");
    expect(src).toMatch(/RevealFileMessage/);
    expect(src).toMatch(/kind:\s*"reveal-file";\s*path:\s*string/);
  });
});

// ── SidebarViewProvider.revealFile ───────────────────────────────────────────
function makeExtensionUri() {
  return { fsPath: "/ext", path: "/ext", scheme: "file", with: () => makeExtensionUri(), toString: () => "file:///ext" };
}
function makeWebviewView() {
  return {
    webview: {
      options: {},
      html: "",
      asWebviewUri: (u: unknown) => u,
      cspSource: "vscode-resource:",
      postMessage: vi.fn(async () => true),
      onDidReceiveMessage: vi.fn(() => ({ dispose() {} })),
    },
    onDidDispose: vi.fn(() => ({ dispose() {} })),
    onDidChangeVisibility: vi.fn(() => ({ dispose() {} })),
    visible: true,
  } as any;
}

describe("#1036 SidebarViewProvider.revealFile", () => {
  it("posts a reveal-file message to the webview once resolved", async () => {
    const { SidebarViewProvider } = await import("../src/sidebar_view");
    const provider = new SidebarViewProvider(makeExtensionUri() as any);
    const view = makeWebviewView();
    provider.resolveWebviewView(view, {} as any, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) } as any);
    provider.revealFile("/work/proj/data/run.toml");
    expect(view.webview.postMessage).toHaveBeenCalledWith({ kind: "reveal-file", path: "/work/proj/data/run.toml" });
  });

  it("queues the reveal when the view is not yet resolved and replays it on resolve", async () => {
    const { SidebarViewProvider } = await import("../src/sidebar_view");
    const provider = new SidebarViewProvider(makeExtensionUri() as any);
    provider.revealFile("/work/proj/data/run.toml");
    const view = makeWebviewView();
    provider.resolveWebviewView(view, {} as any, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) } as any);
    expect(view.webview.postMessage).toHaveBeenCalledWith({ kind: "reveal-file", path: "/work/proj/data/run.toml" });
  });

  it("source: revealFile focuses the sidebar view before posting", () => {
    const src = read("src/sidebar_view.ts");
    expect(src).toMatch(/revealFile\(\s*(filePath|path|absPath|targetPath)\s*:\s*string/);
    expect(src).toMatch(/amicode\.workspace\.focus/);
  });
});

// ── webview reveal routine (source contract; the webview is a template script) ─
describe("#1036 sidebar webview reveal routine", () => {
  const src = read("src/sidebar_webview.ts");

  it("handles the reveal-file host message", () => {
    expect(src).toMatch(/case\s+"reveal-file"/);
  });

  it("waits for children round-trips instead of racing the expansion", () => {
    // Top-down expansion must await the `children` reply for each level.
    expect(src).toMatch(/revealFileInTree/);
    expect(src).toMatch(/childWaiters|awaitChildren|waitForChildren/);
  });

  it("scrolls the target about three rows below the top of the visible tree", () => {
    expect(src).toMatch(/3\s*\*\s*(rowHeight|ROW_HEIGHT)/);
  });

  it("flashes a transient highlight from the find-match background, cleared after ~2.5 s", () => {
    expect(src).toMatch(/--vscode-editor-findMatchHighlightBackground/);
    expect(src).toMatch(/2500/);
    expect(src).toMatch(/reveal-highlight/);
  });

  it("cancels the previous highlight timer on rapid successive reveals", () => {
    expect(src).toMatch(/clearTimeout\(\s*revealHighlightTimer/);
  });

  it("defers the scroll past the section animation when a section was expanded", () => {
    expect(src).toMatch(/SECTION_ANIM_MS\s*\+\s*50/);
  });
});

// ── command registration + manifest ─────────────────────────────────────────
describe("#1036 amicode.revealInSidebar command", () => {
  it("is declared in package.json contributes.commands", () => {
    const pkg = JSON.parse(read("package.json"));
    const ids = (pkg.contributes?.commands ?? []).map((c: { command: string }) => c.command);
    expect(ids).toContain("amicode.revealInSidebar");
  });

  it("is registered in extension.ts and wired to the sidebar provider", () => {
    const src = read("src/extension.ts");
    expect(src).toMatch(/registerCommand\(\s*"amicode\.revealInSidebar"/);
    expect(src).toMatch(/ChatPanel\.onRevealInSidebar\(/);
  });
});
