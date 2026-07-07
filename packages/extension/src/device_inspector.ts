import * as vscode from "vscode";
import { inspectorResourceRootDirs } from "./opencode_paths";
import type { DeviceStatus, NextAction } from "./device_status";

// ============================================================================
// Device Inspector — a panel webview showing a device-focused dashboard (Spec A
// §3): drive lines online, per-qubit rollup, latest T1/T2/fidelities with
// staleness, calibration params, and the ranked action list (qilc items locked
// when unentitled).
//
// SIBLING to Raghav's Run Inspector (run_inspector.ts) — NOT a fork SolidJS
// surface, NOT an edit to run_inspector.ts. Same idioms: a WebviewViewProvider +
// registerDeviceInspector(ctx), a typed DEVICE-keyed postMessage protocol, and a
// per-device replay-on-reopen buffer so a reopened panel rebuilds every pane.
//
// The pure projection/action logic lives in device_status.ts (Task 4) over the
// DeviceRegistry state (Task 3) + the qick_client queue (Task 5); this class is
// only the vscode plumbing + the webview shell (CSP + nonce; theme via VS Code
// CSS vars). The message payloads are DeviceStatus / NextAction[] verbatim.
// ============================================================================

let DEVICE_INSPECTOR: DeviceInspectorView | undefined;

/** Everything replayable about one device's pane — kept current whether or not
 *  the webview exists, so resolveWebviewView can rebuild the pane on reopen. */
interface DeviceBuffer {
  device: string;
  status?: DeviceStatus;
  actions?: NextAction[];
}

class DeviceInspectorView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private readonly panes = new Map<string, DeviceBuffer>();
  private activeDevice?: string;

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  private paneFor(device: string): DeviceBuffer {
    let p = this.panes.get(device);
    if (!p) {
      p = { device };
      this.panes.set(device, p);
    }
    return p;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      // Extension assets only — the view renders from message data.
      localResourceRoots: inspectorResourceRootDirs(this.ctx.extensionUri.fsPath).map((d) => vscode.Uri.file(d)),
    };
    view.webview.html = this.renderHtml(view.webview);

    const msgSub = view.webview.onDidReceiveMessage((msg: { type?: string; action?: string }) => {
      if (msg?.type !== "control") return;
      if (msg.action === "refresh") void vscode.commands.executeCommand("amicode.device.refresh");
    });
    view.onDidDispose(() => {
      this.view = undefined;
      msgSub.dispose();
    });

    // Replay EVERY device pane from its buffer (status then actions), then pick
    // the visible pane last (activate is idempotent + last, so it wins).
    for (const p of this.panes.values()) this.replayPane(view, p);
    if (this.activeDevice) view.webview.postMessage({ type: "activate", device: this.activeDevice });
  }

  private replayPane(view: vscode.WebviewView, p: DeviceBuffer): void {
    if (p.status) view.webview.postMessage({ type: "device-status", device: p.device, status: p.status });
    if (p.actions) view.webview.postMessage({ type: "actions", device: p.device, actions: p.actions });
  }

  // -------- public surface used by the poll loop (all device-keyed) --------

  postDeviceStatus(device: string, status: DeviceStatus): void {
    this.paneFor(device).status = status;
    if (this.view) this.view.webview.postMessage({ type: "device-status", device, status });
  }

  postActions(device: string, actions: NextAction[]): void {
    this.paneFor(device).actions = actions;
    if (this.view) this.view.webview.postMessage({ type: "actions", device, actions });
  }

  /** Make `device` the visible pane. Buffered until the webview materializes. */
  activate(device: string): void {
    this.paneFor(device);
    this.activeDevice = device;
    if (this.view) this.view.webview.postMessage({ type: "activate", device });
  }

  reveal(): void {
    vscode.commands.executeCommand("amicode.deviceInspector.focus").then(undefined, () => undefined);
  }

  private renderHtml(webview: vscode.Webview): string {
    const uri = (...parts: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, ...parts));
    const nonce = newNonce();
    // Same security shell as the Run Inspector: CSP + nonce, brand/layout
    // stylesheets, and the TS-composed view bundle. Theme rides VS Code CSS vars
    // under webview.cspSource (brand.css) — NOT the chat iframe's ?colorScheme=.
    // style-src keeps 'unsafe-inline' for runtime element .style / static attrs.
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
  <script nonce="${nonce}" src="${uri("dist", "device_inspector_webview.js")}"></script>
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

export function registerDeviceInspector(ctx: vscode.ExtensionContext): DeviceInspectorView {
  DEVICE_INSPECTOR = new DeviceInspectorView(ctx);
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider("amicode.deviceInspector", DEVICE_INSPECTOR, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
  return DEVICE_INSPECTOR;
}

export function getDeviceInspector(): DeviceInspectorView | undefined {
  return DEVICE_INSPECTOR;
}

export type { DeviceInspectorView };
