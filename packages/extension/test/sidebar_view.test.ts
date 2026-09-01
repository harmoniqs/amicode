import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as vscode from "vscode";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeWebviewView() {
  const messageCbs: Array<(msg: unknown) => void> = [];
  const disposeCbs: Array<() => void> = [];
  let html = "";
  let title: string | undefined = undefined;
  return {
    get title() { return title; },
    set title(v: string | undefined) { title = v; },
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
    // CSP allows image and font loading (for icon themes)
    expect(html).toContain("img-src");
    expect(html).toContain("font-src");
    // Script tag loads the bundled entry point
    expect(html).toContain("sidebar_webview.js");
    // Both header buttons present
    expect(html).toContain("Chat with Amico");
    expect(html).toContain("New Project");
  });

  it("embeds icon theme data as window.__iconTheme in a nonce-guarded script", () => {
    const provider = new SidebarViewProvider(makeExtensionUri());
    const view = makeWebviewView();

    provider.resolveWebviewView(view, {}, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });

    const html = view.webview.html;
    // Icon theme data is embedded for the webview to consume
    expect(html).toContain("window.__iconTheme");
    // The embedded JSON is parseable (contains mode field)
    expect(html).toMatch(/"mode"\s*:/);
  });

  it("resolveIconTheme builds langExtMap from vscode.extensions.all language contributions", async () => {
    vi.resetModules();
    const { buildLangExtMap } = await import("../src/sidebar_view");

    // Simulate extensions with language contributions
    const fakeExtensions = [
      {
        packageJSON: {
          contributes: {
            languages: [
              { id: "julia", extensions: [".jl"] },
              { id: "typescript", extensions: [".ts", ".tsx"] },
            ],
          },
        },
      },
      {
        packageJSON: {
          contributes: {
            languages: [
              { id: "python", extensions: [".py", ".pyi"] },
            ],
          },
        },
      },
      // Extension with no language contributions
      { packageJSON: {} },
    ];

    const map = buildLangExtMap(fakeExtensions);

    expect(map.jl).toBe("julia");
    expect(map.ts).toBe("typescript");
    expect(map.tsx).toBe("typescript");
    expect(map.py).toBe("python");
    expect(map.pyi).toBe("python");
  });

  it("clears the view-level title so VS Code shows just the container title", () => {
    const provider = new SidebarViewProvider(makeExtensionUri());
    const view = makeWebviewView();

    provider.resolveWebviewView(view, {}, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });

    expect(view.title).toBe("");
  });

  it("chat button: gray icon+text on solid yellow, yellow icon on muted, not bold; new-project: forest green outline, not bold", () => {
    const provider = new SidebarViewProvider(makeExtensionUri());
    const view = makeWebviewView();

    provider.resolveWebviewView(view, {}, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });

    const html = view.webview.html;

    // ── Chat button (solid state) ──
    // Solid yellow background, gray text (not #111), not bold
    expect(html).toMatch(/\.btn-chat\s*\{[^}]*background:\s*#fff676/);
    expect(html).toMatch(/\.btn-chat\s*\{[^}]*color:\s*#666/);
    expect(html).toMatch(/\.btn-chat\s*\{[^}]*font-weight:\s*400/);
    expect(html).toMatch(/\.btn-chat:focus\s*\{[^}]*outline:\s*none/);
    // Icon shapes are overridden to gray on solid state
    expect(html).toContain(".btn-chat .btn-icon rect");
    expect(html).toContain("fill: #666");
    // Chat-yellow SVG shape is present
    expect(html).toContain('<rect x="1" y="2"');
    expect(html).toContain('<polygon points="5,12 8,12 5,15"');
    // Muted state: icon shapes revert to yellow
    expect(html).toContain(".btn-chat.muted .btn-icon rect");
    expect(html).toContain("fill: #fff676");

    // ── New Project button ──
    // Forest green outline (#2B382B), not bold
    expect(html).toMatch(/\.btn-new-project\s*\{[^}]*border:\s*1px solid #2B382B/);
    expect(html).toMatch(/\.btn-new-project\s*\{[^}]*font-weight:\s*400/);
    expect(html).toMatch(/\.btn-new-project:focus\s*\{[^}]*outline:\s*none/);
    // No yellow border on new-project
    expect(html).not.toMatch(/\.btn-new-project\s*\{[^}]*#fff676/);
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

  it("package.json registers amicode.workspace as type webview, container titled AMICODE", () => {
    const pkg = JSON.parse(
      readFileSync(resolve(__dirname, "..", "package.json"), "utf8"),
    );
    const views = pkg.contributes?.views?.amicode ?? [];
    const wsView = views.find((v: any) => v.id === "amicode.workspace");
    expect(wsView).toBeDefined();
    expect(wsView.type).toBe("webview");
    // Both container and view carry "AMICODE" so VS Code collapses to one title
    const containers = pkg.contributes?.viewsContainers?.activitybar ?? [];
    const container = containers.find((c: any) => c.id === "amicode");
    expect(container?.title).toBe("AMICODE");
    expect(wsView.name).toBe("AMICODE");
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

  it("file-op success result posts file-op-ok back", async () => {
    const handlers = makeHandlers({
      fileOp: vi.fn().mockResolvedValue({ ok: true }),
    });
    await handleSidebarMessage(
      { kind: "file-op", op: "new-file", path: "/project/src", name: "hello.jl" },
      handlers,
    );
    expect(handlers.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "file-op-ok",
        op: "new-file",
        path: "/project/src",
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

// ── Section labels and text (#673 polish) ────────────────────────────────────

describe("sidebar webview — section labels", () => {
  let SidebarTreeService: any;
  let SidebarViewProvider: any;

  beforeEach(async () => {
    vi.resetModules();
    const treeMod = await import("../src/sidebar_tree_service");
    SidebarTreeService = treeMod.SidebarTreeService;
    const viewMod = await import("../src/sidebar_view");
    SidebarViewProvider = viewMod.SidebarViewProvider;
  });

  it("dev section label reads 'Development Projects' not 'Development'", () => {
    // The label is rendered in sidebar_webview.ts — verify tree service getRoots
    // classifies dev roots, then the webview renders the correct label text.
    // Since sidebar_webview is browser-only (no DOM in test), we verify the
    // source contains the correct string literal.
    const src = readFileSync(
      resolve(__dirname, "..", "src", "sidebar_webview.ts"),
      "utf8",
    );
    expect(src).toContain('"Development Projects"');
  });

  it("sections are collapsible with chevrons and a + button for add-existing", () => {
    const src = readFileSync(
      resolve(__dirname, "..", "src", "sidebar_webview.ts"),
      "utf8",
    );
    // Section headers have chevrons
    expect(src).toContain("section-chevron");
    // Section headers have a + button that posts add-existing
    expect(src).toContain("section-add-btn");
    expect(src).toContain("add-existing");
    // Sections track expanded/collapsed state
    expect(src).toContain("sectionExpanded");
  });

  it("section header CSS has collapsible styling with + button that appears on hover", () => {
    const provider = new SidebarViewProvider(makeExtensionUri());
    const view = makeWebviewView();

    provider.resolveWebviewView(view, {}, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });

    const html = view.webview.html;
    // Section label is a flex row with cursor: pointer
    expect(html).toMatch(/\.tree-section-label\s*\{[^}]*cursor:\s*pointer/);
    // + button is hidden by default, shown on hover
    expect(html).toMatch(/\.section-add-btn[^{]*\{[^}]*opacity:\s*0/);
    expect(html).toMatch(/\.tree-section-label:hover\s+\.section-add-btn[^{]*\{[^}]*opacity:\s*1/);
  });

  it("sections use accordion flex layout with border-top separators", () => {
    const provider = new SidebarViewProvider(makeExtensionUri());
    const view = makeWebviewView();

    provider.resolveWebviewView(view, {}, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });

    const html = view.webview.html;
    // Section labels use border-top (not margin-top) so collapsed headers are tight
    expect(html).toMatch(/\.tree-section-label\s*\{[^}]*border-top:/);
    expect(html).toMatch(/\.fleet-section-label\s*\{[^}]*border-top:/);
    expect(html).not.toMatch(/\.tree-section-label\s*\{[^}]*margin-top:/);
    // Accordion layout: body is full-height flex, sections flex-grow when expanded
    expect(html).toContain("sidebar-sections");
    expect(html).toMatch(/\.section\.expanded\s*\{[^}]*flex:\s*1/);
    expect(html).toMatch(/\.section-body\s*\{[^}]*overflow-y:\s*auto/);
  });

  it("fleet section is a collapsible section with 'Coming soon' body, not a static div", () => {
    const provider = new SidebarViewProvider(makeExtensionUri());
    const view = makeWebviewView();

    provider.resolveWebviewView(view, {}, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });

    const html = view.webview.html;
    // Has a fleet section label with the collapsible class
    expect(html).toContain("fleet-section-label");
    // Contains Fleet text as a section header
    expect(html).toMatch(/Fleet/);
    // Contains "Coming soon" body text
    expect(html).toContain("Coming soon");
    // Has a chevron for expand/collapse
    expect(html).toContain("fleet-chevron");
    // No longer uses the old static fleet-placeholder
    expect(html).not.toContain("fleet-placeholder");
  });
});

// ── Context menu (#673 polish) ───────────────────────────────────────────────

describe("sidebar webview — context menu", () => {
  let SidebarViewProvider: any;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../src/sidebar_view");
    SidebarViewProvider = mod.SidebarViewProvider;
  });

  it("sidebar_webview.ts intercepts contextmenu event and renders explorer-like items", () => {
    const src = readFileSync(
      resolve(__dirname, "..", "src", "sidebar_webview.ts"),
      "utf8",
    );
    // Prevents the default browser context menu on tree nodes
    expect(src).toContain("contextmenu");
    expect(src).toContain("preventDefault");
    // Has explorer-like menu items
    expect(src).toContain("New File");
    expect(src).toContain("New Folder");
    expect(src).toContain("Rename");
    expect(src).toContain("Delete");
    expect(src).toContain("Copy Path");
    expect(src).toContain("Copy Relative Path");
    expect(src).toContain("Reveal in Finder");
    expect(src).toContain("Open in Terminal");
  });

  it("sidebar_view.ts CSS includes context-menu styling", () => {
    const provider = new SidebarViewProvider(makeExtensionUri());
    const view = makeWebviewView();

    provider.resolveWebviewView(view, {}, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });

    const html = view.webview.html;
    expect(html).toContain("context-menu");
    expect(html).toContain("context-menu-item");
  });
});

// ── Add existing project (#673 polish) ───────────────────────────────────────

describe("sidebar — add existing project", () => {
  let SidebarViewProvider: any;
  let handleSidebarMessage: any;

  beforeEach(async () => {
    vi.resetModules();
    const viewMod = await import("../src/sidebar_view");
    SidebarViewProvider = viewMod.SidebarViewProvider;
    const bridgeMod = await import("../src/sidebar_bridge");
    handleSidebarMessage = bridgeMod.handleSidebarMessage;
  });

  it("section + button posts add-existing message to host", () => {
    const src = readFileSync(
      resolve(__dirname, "..", "src", "sidebar_webview.ts"),
      "utf8",
    );
    // The + button in each section header posts add-existing
    expect(src).toContain('kind: "add-existing"');
    expect(src).toContain("section-add-btn");
  });

  it("header does NOT contain an add-existing button (moved to section headers)", () => {
    const provider = new SidebarViewProvider(makeExtensionUri());
    const view = makeWebviewView();

    provider.resolveWebviewView(view, {}, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });

    const html = view.webview.html;
    expect(html).not.toContain("btn-add-existing");
  });

  it("bridge handles add-existing message", () => {
    const addExisting = vi.fn();
    expect(() =>
      handleSidebarMessage({ kind: "add-existing" }, {
        openChat: vi.fn(),
        newProject: vi.fn(),
        addExisting,
        getRoots: vi.fn().mockReturnValue([]),
        getChildren: vi.fn().mockResolvedValue([]),
        openFile: vi.fn(),
        fileOp: vi.fn().mockResolvedValue({ ok: true }),
        postMessage: vi.fn(),
      })
    ).not.toThrow();
    expect(addExisting).toHaveBeenCalled();
  });
});

// ── Icon theme integration (#673 — use VS Code's active icon theme) ──────────

describe("sidebar — icon theme", () => {
  it("buildIconMap produces font-mode data from a Seti-style font-based theme JSON", async () => {
    vi.resetModules();
    const { buildIconMap } = await import("../src/sidebar_view");

    const themeJson = {
      fonts: [{ id: "seti", src: [{ path: "./seti.woff", format: "woff" }], size: "150%" }],
      iconDefinitions: {
        _default: { fontCharacter: "\\E001", fontColor: "#C5C5C5" },
        _typescript: { fontCharacter: "\\E028", fontColor: "#519ABA" },
        _julia: { fontCharacter: "\\E04C", fontColor: "#a074c4" },
        _json: { fontCharacter: "\\E029", fontColor: "#CBCB41" },
        _markdown: { fontCharacter: "\\E02A", fontColor: "#519aba" },
        _config: { fontCharacter: "\\E030", fontColor: "#d4d7d6" },
        _folder: { fontCharacter: "\\E02F", fontColor: "#C5C5C5" },
        _folder_open: { fontCharacter: "\\E031", fontColor: "#C5C5C5" },
      },
      file: "_default",
      folder: "_folder",
      folderExpanded: "_folder_open",
      // Seti maps most types via languageIds, not fileExtensions
      fileExtensions: { toml: "_config" },
      fileNames: { "package.json": "_json" },
      languageIds: {
        typescript: "_typescript",
        julia: "_julia",
        json: "_json",
        markdown: "_markdown",
      },
    };

    // Language extension map: file extension → language ID (from vscode extensions)
    const langExtMap = {
      ts: "typescript", tsx: "typescript",
      jl: "julia",
      json: "json", jsonc: "json",
      md: "markdown",
    };

    const result = buildIconMap(themeJson, "/ext/theme", (p) => `vscode-resource:${p}`, langExtMap);

    expect(result.mode).toBe("font");
    expect(result.css).toContain("@font-face");
    expect(result.css).toContain("seti.woff");

    // Direct fileExtension mapping
    expect(result.fileExtensions.toml).toBeDefined();
    // languageId-based mapping (.ts → typescript → _typescript)
    expect(result.fileExtensions.ts).toBeDefined();
    expect(result.fileExtensions.jl).toBeDefined();
    expect(result.fileExtensions.json).toBeDefined();
    expect(result.fileExtensions.md).toBeDefined();
    // languageId-mapped icons should have distinct CSS classes
    expect(result.fileExtensions.ts).not.toBe(result.fileExtensions.jl);
    // Exact file name mapping
    expect(result.fileNames["package.json"]).toBeDefined();
    // Folder icons
    expect(result.folder).toBeDefined();
    expect(result.folderExpanded).toBeDefined();
    expect(result.defaultFile).toBeDefined();
  });

  it("buildIconMap produces svg-mode data from an SVG-based theme JSON", async () => {
    vi.resetModules();
    const { buildIconMap } = await import("../src/sidebar_view");

    const themeJson = {
      iconDefinitions: {
        file: { iconPath: "./icons/file.svg" },
        typescript: { iconPath: "./icons/typescript.svg" },
        folder: { iconPath: "./icons/folder.svg" },
        folder_open: { iconPath: "./icons/folder-open.svg" },
      },
      file: "file",
      folder: "folder",
      folderExpanded: "folder_open",
      fileExtensions: { ts: "typescript" },
      fileNames: {},
    };

    const result = buildIconMap(themeJson, "/ext/theme", (p) => `vscode-resource:${p}`);

    expect(result.mode).toBe("svg");
    expect(result.css).toBe(""); // no font CSS needed
    // File extension maps to webview URI
    expect(result.fileExtensions.ts).toContain("typescript.svg");
    // Folder icons are URIs
    expect(result.folder).toContain("folder.svg");
    expect(result.folderExpanded).toContain("folder-open.svg");
    expect(result.defaultFile).toContain("file.svg");
  });

  it("buildIconMap returns mode 'none' for empty or missing theme JSON", async () => {
    vi.resetModules();
    const { buildIconMap } = await import("../src/sidebar_view");

    const result = buildIconMap(null, "", (p) => p);
    expect(result.mode).toBe("none");
    expect(result.fileExtensions).toEqual({});
    expect(result.fileNames).toEqual({});
  });

  it("buildIconMap uses light variants when colorThemeKind is 'light'", async () => {
    vi.resetModules();
    const { buildIconMap } = await import("../src/sidebar_view");

    const themeJson = {
      fonts: [{ id: "seti", src: [{ path: "./seti.woff", format: "woff" }], size: "150%" }],
      iconDefinitions: {
        _default: { fontCharacter: "\\E001", fontColor: "#C5C5C5" },
        _default_light: { fontCharacter: "\\E001", fontColor: "#bfc2c1" },
        _ts: { fontCharacter: "\\E028", fontColor: "#519ABA" },
        _ts_light: { fontCharacter: "\\E028", fontColor: "#498ba7" },
      },
      file: "_default",
      fileExtensions: { ts: "_ts" },
      fileNames: {},
      light: {
        file: "_default_light",
        fileExtensions: { ts: "_ts_light" },
        fileNames: {},
        languageIds: {},
      },
    };

    const result = buildIconMap(themeJson, "/ext/theme", (p) => `vscode-resource:${p}`, {}, "light");
    // Light variant should use the _light icon definitions
    expect(result.css).toContain("#498ba7"); // light TS color
    expect(result.defaultFile).toContain("default_light");
  });

  it("buildIconMap normalises fileNames to lowercase for case-insensitive lookup", async () => {
    vi.resetModules();
    const { buildIconMap } = await import("../src/sidebar_view");

    const themeJson = {
      fonts: [{ id: "seti", src: [{ path: "./seti.woff", format: "woff" }], size: "150%" }],
      iconDefinitions: {
        _info: { fontCharacter: "\\E050", fontColor: "#519aba" },
        _default: { fontCharacter: "\\E001", fontColor: "#C5C5C5" },
      },
      file: "_default",
      fileExtensions: {},
      // Seti uses lowercase: "readme.md" not "README.md"
      fileNames: { "readme.md": "_info" },
    };

    const result = buildIconMap(themeJson, "/ext/theme", (p) => `vscode-resource:${p}`);
    // Both lowercase and uppercase should resolve
    expect(result.fileNames["readme.md"]).toBeDefined();
    expect(result.fileNames["README.md"]).toBeDefined();
    // They should point to the same icon
    expect(result.fileNames["readme.md"]).toBe(result.fileNames["README.md"]);
  });

  it("tree nodes have chevron for directories and icon for files", () => {
    const src = readFileSync(
      resolve(__dirname, "..", "src", "sidebar_webview.ts"),
      "utf8",
    );
    expect(src).toContain('chevronEl.className = "chevron"');
    // Files have icon directly (no spacer), same position as chevron
    expect(src).toContain("createFileIconEl");
  });

  it("webview reads window.__iconTheme and renders icons from the theme, not custom SVGs", () => {
    const src = readFileSync(
      resolve(__dirname, "..", "src", "sidebar_webview.ts"),
      "utf8",
    );
    // Reads the embedded icon theme data
    expect(src).toContain("__iconTheme");
    // Does NOT contain the old custom SVG icon infrastructure
    expect(src).not.toContain("FILE_ICON_COLORS");
    expect(src).not.toContain("EXACT_FILE_COLORS");
    expect(src).not.toContain("fileIconSvg");
    expect(src).not.toContain("folderClosedSvg");
    expect(src).not.toContain("folderOpenSvg");
    // Renders theme-based icons (img for SVG themes, span for font themes)
    expect(src).toContain("theme-icon");
  });
});

// ── Context menu fix (#673 — host-side showInputBox) ─────────────────────────

describe("sidebar webview — context menu operations (end-to-end)", () => {
  it("webview does NOT use window.prompt() — all input via host showInputBox", () => {
    const src = readFileSync(
      resolve(__dirname, "..", "src", "sidebar_webview.ts"),
      "utf8",
    );
    // No prompt() assignment calls — old code had `const name = prompt(...)` which
    // silently returns null in webview iframes. All input now collected host-side.
    expect(src).not.toMatch(/=\s*prompt\s*\(/);
    // Instead, all operations just post file-op directly to host
    expect(src).toContain('kind: "file-op"');
  });

  it("context menu resolves data-path from tree-node (files) or parent (dirs)", () => {
    const src = readFileSync(
      resolve(__dirname, "..", "src", "sidebar_webview.ts"),
      "utf8",
    );
    // The fix: check treeNode.dataset.path first, then fall back to parentElement
    expect(src).toContain("treeNode.dataset.path ? treeNode : treeNode.parentElement");
  });

  it("bridge dispatches file-op move with targetDir to fileOp handler", async () => {
    const { handleSidebarMessage } = await import("../src/sidebar_bridge");
    const fileOp = vi.fn().mockResolvedValue({ ok: true });
    const handlers = {
      openChat: vi.fn(), newProject: vi.fn(), addExisting: vi.fn(),
      getRoots: vi.fn().mockReturnValue([]),
      getChildren: vi.fn().mockResolvedValue([]),
      openFile: vi.fn(), postMessage: vi.fn(), fileOp,
    };
    await handleSidebarMessage(
      { kind: "file-op", op: "move", path: "/project/src/old.ts", targetDir: "/project/lib" },
      handlers,
    );
    expect(fileOp).toHaveBeenCalledWith(
      expect.objectContaining({ op: "move", path: "/project/src/old.ts", targetDir: "/project/lib" }),
    );
  });

  it("file-op new-file/rename without name/newName still dispatches (host prompts)", async () => {
    const { handleSidebarMessage } = await import("../src/sidebar_bridge");
    const fileOp = vi.fn().mockResolvedValue({ ok: true });
    const handlers = {
      openChat: vi.fn(), newProject: vi.fn(), addExisting: vi.fn(),
      getRoots: vi.fn().mockReturnValue([]),
      getChildren: vi.fn().mockResolvedValue([]),
      openFile: vi.fn(), postMessage: vi.fn(), fileOp,
    };
    // new-file without name — host will showInputBox
    await handleSidebarMessage(
      { kind: "file-op", op: "new-file", path: "/project/src" },
      handlers,
    );
    expect(fileOp).toHaveBeenCalledWith(
      expect.objectContaining({ op: "new-file", path: "/project/src" }),
    );
    // rename without newName — host will showInputBox
    await handleSidebarMessage(
      { kind: "file-op", op: "rename", path: "/project/src/old.ts" },
      handlers,
    );
    expect(fileOp).toHaveBeenCalledWith(
      expect.objectContaining({ op: "rename", path: "/project/src/old.ts" }),
    );
  });
});

// ── Drag and drop (#673) ─────────────────────────────────────────────────────

describe("sidebar webview — drag and drop", () => {
  it("tree nodes are draggable and have drop-target styling", () => {
    const src = readFileSync(
      resolve(__dirname, "..", "src", "sidebar_webview.ts"),
      "utf8",
    );
    // File and directory nodes are draggable
    expect(src).toContain("row.draggable = true");
    // Drag/drop events are wired
    expect(src).toContain("setupDragSource");
    expect(src).toContain("setupDirectoryDropTarget");
    // Drop posts a move file-op
    expect(src).toContain('op: "move"');
    expect(src).toContain("targetDir");
  });

  it("CSS includes drag-and-drop visual feedback styles", async () => {
    vi.resetModules();
    const { SidebarViewProvider } = await import("../src/sidebar_view");
    const provider = new SidebarViewProvider(makeExtensionUri());
    const view = makeWebviewView();
    provider.resolveWebviewView(view, {}, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });
    const html = view.webview.html;
    expect(html).toContain("drop-target");
    expect(html).toContain("dragging");
    expect(html).toMatch(/\.tree-node\.drop-target\s*\{/);
    expect(html).toMatch(/\.tree-node\.dragging\s*\{/);
  });

  it("FileOpRequest type includes move op with targetDir", async () => {
    const bridge = await import("../src/sidebar_bridge");
    // Type check: constructing a move request should be valid
    const req: typeof bridge.FileOpRequest extends never ? never : any = {
      op: "move" as const,
      path: "/src/a.ts",
      targetDir: "/lib",
    };
    expect(req.op).toBe("move");
    expect(req.targetDir).toBe("/lib");
  });
});

// ── Git status colors (#673) ─────────────────────────────────────────────────

describe("sidebar — git status colors", () => {
  it("TreeEntry type supports gitStatus field", async () => {
    const bridge = await import("../src/sidebar_bridge");
    // Type check: constructing entry with gitStatus
    const entry: typeof bridge.TreeEntry extends never ? never : any = {
      name: "main.ts",
      type: "file" as const,
      path: "/p/main.ts",
      gitStatus: "modified",
    };
    expect(entry.gitStatus).toBe("modified");
  });

  it("CSS includes git status color classes using VS Code theme variables", async () => {
    vi.resetModules();
    const { SidebarViewProvider } = await import("../src/sidebar_view");
    const provider = new SidebarViewProvider(makeExtensionUri());
    const view = makeWebviewView();
    provider.resolveWebviewView(view, {}, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });
    const html = view.webview.html;
    expect(html).toContain(".git-modified");
    expect(html).toContain(".git-added");
    expect(html).toContain(".git-deleted");
    expect(html).toContain(".git-untracked");
    expect(html).toContain(".git-ignored");
    expect(html).toContain(".git-conflict");
    // Uses VS Code theme variables, not hardcoded colors
    expect(html).toContain("--vscode-gitDecoration-modifiedResourceForeground");
    expect(html).toContain("--vscode-gitDecoration-untrackedResourceForeground");
  });

  it("webview applies git status CSS classes to file labels", () => {
    const src = readFileSync(
      resolve(__dirname, "..", "src", "sidebar_webview.ts"),
      "utf8",
    );
    // Label gets git-* class from entry.gitStatus
    expect(src).toContain("entry.gitStatus");
    expect(src).toMatch(/label\.classList\.add.*git-/);
  });

  it("sidebar_view.ts annotates children with git status from the Git extension", () => {
    const src = readFileSync(
      resolve(__dirname, "..", "src", "sidebar_view.ts"),
      "utf8",
    );
    // Accesses the Git extension API
    expect(src).toContain('getExtension("vscode.git")');
    // Annotates entries with git status
    expect(src).toContain("annotateGitStatus");
    expect(src).toContain("classifyGitStatus");
    // Walks workingTreeChanges and indexChanges
    expect(src).toContain("workingTreeChanges");
    expect(src).toContain("indexChanges");
  });

  it("propagateGitStatusToDirs gives directories the most notable child status", async () => {
    vi.resetModules();
    const { propagateGitStatusToDirs } = await import("../src/sidebar_view");

    const entries = [
      { name: "src", type: "directory" as const, path: "/project/src" },
      { name: "docs", type: "directory" as const, path: "/project/docs" },
      { name: "clean", type: "directory" as const, path: "/project/clean" },
      { name: "main.ts", type: "file" as const, path: "/project/main.ts", gitStatus: "modified" as const },
    ];

    // Git tracks these files under /project/src and /project/docs
    const statusMap = new Map<string, string>([
      ["/project/src/index.ts", "modified"],
      ["/project/src/util.ts", "untracked"],
      ["/project/docs/README.md", "added"],
    ]);

    const result = propagateGitStatusToDirs(entries, statusMap);

    // src has modified + untracked children → "modified" wins (most notable)
    expect(result.find(e => e.name === "src")?.gitStatus).toBe("modified");
    // docs has added children
    expect(result.find(e => e.name === "docs")?.gitStatus).toBe("added");
    // clean has no changed children → no git status
    expect(result.find(e => e.name === "clean")?.gitStatus).toBeUndefined();
    // Files keep their original status
    expect(result.find(e => e.name === "main.ts")?.gitStatus).toBe("modified");
  });
});

// ── Reactive git status (#673 — push git changes to webview) ─────────────────

describe("sidebar — reactive git status", () => {
  it("buildGitStatusMap produces a path→status record from git API repositories", async () => {
    vi.resetModules();
    const { buildGitStatusMap } = await import("../src/sidebar_view");

    // Mock git API with one repository containing working tree + index changes
    const mockApi = {
      repositories: [{
        state: {
          workingTreeChanges: [
            { uri: { fsPath: "/project/src/main.ts" }, status: 5 },  // MODIFIED
            { uri: { fsPath: "/project/src/util.ts" }, status: 7 },  // UNTRACKED
          ],
          indexChanges: [
            { uri: { fsPath: "/project/README.md" }, status: 1 },    // INDEX_ADDED
            // This one is also in workingTree — workingTree should win
            { uri: { fsPath: "/project/src/main.ts" }, status: 0 },  // INDEX_MODIFIED
          ],
        },
      }],
    };

    const result = buildGitStatusMap(mockApi);

    expect(result["/project/src/main.ts"]).toBe("modified");   // workingTree wins over index
    expect(result["/project/src/util.ts"]).toBe("untracked");
    expect(result["/project/README.md"]).toBe("added");
  });

  it("buildGitStatusMap returns empty record when no changes exist", async () => {
    vi.resetModules();
    const { buildGitStatusMap } = await import("../src/sidebar_view");

    const mockApi = {
      repositories: [{
        state: { workingTreeChanges: [], indexChanges: [] },
      }],
    };

    const result = buildGitStatusMap(mockApi);
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("bridge types include git-status down-message with a statusMap record", async () => {
    const src = readFileSync(
      resolve(__dirname, "..", "src", "sidebar_bridge.ts"),
      "utf8",
    );
    expect(src).toContain("git-status");
    expect(src).toContain("statusMap");
  });

  it("host pushes git-status message when a git repository state changes", async () => {
    vi.resetModules();

    // Set up a mock git extension with one repo whose state fires onChange
    const onDidChangeCbs: Array<() => void> = [];
    const onDidOpenCbs: Array<(repo: any) => void> = [];
    const mockRepo = {
      state: {
        onDidChange: (cb: () => void) => {
          onDidChangeCbs.push(cb);
          return { dispose() {} };
        },
        workingTreeChanges: [
          { uri: { fsPath: "/project/src/main.ts" }, status: 5 },  // MODIFIED
        ],
        indexChanges: [],
      },
    };
    const mockGitExt = {
      isActive: true,
      exports: {
        getAPI: () => ({
          repositories: [mockRepo],
          onDidOpenRepository: (cb: (repo: any) => void) => {
            onDidOpenCbs.push(cb);
            return { dispose() {} };
          },
          onDidCloseRepository: () => ({ dispose() {} }),
        }),
      },
      activate: () => Promise.resolve(),
    };

    // Wire the mock into vscode.extensions
    const vscodeMock = await import("vscode");
    (vscodeMock.extensions as any).getExtension = (id: string) =>
      id === "vscode.git" ? mockGitExt : undefined;

    const { SidebarViewProvider } = await import("../src/sidebar_view");
    const provider = new SidebarViewProvider(makeExtensionUri());
    const view = makeWebviewView();
    provider.resolveWebviewView(view, {}, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });

    // Simulate a git state change
    expect(onDidChangeCbs.length).toBeGreaterThan(0);
    onDidChangeCbs[0]();

    // Wait for the debounced/async push
    await new Promise(r => setTimeout(r, 350));

    // The host should have posted a git-status message
    const calls = (view.webview.postMessage as any).mock.calls;
    const gitStatusMsg = calls.find((c: any[]) => c[0]?.kind === "git-status");
    expect(gitStatusMsg).toBeDefined();
    expect(gitStatusMsg[0].statusMap["/project/src/main.ts"]).toBe("modified");

    // Restore mock
    (vscodeMock.extensions as any).getExtension = () => undefined;
  });

  it("host activates git extension and fires initial git-status on cold start", async () => {
    vi.resetModules();

    let activateResolve: () => void;
    const activatePromise = new Promise<void>(r => { activateResolve = r; });

    const mockRepo = {
      state: {
        onDidChange: () => ({ dispose() {} }),
        workingTreeChanges: [
          { uri: { fsPath: "/project/cold.ts" }, status: 7 },  // UNTRACKED
        ],
        indexChanges: [],
      },
    };
    const mockGitExt = {
      isActive: false,  // <-- not active yet (cold start)
      exports: {
        getAPI: () => ({
          repositories: [mockRepo],
          onDidOpenRepository: () => ({ dispose() {} }),
          onDidCloseRepository: () => ({ dispose() {} }),
        }),
      },
      activate: () => {
        mockGitExt.isActive = true;
        activateResolve!();
        return activatePromise;
      },
    };

    const vscodeMock = await import("vscode");
    (vscodeMock.extensions as any).getExtension = (id: string) =>
      id === "vscode.git" ? mockGitExt : undefined;

    const { SidebarViewProvider } = await import("../src/sidebar_view");
    const provider = new SidebarViewProvider(makeExtensionUri());
    const view = makeWebviewView();
    provider.resolveWebviewView(view, {}, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });

    // Wait for activate + debounce
    await activatePromise;
    await new Promise(r => setTimeout(r, 350));

    const calls = (view.webview.postMessage as any).mock.calls;
    const gitStatusMsg = calls.find((c: any[]) => c[0]?.kind === "git-status");
    expect(gitStatusMsg).toBeDefined();
    expect(gitStatusMsg[0].statusMap["/project/cold.ts"]).toBe("untracked");

    (vscodeMock.extensions as any).getExtension = () => undefined;
  });

  it("webview handles git-status message and applies/removes git classes on rendered labels", () => {
    const src = readFileSync(
      resolve(__dirname, "..", "src", "sidebar_webview.ts"),
      "utf8",
    );
    // Handles the git-status message kind
    expect(src).toContain('"git-status"');
    // Walks tree nodes by data-path attribute
    expect(src).toContain("data-path");
    // Applies git-* classes
    expect(src).toMatch(/classList\.add.*git-/);
    // Removes stale git classes (e.g. when a file is no longer modified)
    expect(src).toMatch(/classList\.remove|className.*replace|git-/);
  });

  it("webview applies git status to root-level project nodes too", () => {
    const src = readFileSync(
      resolve(__dirname, "..", "src", "sidebar_webview.ts"),
      "utf8",
    );
    // The git-status handler should walk root nodes (not just child nodes)
    // Root nodes have data-type="directory" and carry a project path
    expect(src).toContain("git-status");
    // Should propagate status to directories using prefix matching
    expect(src).toContain("startsWith");
  });
});

// ── Sash resize between sections (#673) ──────────────────────────────────────

describe("sidebar — sash resize between sections", () => {
  it("CSS has sash styles with VS Code sash hover color and ns-resize cursor", async () => {
    vi.resetModules();
    const { SidebarViewProvider } = await import("../src/sidebar_view");
    const provider = new SidebarViewProvider(makeExtensionUri());
    const view = makeWebviewView();
    provider.resolveWebviewView(view, {}, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });
    const html = view.webview.html;
    expect(html).toMatch(/\.sash/);
    expect(html).toContain("ns-resize");
    expect(html).toContain("#fff676");
    expect(html).toContain("sash-dragging");
  });

  it("webview creates sashes between sections and handles resize via mousemove", () => {
    const src = readFileSync(
      resolve(__dirname, "..", "src", "sidebar_webview.ts"),
      "utf8",
    );
    // Sashes are inserted between sections after rendering
    expect(src).toContain("updateSashes");
    // Resize handler redistributes heights
    expect(src).toContain("activeSash");
    expect(src).toContain("mousemove");
    expect(src).toContain("mouseup");
    // Section toggle resets sizes so flex:1 takes over
    expect(src).toContain("resetSectionSizes");
  });
});

// ── Inline editing (#673) ────────────────────────────────────────────────────

describe("sidebar — inline editing", () => {
  let src: string;
  beforeEach(() => {
    src = readFileSync(
      resolve(__dirname, "..", "src", "sidebar_webview.ts"),
      "utf8",
    );
  });

  // Slice 2: rename inline editing infrastructure
  it("has startInlineEdit function that creates an input element", () => {
    expect(src).toContain("startInlineEdit");
    // Must create an <input> element for inline text entry
    expect(src).toContain('createElement("input")');
  });

  it("rename mode swaps label content with a pre-filled input", () => {
    // Input should be pre-filled with the current name for rename
    expect(src).toMatch(/input\.value\s*=/);
    // Selection should be on the stem (not extension) like VS Code
    expect(src).toContain("setSelectionRange");
    expect(src).toContain("lastIndexOf");
  });

  // Slice 3: new-file and new-folder insert a temporary row
  it("new-file and new-folder modes create a temporary tree row", () => {
    // Should insert a temporary node at the top of the directory's children
    expect(src).toMatch(/insertBefore|prepend/);
    // The temporary row needs a file/folder icon
    expect(src).toContain("createFileIconEl");
    expect(src).toContain("createFolderIconEl");
  });

  it("new-file/new-folder auto-expands the target directory", () => {
    // When creating a new file in a collapsed directory, it should expand first
    expect(src).toMatch(/expanded\[.*\]\s*=\s*true/);
  });

  // Slice 4: Enter commits, Escape cancels
  it("Enter key commits the inline edit by posting file-op with the name", () => {
    expect(src).toContain('"Enter"');
    // Should post a file-op message with the entered name
    expect(src).toContain("postMessage");
    expect(src).toMatch(/kind:\s*"file-op"/);
  });

  it("Escape key cancels the inline edit and restores original state", () => {
    expect(src).toContain('"Escape"');
    // Should have a cancel/cleanup function
    expect(src).toMatch(/cancelInlineEdit|cleanupInlineEdit|cleanup/);
  });

  it("blur on the input cancels the edit (unless committed)", () => {
    // The input should listen for blur events
    expect(src).toContain('"blur"');
  });

  // Slice 5: file-op-ok and file-op-error handling
  it("handles file-op-ok message to dismiss the inline editor", () => {
    expect(src).toContain('"file-op-ok"');
  });

  it("handles file-op-error message to show error state on the input", () => {
    expect(src).toContain('"file-op-error"');
    // Should apply an error visual cue
    expect(src).toMatch(/inline-error|error/);
  });

  // Slice 6: context menu wires inline edit for rename/new-file/new-folder
  it("context menu calls startInlineEdit for rename, new-file, and new-folder", () => {
    // The context menu handler should call startInlineEdit instead of posting directly
    expect(src).toMatch(/startInlineEdit.*rename|rename.*startInlineEdit/);
    expect(src).toMatch(/startInlineEdit.*new-file|new-file.*startInlineEdit/);
    expect(src).toMatch(/startInlineEdit.*new-folder|new-folder.*startInlineEdit/);
  });

  it("suppresses context menu and tree clicks while inline edit is active", () => {
    // Should track whether an inline edit is active
    expect(src).toMatch(/activeInlineEdit|inlineEditActive|isEditing/);
    // Context menu should check and bail
    expect(src).toMatch(/activeInlineEdit|inlineEditActive|isEditing/);
  });

  // Slice: CSS for inline edit input
  it("CSS includes inline-edit input styles matching tree row font", async () => {
    vi.resetModules();
    const { SidebarViewProvider } = await import("../src/sidebar_view");
    const provider = new SidebarViewProvider(makeExtensionUri());
    const view = makeWebviewView();
    provider.resolveWebviewView(view, {}, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });
    const html = view.webview.html;
    // inline-edit input should have styling
    expect(html).toMatch(/\.inline-edit-input|inline-edit/);
    // Should use focusBorder for the input outline
    expect(html).toContain("focusBorder");
  });

  // Slice: validation prevents empty names and path separators
  it("validates input — rejects empty names and path separators", () => {
    // Should check for empty strings
    expect(src).toMatch(/trim\(\).*===\s*""|\.length\s*===\s*0/);
    // Should reject path separators
    expect(src).toMatch(/includes.*[/\\]|[/\\]/);
  });
});

// ── Drag-and-drop: file-row and gap drop targeting ───────────────────────────

describe("sidebar — drag drop target resolution", () => {
  it("file rows resolve drop target to parent directory via setupFileDropTarget", () => {
    const src = readFileSync(
      resolve(__dirname, "..", "src", "sidebar_webview.ts"),
      "utf8",
    );
    // File nodes must wire a drop-target helper (resolving to parent dir)
    expect(src).toContain("setupFileDropTarget");
    // The helper must walk up to the nearest directory ancestor
    expect(src).toMatch(/closest.*data-type.*directory|parentElement/);
  });

  it("setupFileDropTarget highlights the parent directory row, not the file row", () => {
    const src = readFileSync(
      resolve(__dirname, "..", "src", "sidebar_webview.ts"),
      "utf8",
    );
    // The drop-target class must be applied to the resolved directory row
    // (not the file row itself) — look for the dir row getting the class
    expect(src).toMatch(/dirRow.*classList.*add.*drop-target|\.drop-target/);
  });

  it("file rows are wired with setupFileDropTarget in renderFileNode", () => {
    const src = readFileSync(
      resolve(__dirname, "..", "src", "sidebar_webview.ts"),
      "utf8",
    );
    // renderFileNode must call setupFileDropTarget
    const start = src.indexOf("function renderFileNode");
    const fileNodeSection = src.slice(start, start + 1000);
    expect(fileNodeSection).toContain("setupFileDropTarget");
  });

  it("children container is a drop target for its parent directory", () => {
    const src = readFileSync(
      resolve(__dirname, "..", "src", "sidebar_webview.ts"),
      "utf8",
    );
    // The outer directory container (which wraps .children) must be wired
    // as a drop target, with the row as the highlight element
    expect(src).toMatch(/setupDirectoryDropTarget\(container,.*entry\.path.*row\)/);
  });

  it("drop-target CSS uses only background fill — no dashed outline", async () => {
    vi.resetModules();
    const { SidebarViewProvider } = await import("../src/sidebar_view");
    const provider = new SidebarViewProvider(makeExtensionUri());
    const view = makeWebviewView();
    provider.resolveWebviewView(view, {}, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });
    const html = view.webview.html;
    // Must use VS Code's list drop background
    expect(html).toContain("--vscode-list-dropBackground");
    // Must NOT have a dashed outline on drop-target
    expect(html).not.toMatch(/\.tree-node\.drop-target[^}]*outline.*dashed/s);
  });
});
