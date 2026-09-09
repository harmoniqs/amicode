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
    // The per-section + button and its dropdown were removed — all actions
    // live in the header bar and empty-area / env-group context menus.
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
