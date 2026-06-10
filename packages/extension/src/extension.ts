import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import { ServerManager } from "./server_manager";
import { resolveOpencodeBinary, OpencodeMissingError } from "./opencode_binary";
import { ChatPanel } from "./chat_panel";
import { registerRunInspector } from "./run_inspector";
import { registerTrees } from "./trees";
import { StatusBarManager } from "./status_bar";
import { prepareOpencodeProject } from "./opencode_config";
import { OpencodeEventClient } from "./sse_client";
import { RunsRootWatcher } from "./file_watcher";

// ============================================================================
// Extension entry point. Boot order on activate:
//   1. Register UI surfaces (trees, inspector, status bar, commands)
//   2. Start watching /tmp/amicode-runs/latest/ for new runs
//   3. Write per-session opencode project dir with AGENTS.md
//   4. Spawn `opencode serve` with PATH augmented to find amico-run
//   5. SSE-subscribe once opencode is healthy
// ============================================================================

let serverManager: ServerManager | undefined;
let statusBar: StatusBarManager | undefined;
let sseClient: OpencodeEventClient | undefined;
let watcher: RunsRootWatcher | undefined;
let opencodeReadyUrl: URL | undefined;

const DEFAULT_RUNS_ROOT = "/tmp/amicode-runs";

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  const opencodeChannel = vscode.window.createOutputChannel("Amicode — opencode");
  const runsChannel = vscode.window.createOutputChannel("Amicode — runs");
  ctx.subscriptions.push(opencodeChannel, runsChannel);

  // 1. UI surfaces
  registerTrees(ctx);
  registerRunInspector(ctx);
  statusBar = new StatusBarManager();
  ctx.subscriptions.push({ dispose: () => statusBar?.dispose() });

  // 2. Start watching the runs root immediately — solves may already exist
  // from prior dev-host sessions, and watchers are cheap.
  const runsRoot = vscode.workspace.getConfiguration("amicode").get<string>("runsRoot", DEFAULT_RUNS_ROOT);
  fs.mkdirSync(runsRoot, { recursive: true });
  watcher = new RunsRootWatcher({ runsRoot, channel: runsChannel, statusBar });
  watcher.start();
  ctx.subscriptions.push(watcher);

  // 3. opencode project bootstrap
  const binDir = path.resolve(ctx.extensionPath, "bin");
  const agentsSrc = path.resolve(ctx.extensionPath, "AGENTS.md");
  const opencodeProject = prepareOpencodeProject({ binDir, agentsSrc });
  opencodeChannel.appendLine(`[boot] opencode project dir: ${opencodeProject.projectDir}`);
  opencodeChannel.appendLine(`[boot] AGENTS.md: ${opencodeProject.agentsPath}`);

  // 4. Spawn opencode — the VENDORED binary by default (spec §4; S35, kills
  // Assumption 4). Config override is a dev-only escape hatch. On a missing
  // binary, chat is disabled but the rest of the extension (inspector,
  // watcher, commands) still activates.
  let binary: string | undefined;
  try {
    const resolved = resolveOpencodeBinary(
      ctx.extensionPath,
      vscode.workspace.getConfiguration("amicode").get<string>("opencodeBinary", ""),
    );
    binary = resolved.path;
    opencodeChannel.appendLine(
      resolved.source === "config-override"
        ? `[boot] OVERRIDE: amicode.opencodeBinary = ${binary}`
        : `[boot] vendored opencode: ${binary}`,
    );
  } catch (e) {
    if (e instanceof OpencodeMissingError) {
      opencodeChannel.appendLine(`[boot] ${e.message} — chat disabled`);
      void vscode.window.showErrorMessage(`Amicode: ${e.message}`);
    } else throw e;
  }

  if (binary !== undefined) {
    const juliaScript = resolveJuliaScript(ctx);
    const juliaProject = resolveJuliaProject();
    serverManager = new ServerManager({
      binary,
      cwd: opencodeProject.projectDir,
      env: {
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        AMICO_JULIA_SCRIPT:  juliaScript,
        AMICO_JULIA_PROJECT: juliaProject,
        AMICO_RUNS_ROOT:     runsRoot,
      },
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
    });

    serverManager.start().catch((err) => {
      vscode.window.showErrorMessage(`Amicode: opencode failed to start — ${err.message}`);
      opencodeChannel.appendLine(`[boot] start failed: ${err.stack ?? err.message}`);
    });
  }

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

  opencodeChannel.appendLine(`[boot] activated; runsRoot=${runsRoot}; binDir=${binDir}`);
}

export function deactivate(): void {
  sseClient?.dispose();
  serverManager?.stop();
  watcher?.dispose();
  statusBar?.dispose();
}

// ---------------------------------------------------------------------------

function resolveJuliaScript(ctx: vscode.ExtensionContext): string {
  const fromCfg = vscode.workspace.getConfiguration("amicode").get<string>("juliaScript", "");
  if (fromCfg && fs.existsSync(fromCfg)) return fromCfg;
  const sibling = path.resolve(ctx.extensionPath, "..", "amicode", "julia", "spike_solve.jl");
  if (fs.existsSync(sibling)) return sibling;
  return path.join(ctx.extensionPath, "dist", "julia", "spike_solve.jl");
}

function resolveJuliaProject(): string {
  return vscode.workspace.getConfiguration("amicode").get<string>("juliaProject", "/tmp/amicode-spike-julia");
}
