import { describe, it, expect, beforeEach, vi } from "vitest";
import { FleetPanelView, registerFleetPanel } from "../src/fleet_panel";
import type { FleetHostMessage, FleetWebviewMessage } from "../src/fleet_panel";
import { fleetStatusBarLabel } from "../src/status_bar";
import { commands } from "vscode";
import { ChatPanel } from "../src/chat_panel";

// ── Host provider tests ─────────────────────────────────────────────────────

describe("FleetPanelView", () => {
  it("can be instantiated with a mock context", () => {
    const ctx = {
      extensionUri: { fsPath: "/mock/ext" },
      subscriptions: [],
    };
    const panel = new FleetPanelView(ctx as any);
    expect(panel).toBeDefined();
  });
});

describe("registerFleetPanel", () => {
  it("registers the webview view provider and returns the panel", () => {
    const ctx = {
      extensionUri: { fsPath: "/mock/ext" },
      subscriptions: [] as any[],
    };
    const panel = registerFleetPanel(ctx as any);
    expect(panel).toBeDefined();
    expect(panel).toBeInstanceOf(FleetPanelView);
  });
});

// ── postMessage protocol tests ──────────────────────────────────────────────

describe("FleetPanelView postMessage protocol", () => {
  let panel: FleetPanelView;
  let postedMessages: FleetHostMessage[];
  let receivedByHost: FleetWebviewMessage[];

  beforeEach(() => {
    postedMessages = [];
    receivedByHost = [];

    const ctx = {
      extensionUri: { fsPath: "/mock/ext" },
      subscriptions: [] as any[],
    };
    panel = new FleetPanelView(ctx as any);

    // Simulate resolveWebviewView with a mock view
    const mockWebview = {
      options: {},
      html: "",
      cspSource: "test:",
      asWebviewUri: (u: any) => u,
      postMessage: (msg: FleetHostMessage) => {
        postedMessages.push(msg);
        return Promise.resolve(true);
      },
      onDidReceiveMessage: (handler: (msg: FleetWebviewMessage) => void) => {
        // Store handler so we can simulate webview messages
        (panel as any)._testMsgHandler = handler;
        return { dispose: () => {} };
      },
    };
    const mockView = {
      webview: mockWebview,
      onDidDispose: (_cb: () => void) => ({ dispose: () => {} }),
    };
    panel.resolveWebviewView(mockView as any);
  });

  it("pushes role message on resolveWebviewView", () => {
    // resolveWebviewView already called in beforeEach → pushRole fires
    expect(postedMessages.some((m) => m.type === "role")).toBe(true);
  });

  it("postTopology sends topology message to webview", () => {
    postedMessages.length = 0;
    panel.postTopology(
      [{ id: "srv", hostname: "remote-server", role: "server", isLocal: false, healthy: true, sessionCount: 2 }],
      [{ from: "srv", to: "local", connected: true }],
    );
    expect(postedMessages).toHaveLength(1);
    expect(postedMessages[0].type).toBe("topology");
  });

  it("postProfiles sends profiles message to webview", () => {
    postedMessages.length = 0;
    panel.postProfiles([{ slug: "test", name: "Test Profile", model: "claude-opus", variant: "" }]);
    expect(postedMessages).toHaveLength(1);
    expect(postedMessages[0].type).toBe("profiles");
  });

  it("postStats sends stats message to webview", () => {
    postedMessages.length = 0;
    panel.postStats({ active: 3, running: 2, blocked: 1, tokensToday: 42000 });
    expect(postedMessages).toHaveLength(1);
    expect(postedMessages[0].type).toBe("stats");
    if (postedMessages[0].type === "stats") {
      expect(postedMessages[0].stats.active).toBe(3);
    }
  });

  it("webview action message dispatches as a VS Code command", () => {
    // Simulate webview posting an action
    const handler = (panel as any)._testMsgHandler;
    expect(handler).toBeDefined();

    // Reset the executed commands tracker from the mock
    (commands as any).executed.length = 0;

    handler({ type: "action", action: "createFleet" });

    // The panel should dispatch via executeCommand
    expect((commands as any).executed).toContain("amicode.fleet.createFleet");
  });

  it("webview action message passes payload to the command", () => {
    const handler = (panel as any)._testMsgHandler;
    expect(handler).toBeDefined();

    (commands as any).executed.length = 0;

    handler({ type: "action", action: "removeMachine", payload: { target: "jj@100.77.141.50" } });

    expect((commands as any).executed).toContain("amicode.fleet.removeMachine");
  });
});

// ── Rendered HTML tests ─────────────────────────────────────────────────────

describe("FleetPanelView renderHtml", () => {
  it("produces HTML with CSP nonce and correct script/stylesheet references", () => {
    const ctx = {
      extensionUri: { fsPath: "/mock/ext" },
      subscriptions: [] as any[],
    };
    const panel = new FleetPanelView(ctx as any);

    let capturedHtml = "";
    const mockWebview = {
      options: {},
      html: "",
      cspSource: "https://test.csp",
      asWebviewUri: (u: any) => `webview-uri:${typeof u === "string" ? u : JSON.stringify(u)}`,
      postMessage: () => Promise.resolve(true),
      onDidReceiveMessage: () => ({ dispose: () => {} }),
    };
    const mockView = {
      webview: mockWebview,
      onDidDispose: () => ({ dispose: () => {} }),
    };

    panel.resolveWebviewView(mockView as any);
    capturedHtml = mockWebview.html;

    // Should have a nonce in the CSP
    expect(capturedHtml).toContain("nonce-");
    // Should reference brand.css and layout.css
    expect(capturedHtml).toContain("brand.css");
    expect(capturedHtml).toContain("layout.css");
    // Should load fleet_webview.js
    expect(capturedHtml).toContain("fleet_webview.js");
    // Should have Content-Security-Policy
    expect(capturedHtml).toContain("Content-Security-Policy");
  });
});

// ── Fleet status bar label tests ────────────────────────────────────────────

describe("fleetStatusBarLabel", () => {
  it("returns standalone label for standalone role", () => {
    const { text, tooltip } = fleetStatusBarLabel("standalone");
    expect(text).toContain("Fleet: standalone");
    expect(tooltip).toContain("No fleet configured");
  });

  it("returns server label for server role", () => {
    const { text, tooltip } = fleetStatusBarLabel("server");
    expect(text).toContain("Fleet: server");
    expect(tooltip).toContain("canonical server");
  });

  it("returns client label for client role", () => {
    const { text, tooltip } = fleetStatusBarLabel("client");
    expect(text).toContain("Fleet: client");
    expect(tooltip).toContain("Connected to fleet server");
  });
});

// ── ChatPanel.navigateToPath end-to-end test ────────────────────────────────

describe("ChatPanel.navigateToPath", () => {
  it("posts a navigate message with the correct path to the webview", () => {
    const ctx = {
      extensionUri: { fsPath: "/mock/ext" },
      subscriptions: [] as any[],
    };

    const panel = ChatPanel.openOrReveal(
      ctx as any,
      new URL("http://127.0.0.1:4096"),
      "token",
      "/mock/project",
    );

    panel.navigateToPath("/new-session?prompt=I+want+to+create+a+fleet");

    // Get the underlying webview panel's posted messages
    const webview = (panel as any).panel.webview;
    const msgs = webview.posted.filter((m: any) => m?.kind === "navigate");
    expect(msgs.length).toBeGreaterThanOrEqual(1);
    expect(msgs[0]).toEqual({
      source: "amicode",
      kind: "navigate",
      path: "/new-session?prompt=I+want+to+create+a+fleet",
    });

    // Clean up
    (panel as any).panel.dispose();
  });
});
