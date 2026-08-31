import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as vscode from "vscode";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeWebviewView() {
  const messageCbs: Array<(msg: unknown) => void> = [];
  const disposeCbs: Array<() => void> = [];
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
    onDidDispose: (cb: () => void) => {
      disposeCbs.push(cb);
      return { dispose() {} };
    },
    _messageCbs: messageCbs,
    _disposeCbs: disposeCbs,
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

// ── Project tree scanning (#675) ─────────────────────────────────────────────

describe("sidebar bridge — project tree scanning", () => {
  let handleSidebarMessage: any;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../src/sidebar_bridge");
    handleSidebarMessage = mod.handleSidebarMessage;
  });

  it("get-roots returns workspace folders classified by project type, research first", () => {
    const openChat = vi.fn();
    const newProject = vi.fn();
    const postMessage = vi.fn();

    // Mock workspace folders: one research, one dev
    const getRoots = vi.fn().mockReturnValue([
      { path: "/projects/quantum-sim", name: "quantum-sim", projectType: "research", metadata: { phase: "running" } },
      { path: "/projects/my-app", name: "my-app", projectType: "dev" },
    ]);

    handleSidebarMessage(
      { kind: "get-roots" },
      { openChat, newProject, getRoots, getChildren: vi.fn(), openFile: vi.fn(), postMessage },
    );

    expect(getRoots).toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "roots",
        roots: expect.arrayContaining([
          expect.objectContaining({ path: "/projects/quantum-sim", projectType: "research" }),
          expect.objectContaining({ path: "/projects/my-app", projectType: "dev" }),
        ]),
      }),
    );
  });

  it("get-children returns directory entries sorted dirs-first, .git filtered", async () => {
    const openChat = vi.fn();
    const newProject = vi.fn();
    const postMessage = vi.fn();

    const getChildren = vi.fn().mockResolvedValue([
      { name: "src", type: "directory" },
      { name: "alpha.ts", type: "file" },
      { name: "beta.ts", type: "file" },
    ]);

    await handleSidebarMessage(
      { kind: "get-children", path: "/projects/quantum-sim" },
      { openChat, newProject, getRoots: vi.fn(), getChildren, openFile: vi.fn(), postMessage },
    );

    expect(getChildren).toHaveBeenCalledWith("/projects/quantum-sim");
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "children",
        path: "/projects/quantum-sim",
        entries: [
          expect.objectContaining({ name: "src", type: "directory" }),
          expect.objectContaining({ name: "alpha.ts", type: "file" }),
          expect.objectContaining({ name: "beta.ts", type: "file" }),
        ],
      }),
    );
  });

  it("open-file triggers the openFile handler", () => {
    const openFile = vi.fn();
    handleSidebarMessage(
      { kind: "open-file", path: "/projects/quantum-sim/solve.jl" },
      { openChat: vi.fn(), newProject: vi.fn(), getRoots: vi.fn(), getChildren: vi.fn(), openFile, postMessage: vi.fn() },
    );

    expect(openFile).toHaveBeenCalledWith("/projects/quantum-sim/solve.jl");
  });
});

// ── Tree service (#675) ──────────────────────────────────────────────────────

describe("SidebarTreeService", () => {
  let SidebarTreeService: any;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../src/sidebar_tree_service");
    SidebarTreeService = mod.SidebarTreeService;
  });

  it("getRoots classifies workspace folders, research first", () => {
    const folders = [
      { uri: vscode.Uri.file("/dev-app"), name: "dev-app", index: 0 },
      { uri: vscode.Uri.file("/quantum-sim"), name: "quantum-sim", index: 1 },
    ];

    const service = new SidebarTreeService({
      detectProjectType: (dir: string) =>
        dir === "/quantum-sim" ? "research" : "dev",
      readToml: () => ({ name: "Quantum Sim", status: "running" }),
      getWorkspaceFolders: () => folders,
    });

    const roots = service.getRoots();
    // Research projects come first
    expect(roots[0]).toMatchObject({
      path: "/quantum-sim",
      projectType: "research",
      name: "Quantum Sim",
    });
    expect(roots[1]).toMatchObject({
      path: "/dev-app",
      projectType: "dev",
      name: "dev-app",
    });
  });

  it("getChildren returns entries with .git filtered and dirs-first sort", async () => {
    const service = new SidebarTreeService({
      detectProjectType: () => "dev",
      readToml: () => ({}),
      readDirectory: async () => [
        { name: "beta.ts", type: "file" },
        { name: ".git", type: "directory" },
        { name: "src", type: "directory" },
        { name: "alpha.ts", type: "file" },
      ],
      getExcludePatterns: () => [],
    });

    const entries = await service.getChildren("/project");
    const names = entries.map((e: any) => e.name);
    // .git excluded, dirs first, then alphabetical
    expect(names).toEqual(["src", "alpha.ts", "beta.ts"]);
  });

  it("getChildren respects files.exclude patterns", async () => {
    const service = new SidebarTreeService({
      detectProjectType: () => "dev",
      readToml: () => ({}),
      readDirectory: async () => [
        { name: "src", type: "directory" },
        { name: "node_modules", type: "directory" },
        { name: "main.ts", type: "file" },
      ],
      getExcludePatterns: () => ["node_modules"],
    });

    const entries = await service.getChildren("/project");
    const names = entries.map((e: any) => e.name);
    expect(names).toEqual(["src", "main.ts"]);
  });
});

// ── File operations (#676) ───────────────────────────────────────────────────

describe("sidebar bridge — file operations", () => {
  let handleSidebarMessage: any;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../src/sidebar_bridge");
    handleSidebarMessage = mod.handleSidebarMessage;
  });

  function makeHandlers(overrides: Record<string, any> = {}) {
    return {
      openChat: vi.fn(),
      newProject: vi.fn(),
      getRoots: vi.fn(),
      getChildren: vi.fn().mockResolvedValue([]),
      openFile: vi.fn(),
      postMessage: vi.fn(),
      fileOp: vi.fn().mockResolvedValue({ ok: true }),
      ...overrides,
    };
  }

  it("file-op rename dispatches to fileOp handler", async () => {
    const handlers = makeHandlers();
    await handleSidebarMessage(
      { kind: "file-op", op: "rename", path: "/project/old.ts", newName: "new.ts" },
      handlers,
    );
    expect(handlers.fileOp).toHaveBeenCalledWith(
      expect.objectContaining({ op: "rename", path: "/project/old.ts", newName: "new.ts" }),
    );
  });

  it("file-op delete dispatches to fileOp handler", async () => {
    const handlers = makeHandlers();
    await handleSidebarMessage(
      { kind: "file-op", op: "delete", path: "/project/dead.ts" },
      handlers,
    );
    expect(handlers.fileOp).toHaveBeenCalledWith(
      expect.objectContaining({ op: "delete", path: "/project/dead.ts" }),
    );
  });

  it("file-op new-file dispatches to fileOp handler", async () => {
    const handlers = makeHandlers();
    await handleSidebarMessage(
      { kind: "file-op", op: "new-file", path: "/project/src", name: "hello.jl" },
      handlers,
    );
    expect(handlers.fileOp).toHaveBeenCalledWith(
      expect.objectContaining({ op: "new-file", path: "/project/src", name: "hello.jl" }),
    );
  });

  it("file-op new-folder dispatches to fileOp handler", async () => {
    const handlers = makeHandlers();
    await handleSidebarMessage(
      { kind: "file-op", op: "new-folder", path: "/project", name: "utils" },
      handlers,
    );
    expect(handlers.fileOp).toHaveBeenCalledWith(
      expect.objectContaining({ op: "new-folder", path: "/project", name: "utils" }),
    );
  });

  it("file-op copy-path dispatches to fileOp handler", async () => {
    const handlers = makeHandlers();
    await handleSidebarMessage(
      { kind: "file-op", op: "copy-path", path: "/project/src/main.ts" },
      handlers,
    );
    expect(handlers.fileOp).toHaveBeenCalledWith(
      expect.objectContaining({ op: "copy-path", path: "/project/src/main.ts" }),
    );
  });

  it("file-op error result posts file-op-error back", async () => {
    const handlers = makeHandlers({
      fileOp: vi.fn().mockResolvedValue({ ok: false, message: "name collision" }),
    });
    await handleSidebarMessage(
      { kind: "file-op", op: "rename", path: "/project/old.ts", newName: "new.ts" },
      handlers,
    );
    expect(handlers.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "file-op-error",
        op: "rename",
        path: "/project/old.ts",
        message: "name collision",
      }),
    );
  });
});

// ── Session-aware highlighting (#677) ────────────────────────────────────────

describe("SidebarViewProvider — session awareness", () => {
  let SidebarViewProvider: any;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../src/sidebar_view");
    SidebarViewProvider = mod.SidebarViewProvider;
  });

  it("setActiveProject posts active-project message to the webview", () => {
    const provider = new SidebarViewProvider(makeExtensionUri());
    const view = makeWebviewView();

    provider.resolveWebviewView(view, {}, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });

    provider.setActiveProject("/projects/quantum-sim");

    expect(view.webview.postMessage).toHaveBeenCalledWith({
      kind: "active-project",
      path: "/projects/quantum-sim",
    });
  });

  it("setActiveProject with null clears the highlight", () => {
    const provider = new SidebarViewProvider(makeExtensionUri());
    const view = makeWebviewView();

    provider.resolveWebviewView(view, {}, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });

    provider.setActiveProject(null);

    expect(view.webview.postMessage).toHaveBeenCalledWith({
      kind: "active-project",
      path: null,
    });
  });

  it("setActiveProject switches highlight from one project to another", () => {
    const provider = new SidebarViewProvider(makeExtensionUri());
    const view = makeWebviewView();

    provider.resolveWebviewView(view, {}, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });

    provider.setActiveProject("/projects/quantum-sim");
    provider.setActiveProject("/projects/other");

    const calls = (view.webview.postMessage as any).mock.calls;
    const activeProjectCalls = calls.filter((c: any) => c[0]?.kind === "active-project");
    expect(activeProjectCalls).toHaveLength(2);
    expect(activeProjectCalls[0][0].path).toBe("/projects/quantum-sim");
    expect(activeProjectCalls[1][0].path).toBe("/projects/other");
  });

  it("setActiveProject deduplicates same path", () => {
    const provider = new SidebarViewProvider(makeExtensionUri());
    const view = makeWebviewView();

    provider.resolveWebviewView(view, {}, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });

    provider.setActiveProject("/projects/quantum-sim");
    provider.setActiveProject("/projects/quantum-sim");

    const calls = (view.webview.postMessage as any).mock.calls;
    const activeProjectCalls = calls.filter((c: any) => c[0]?.kind === "active-project");
    expect(activeProjectCalls).toHaveLength(1);
  });
});
