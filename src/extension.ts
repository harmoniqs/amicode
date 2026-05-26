import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import { ServerManager } from "./server_manager";
import { ChatPanel } from "./chat_panel";
import { CallbackServer } from "./callback_server";
import { registerRunInspector } from "./run_inspector";
import { registerTrees } from "./trees";
import { StatusBarManager } from "./status_bar";
import { prepareOpencodeProject } from "./opencode_config";
import { OpencodeEventClient } from "./sse_client";

// ============================================================================
// Extension entry point. Boot order on activate:
//   1. Register UI surfaces (trees, inspector, status bar, commands)
//   2. Spawn CallbackServer (Channel 2) on a free port — we need the URL
//      before launching opencode so we can pass it via env to amico-mcp
//   3. Write a workspace-scoped .opencode/config.json with mcp.amico pointed
//      at dist/amico-mcp.js and AMICODE_EXTENSION_URL set
//   4. Spawn ServerManager (opencode serve) with cwd=<that project dir>
//   5. When ready, expose the URL to the chat panel command
// ============================================================================

let serverManager: ServerManager | undefined;
let callbackServer: CallbackServer | undefined;
let statusBar: StatusBarManager | undefined;
let sseClient: OpencodeEventClient | undefined;
let opencodeReadyUrl: URL | undefined;

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  const opencodeChannel = vscode.window.createOutputChannel("Amicode — opencode");
  const callbackChannel = vscode.window.createOutputChannel("Amicode — callback");
  ctx.subscriptions.push(opencodeChannel, callbackChannel);

  // 1. UI surfaces
  registerTrees(ctx);
  registerRunInspector(ctx);
  statusBar = new StatusBarManager();
  ctx.subscriptions.push({ dispose: () => statusBar?.dispose() });

  // 2. Callback HTTP server — must be up before opencode starts.
  callbackServer = new CallbackServer({ channel: callbackChannel });
  const callbackUrl = await callbackServer.start();
  ctx.subscriptions.push(callbackServer);

  // 3. opencode project bootstrap — write config + symlink plugin
  const distDir = path.join(ctx.extensionPath, "dist");
  const juliaScript = resolveJuliaScript(ctx);
  const juliaProject = resolveJuliaProject();
  const opencodeProject = prepareOpencodeProject({
    distDir,
    extensionCallbackUrl: callbackUrl,
    juliaScriptPath: juliaScript,
    juliaProject,
  });
  opencodeChannel.appendLine(`[boot] opencode project dir: ${opencodeProject.projectDir}`);
  opencodeChannel.appendLine(`[boot] config: ${opencodeProject.configPath}`);

  // 4. Spawn opencode
  const binary = vscode.workspace.getConfiguration("amicode").get<string>("opencodeBinary", "opencode");
  serverManager = new ServerManager({
    binary,
    cwd: opencodeProject.projectDir,
    env: { AMICODE_EXTENSION_URL: callbackUrl },
    channel: opencodeChannel,
  });
  ctx.subscriptions.push({ dispose: () => serverManager?.stop() });

  // SSE event channel — opens once opencode is healthy.
  sseClient = new OpencodeEventClient({ channel: opencodeChannel, statusBar });
  ctx.subscriptions.push(sseClient);

  serverManager.onReady((url) => {
    opencodeReadyUrl = url;
    statusBar?.setServerReady(true);
    sseClient?.connect(url);
    // Optional: auto-open chat once on first ready. Disabled to avoid
    // hijacking the user's editor space at activation.
    // ChatPanel.openOrReveal(ctx, url);
  });

  // Don't fail activation if opencode boot fails — surface the error and
  // let the user retry via the restart command.
  serverManager.start().catch((err) => {
    vscode.window.showErrorMessage(`Amicode: opencode failed to start — ${err.message}`);
    opencodeChannel.appendLine(`[boot] start failed: ${err.stack ?? err.message}`);
  });

  // 5. Commands
  ctx.subscriptions.push(
    vscode.commands.registerCommand("amicode.openChat", () => {
      if (!opencodeReadyUrl) {
        vscode.window.showWarningMessage("Amicode: opencode server isn't ready yet. Check the 'Amicode — opencode' output channel.");
        return;
      }
      ChatPanel.openOrReveal(ctx, opencodeReadyUrl);
    }),
    vscode.commands.registerCommand("amicode.openInspector", async () => {
      await vscode.commands.executeCommand("amicode.runInspector.focus");
    }),
    vscode.commands.registerCommand("amicode.restartServer", async () => {
      opencodeChannel.appendLine(`[boot] restart requested`);
      serverManager?.stop();
      statusBar?.setServerReady(false);
      opencodeReadyUrl = undefined;
      try {
        await serverManager?.start();
      } catch (err) {
        vscode.window.showErrorMessage(`Amicode: restart failed — ${(err as Error).message}`);
      }
    }),
  );

  opencodeChannel.appendLine(`[boot] activated; callbackUrl=${callbackUrl}`);
}

export function deactivate(): void {
  sseClient?.dispose();
  serverManager?.stop();
  callbackServer?.dispose();
  statusBar?.dispose();
}

// ---------------------------------------------------------------------------

function resolveJuliaScript(ctx: vscode.ExtensionContext): string {
  const fromCfg = vscode.workspace.getConfiguration("amicode").get<string>("juliaScript", "");
  if (fromCfg && fs.existsSync(fromCfg)) return fromCfg;

  // Convention: amicode-v2/ sits beside amicode/. spike_solve.jl is in amicode/julia/.
  const sibling = path.resolve(ctx.extensionPath, "..", "amicode", "julia", "spike_solve.jl");
  if (fs.existsSync(sibling)) return sibling;

  // Fallback to bundled path (we might bundle the script under dist/julia/ later).
  const bundled = path.join(ctx.extensionPath, "dist", "julia", "spike_solve.jl");
  return bundled;
}

function resolveJuliaProject(): string {
  return vscode.workspace.getConfiguration("amicode").get<string>("juliaProject", "/tmp/amicode-spike-julia");
}
