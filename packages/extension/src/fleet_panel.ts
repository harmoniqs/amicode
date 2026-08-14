// Fleet Panel — a VS Code native webview in the activity bar showing fleet
// topology, profiles, and aggregate stats. Follows the Device Inspector pattern
// (WebviewViewProvider + typed postMessage + TS-composed DOM). Always visible
// (no context-key gate) — standalone users still benefit from profiles + launch.
//
// Part of #350 (Fleet Panel & Profile UI).

import * as vscode from "vscode";
import { inspectorResourceRootDirs } from "./opencode_paths";
import { getFleetRole, readFleetConfig } from "./fleet_fallback";

// ============================================================================
// Message protocol (host ↔ webview)
// ============================================================================

/** Messages the host sends TO the webview. */
export type FleetHostMessage =
  | { type: "topology"; nodes: FleetNode[]; edges: FleetEdge[] }
  | { type: "profiles"; profiles: FleetProfileSummary[] }
  | { type: "stats"; stats: FleetStats }
  | { type: "role"; role: "standalone" | "server" | "client"; hasCanonical: boolean }
  | { type: "compat"; state: "compatible" | "degraded" | "incompatible"; message: string };

/** Messages the webview sends TO the host. */
export type FleetWebviewMessage =
  | { type: "action"; action: string; payload?: Record<string, unknown> }
  | { type: "log"; text: string };

export interface FleetNode {
  id: string;
  hostname: string;
  role: "server" | "client";
  isLocal: boolean;
  healthy: boolean;
  lastSeen?: string;
  sessionCount: number;
}

export interface FleetEdge {
  from: string;
  to: string;
  connected: boolean;
}

export interface FleetProfileSummary {
  slug: string;
  name: string;
  model: string;
  variant: string;
}

export interface FleetStats {
  active: number;
  running: number;
  blocked: number;
  tokensToday: number;
}

// ============================================================================
// FleetPanelView — the WebviewViewProvider
// ============================================================================

let FLEET_PANEL: FleetPanelView | undefined;

export class FleetPanelView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private currentRole: "standalone" | "server" | "client" = "standalone";

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.currentRole = getFleetRole();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: inspectorResourceRootDirs(this.ctx.extensionUri.fsPath).map(
        (d) => vscode.Uri.file(d),
      ),
    };
    view.webview.html = this.renderHtml(view.webview);

    const msgSub = view.webview.onDidReceiveMessage((msg: FleetWebviewMessage) => {
      this.handleMessage(msg);
    });
    view.onDidDispose(() => {
      this.view = undefined;
      msgSub.dispose();
    });

    // Push initial state
    this.pushRole();
  }

  // ── Public surface (used by the extension to push data) ──────────────────

  /** Push a topology update to the webview. */
  postTopology(nodes: FleetNode[], edges: FleetEdge[]): void {
    this.post({ type: "topology", nodes, edges });
  }

  /** Push updated profile list to the webview. */
  postProfiles(profiles: FleetProfileSummary[]): void {
    this.post({ type: "profiles", profiles });
  }

  /** Push aggregate stats to the webview. */
  postStats(stats: FleetStats): void {
    this.post({ type: "stats", stats });
  }

  /** Push compatibility status to the webview. */
  postCompat(state: "compatible" | "degraded" | "incompatible", message: string): void {
    this.post({ type: "compat", state, message });
  }

  /** Push the current fleet role (standalone/server/client). */
  pushRole(): void {
    this.currentRole = getFleetRole();
    const cfg = readFleetConfig();
    const hasCanonical = !!(cfg?.canonical?.host);
    this.post({ type: "role", role: this.currentRole, hasCanonical });
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private post(msg: FleetHostMessage): void {
    if (this.view) void this.view.webview.postMessage(msg);
  }

  private handleMessage(msg: FleetWebviewMessage): void {
    if (msg.type === "log") return; // dev logging, ignore
    if (msg.type === "action") {
      // Dispatch actions from the webview (wizard steps, profile CRUD, etc.)
      void vscode.commands.executeCommand(`amicode.fleet.${msg.action}`, msg.payload);
    }
  }

  private renderHtml(webview: vscode.Webview): string {
    const uri = (...parts: string[]) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, ...parts));
    const nonce = newNonce();
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             script-src 'nonce-${nonce}';
             style-src ${webview.cspSource} 'unsafe-inline';
             font-src ${webview.cspSource};">
  <link rel="stylesheet" href="${uri("media", "brand.css")}" />
  <link rel="stylesheet" href="${uri("media", "layout.css")}" />
</head>
<body>
  <script nonce="${nonce}" src="${uri("dist", "fleet_webview.js")}"></script>
</body>
</html>`;
  }
}

function newNonce(): string {
  let s = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// ============================================================================
// Registration + access
// ============================================================================

export function registerFleetPanel(ctx: vscode.ExtensionContext): FleetPanelView {
  FLEET_PANEL = new FleetPanelView(ctx);
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider("amicode.fleet", FLEET_PANEL, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
  return FLEET_PANEL;
}

export function getFleetPanel(): FleetPanelView | undefined {
  return FLEET_PANEL;
}
