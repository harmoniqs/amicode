// sidebar_actions.test.ts — + dropdown, context menus, bridge change (#916).
// Part of #911 (nest environments in research section).
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const webviewSrc = readFileSync(
  resolve(__dirname, "..", "src", "sidebar_webview.ts"),
  "utf8",
);
const bridgeSrc = readFileSync(
  resolve(__dirname, "..", "src", "sidebar_bridge.ts"),
  "utf8",
);

describe("sidebar + dropdown removed — actions in context menus (#916)", () => {
  it("no section-add-dropdown (section + buttons removed)", () => {
    // The per-section + button and its dropdown were removed — actions live
    // as icon buttons on the section label bars and in the empty-area /
    // env-group context menus.
    expect(webviewSrc).not.toContain("section-add-dropdown");
    expect(webviewSrc).not.toContain("section-add-btn");
  });

  it("context menus still contain New Project, New Environment, Add Existing Project, Add Existing Environment", () => {
    expect(webviewSrc).toMatch(/New Project/);
    expect(webviewSrc).toMatch(/New Environment/);
    expect(webviewSrc).toMatch(/Add Existing Project/);
    expect(webviewSrc).toMatch(/Add Existing Environment/);
  });
});

describe("sidebar empty-state context menu (#916)", () => {
  it("research section empty-area menu includes all 4 actions", () => {
    // The empty-area menu for research should have all 4 items
    expect(webviewSrc).toMatch(/New Project/);
    expect(webviewSrc).toMatch(/New Environment/);
    expect(webviewSrc).toMatch(/Add Existing Project/);
    expect(webviewSrc).toMatch(/Add Existing Environment/);
  });
});

describe("sidebar env group context menu (#916)", () => {
  it("env group header gets a context menu on right-click", () => {
    expect(webviewSrc).toMatch(/env-group|envGroup/);
    expect(webviewSrc).toMatch(/New Project in this Environment/);
  });

  it("context menu includes Reveal in Finder with op reveal-in-os", () => {
    expect(webviewSrc).toMatch(/reveal-in-os/);
  });

  it("context menu shows Add to Workspace for resolved environments", () => {
    expect(webviewSrc).toMatch(/add-to-workspace/);
  });

  it("context menu shows Remove from Workspace for workspace environments", () => {
    expect(webviewSrc).toMatch(/remove-from-workspace/);
  });
});

describe("sidebar bridge — NewProjectMessage environmentSlug (#916)", () => {
  it("NewProjectMessage type includes optional environmentSlug field", () => {
    expect(bridgeSrc).toMatch(/NewProjectMessage.*environmentSlug|environmentSlug.*NewProjectMessage/s);
  });

  it("handleSidebarMessage passes environmentSlug to newProject handler", () => {
    expect(bridgeSrc).toMatch(/environmentSlug/);
  });

  it("SidebarMessageHandlers.newProject accepts optional environmentSlug parameter", () => {
    expect(bridgeSrc).toMatch(/newProject.*environmentSlug|environmentSlug.*newProject/s);
  });
});

describe("sidebar bridge — handleSidebarMessage dispatches new-project with slug", () => {
  it("passes environmentSlug from msg to handler", async () => {
    const { handleSidebarMessage } = await import("../src/sidebar_bridge");
    const handlers = {
      openChat: vi.fn(),
      newProject: vi.fn(),
      addExisting: vi.fn(),
      newEnvironment: vi.fn(),
      addExistingEnvironment: vi.fn(),
      getRoots: vi.fn(() => []),
      getChildren: vi.fn(async () => []),
      openFile: vi.fn(),
      fileOp: vi.fn(async () => ({ ok: true })),
      postMessage: vi.fn(),
      setSectionOrder: vi.fn(),
      reorderRoot: vi.fn(),
    };

    handleSidebarMessage({ kind: "new-project", environmentSlug: "spin-qubit" } as any, handlers);
    expect(handlers.newProject).toHaveBeenCalledWith("spin-qubit");

    handlers.newProject.mockClear();
    handleSidebarMessage({ kind: "new-project" } as any, handlers);
    expect(handlers.newProject).toHaveBeenCalledWith(undefined);
  });
});

describe("sidebar bridge — handleSidebarMessage dispatches focus-machine (#1451)", () => {
  it("routes a focus-machine up-message to the focusMachine handler, never to connect-to-device", async () => {
    const { handleSidebarMessage } = await import("../src/sidebar_bridge");
    const focusMachine = vi.fn();
    const connectToDevice = vi.fn();
    const handlers = {
      openChat: vi.fn(),
      newProject: vi.fn(),
      addExisting: vi.fn(),
      newEnvironment: vi.fn(),
      addExistingEnvironment: vi.fn(),
      getRoots: vi.fn(() => []),
      getChildren: vi.fn(async () => []),
      openFile: vi.fn(),
      fileOp: vi.fn(async () => ({ ok: true })),
      postMessage: vi.fn(),
      setSectionOrder: vi.fn(),
      reorderRoot: vi.fn(),
      connectToDevice,
      focusMachine,
    };

    handleSidebarMessage(
      { kind: "focus-machine", machineId: "mac-studio-01", isLocal: false } as any,
      handlers as any,
    );
    expect(focusMachine).toHaveBeenCalledTimes(1);
    expect(focusMachine).toHaveBeenCalledWith({
      kind: "focus-machine",
      machineId: "mac-studio-01",
      isLocal: false,
    });
    // Focus and connect are INDEPENDENT (AC2): a focus-machine dispatch never
    // fires the connect-to-device handler.
    expect(connectToDevice).not.toHaveBeenCalled();
  });

  it("routes connect-to-device to connectToDevice, never to focusMachine (the other direction)", async () => {
    const { handleSidebarMessage } = await import("../src/sidebar_bridge");
    const focusMachine = vi.fn();
    const connectToDevice = vi.fn();
    handleSidebarMessage(
      { kind: "connect-to-device", machineId: "mac-studio-01", deviceName: "Mac Studio", isLocal: false } as any,
      { connectToDevice, focusMachine } as any,
    );
    expect(connectToDevice).toHaveBeenCalledTimes(1);
    expect(focusMachine).not.toHaveBeenCalled();
  });
});

// ── Section-label actions: New Project / Add Existing on Research + Development ──

describe("section header actions (Research / Development label bars)", () => {
  it("renderSectionHeader takes an actions list and renders a .section-actions group", () => {
    expect(webviewSrc).toMatch(/function renderSectionHeader\([\s\S]*?actions: SectionAction\[\]/);
    expect(webviewSrc).toContain('actionsEl.className = "section-actions"');
    expect(webviewSrc).toContain('btn.className = "section-action"');
  });

  it("Research and Development each get their own actions; Fleet gets none", () => {
    expect(webviewSrc).toMatch(/renderSectionHeader\("Research", "research", researchSectionActions\(\)\)/);
    expect(webviewSrc).toMatch(/renderSectionHeader\("Development", "dev", devSectionActions\(\)\)/);
    expect(webviewSrc).toMatch(/renderSectionHeader\("Fleet", "fleet"\)/);
  });

  it("research actions post new-project and add-existing and are named for assistive tech", () => {
    const start = webviewSrc.indexOf("function researchSectionActions");
    expect(start).toBeGreaterThan(-1);
    const block = webviewSrc.slice(start, webviewSrc.indexOf("function devSectionActions"));
    expect(block).toContain('label: "New Project"');
    expect(block).toContain('kind: "new-project"');
    expect(block).toContain('label: "Add Existing Project"');
    expect(block).toContain('kind: "add-existing"');
    expect(webviewSrc).toContain('btn.setAttribute("aria-label", action.label)');
    expect(webviewSrc).toContain("btn.title = action.label");
  });

  it("the Development '+' never launches a chat: it opens the create menu or posts new-dev-folder", () => {
    const start = webviewSrc.indexOf("function devSectionActions");
    expect(start).toBeGreaterThan(-1);
    const block = webviewSrc.slice(start, webviewSrc.indexOf("type CreateMenuItem"));
    expect(block).toContain('label: "New File or Folder"');
    expect(block).toContain("openDevCreateMenu(anchor)");
    expect(block).toContain('kind: "new-dev-folder"');
    expect(block).toContain('kind: "add-existing"');
    expect(block).not.toContain('kind: "new-project"');
  });

  it("the Development create menu offers New File / New Folder into the dev root and New Project Folder", () => {
    const start = webviewSrc.indexOf("function devCreateMenuItems");
    expect(start).toBeGreaterThan(-1);
    const block = webviewSrc.slice(start, webviewSrc.indexOf("function appendMenuItems"));
    expect(block).toContain('label: "New File"');
    expect(block).toContain('label: "New Folder"');
    expect(block).toContain('startInlineEditInRoot("new-file", target)');
    expect(block).toContain('startInlineEditInRoot("new-folder", target)');
    expect(block).toContain('label: "New Project Folder…"');
    expect(block).toContain('kind: "new-dev-folder"');
    expect(block).not.toContain('kind: "new-project"');
  });

  it("New File / New Folder target the active dev root, else the first dev root", () => {
    const start = webviewSrc.indexOf("function devTargetRoot");
    expect(start).toBeGreaterThan(-1);
    const block = webviewSrc.slice(start, webviewSrc.indexOf("function startInlineEditInRoot"));
    expect(block).toContain('r.projectType === "dev"');
    expect(block).toContain("pendingActiveProject?.path");
    expect(block).toContain("?? devRoots[0]");
  });

  it("the Development empty-area context menu uses the same create items, not the research New Project chat", () => {
    const start = webviewSrc.indexOf("// Dev section: plain filesystem creation");
    expect(start).toBeGreaterThan(-1);
    const block = webviewSrc.slice(start, start + 500);
    expect(block).toContain("devCreateMenuItems()");
    expect(block).toContain('label: "Add Existing Project"');
    expect(block).not.toContain('kind: "new-project"');
  });

  it("bridge dispatches new-dev-folder to the newDevFolder handler", async () => {
    const { handleSidebarMessage } = await import("../src/sidebar_bridge");
    const newDevFolder = vi.fn();
    const newProject = vi.fn();
    handleSidebarMessage({ kind: "new-dev-folder" } as any, { newDevFolder, newProject } as any);
    expect(newDevFolder).toHaveBeenCalledTimes(1);
    expect(newProject).not.toHaveBeenCalled();
  });

  it("bridge tolerates a missing newDevFolder handler", async () => {
    const { handleSidebarMessage } = await import("../src/sidebar_bridge");
    expect(() => handleSidebarMessage({ kind: "new-dev-folder" } as any, {} as any)).not.toThrow();
  });

  it("an action click neither toggles the section nor starts a section drag", () => {
    // Both the header click (collapse toggle) and the drag mousedown bail
    // when the event originates inside .section-actions.
    const guards = webviewSrc.match(/closest\("\.section-actions"\)\) return;/g) ?? [];
    expect(guards.length).toBe(2);
  });

  it("the header bar no longer wires the old project buttons", () => {
    expect(webviewSrc).not.toContain("btn-new-project");
    expect(webviewSrc).not.toContain("btn-existing-project");
  });
});
