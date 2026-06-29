import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { ServerManager } from "./server_manager";
import { loadLlmCred, credSpawnEnv, resolveLlmCreds } from "./llm_creds.mjs";
import { resolveOpencodeBinary, OpencodeMissingError } from "./opencode_binary";
import { ChatPanel } from "./chat_panel";
import { registerRunInspector } from "./run_inspector";
import { registerTrees } from "./trees";
import { StatusBarManager } from "./status_bar";
import { prepareOpencodeProject, resolveJuliaProject, buildOpencodeConfigContent } from "./opencode_config";
import { resolveAmicoRunBinDir, resolveRunsRoot } from "./opencode_paths";
import { resolveLabTomlPath, checkLabToml } from "./lab_config";
import { OpencodeEventClient } from "./sse_client";
import { RunsRootWatcher } from "./file_watcher";
import { stageDemoRun } from "./demo_replay";

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


export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  const opencodeChannel = vscode.window.createOutputChannel("Amicode — opencode");
  const runsChannel = vscode.window.createOutputChannel("Amicode — runs");
  ctx.subscriptions.push(opencodeChannel, runsChannel);

  // Runs root (resolved early — the inspector needs it for its CSP resource roots).
  const runsRoot = resolveRunsRoot(vscode.workspace.getConfiguration("amicode").get<string>("runsRoot", ""));

  // 1. UI surfaces
  registerTrees(ctx);
  registerRunInspector(ctx, runsRoot);
  statusBar = new StatusBarManager();
  ctx.subscriptions.push({ dispose: () => statusBar?.dispose() });

  // 2. Start watching the runs root immediately — solves may already exist
  // from prior dev-host sessions, and watchers are cheap.
  fs.mkdirSync(runsRoot, { recursive: true });
  watcher = new RunsRootWatcher({ runsRoot, channel: runsChannel, statusBar });
  watcher.start();
  ctx.subscriptions.push(watcher);

  // Validate lab.toml on load (0.1b / S17). A malformed hardware profile would
  // otherwise silently solve against the wrong hardware or fail opaquely mid-solve.
  // Field-precise: the error names the offending key + path. Non-fatal — the rest
  // of the extension still activates; a partner can fix the config and reload.
  const labPath = resolveLabTomlPath(vscode.workspace.getConfiguration("amicode").get<string>("labToml", ""));
  const lab = checkLabToml(labPath);
  if (lab.state === "invalid") {
    runsChannel.appendLine(`[lab] ${lab.path} is INVALID:`);
    for (const e of lab.errors) runsChannel.appendLine(`  ${e}`);
    void vscode.window.showErrorMessage(
      `Amicode: lab.toml is invalid — ${lab.errors[0]}` +
        (lab.errors.length > 1 ? ` (+${lab.errors.length - 1} more; see "Amicode — runs" output)` : ""),
    );
  } else if (lab.state === "valid") {
    runsChannel.appendLine(`[lab] validated ${lab.path}`);
  }

  // 3. opencode project bootstrap
  const amicoRunBinDir = resolveAmicoRunBinDir(ctx.extensionPath);
  const opencodeProject = prepareOpencodeProject({
    agentsSrc: path.resolve(ctx.extensionPath, "AGENTS.md"),
    templateSrc: path.resolve(ctx.extensionPath, "templates", "solve_template.jl"),
    juliaProject: resolveJuliaProject(
      vscode.workspace.getConfiguration("amicode").get<string>("juliaProject", ""),
    ),
  });
  opencodeChannel.appendLine(`[boot] opencode project dir: ${opencodeProject.projectDir}`);
  opencodeChannel.appendLine(`[boot] AGENTS.md: ${opencodeProject.agentsPath}`);
  opencodeChannel.appendLine(`[boot] template: ${opencodeProject.templatePath}`);

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
    // amico-run is argv-only (β.1) — no AMICO_* env propagation (S37). The agent
    // gets the Julia project from AGENTS.md (substituted at session-copy time)
    // and passes it as `--project`. PATH just needs to resolve the launcher.
    if (amicoRunBinDir === undefined) {
      opencodeChannel.appendLine(`[boot] WARNING: amico-run launcher not found — chat can author but solves won't run (build amico-run or check the VSIX)`);
    }
    // LLM credential handoff (0.3): read the canonical store (~/.amico/llm.json)
    // and inject the provider key into the opencode child env ONLY. This is the
    // single channel the secret travels — never to amico-run (argv-only, S37),
    // so it can never reach a run-dir artifact. Surface ONE explicit boot signal
    // when no credential resolves (not a silent hang at the chat box, Q129).
    const llmCred = loadLlmCred(os.homedir());
    const credSignal = resolveLlmCreds({ home: os.homedir(), env: process.env });
    opencodeChannel.appendLine(
      credSignal.ok
        ? `[boot] LLM creds: configured (${credSignal.provider}, via ${credSignal.source})`
        : `[boot] LLM creds: ${credSignal.reason} → ${credSignal.fix}`,
    );
    serverManager = new ServerManager({
      binary,
      cwd: opencodeProject.projectDir,
      env: {
        PATH: `${amicoRunBinDir ? amicoRunBinDir + ":" : ""}${process.env.PATH ?? ""}`,
        // Inject the amico solve workflow as opencode `instructions` (loaded for
        // every session regardless of its cwd) — merges over the user's global
        // config, so the model/provider are preserved. This is what makes the
        // chat actually author + run solves instead of behaving like vanilla
        // opencode (the session cwd is the workspace, not opencodeProject.projectDir).
        OPENCODE_CONFIG_CONTENT: buildOpencodeConfigContent(opencodeProject.agentsPath, opencodeProject.templatePath),
        // The stored provider key (if any) — overlays onto the inherited env so
        // opencode resolves a provider with no per-session prompt (0.3 AC1/AC2).
        ...credSpawnEnv(llmCred),
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
      // Creds gate FIRST — opencode serves HTTP 200 (→ "ready") even with zero
      // providers configured, so a missing credential would otherwise sail past
      // the ready check and silently hang at the chat box (Q129). Use the SAME
      // signal the healthcheck uses so the cause is named, not hidden.
      const creds = resolveLlmCreds({ home: os.homedir(), env: process.env });
      if (!creds.ok) {
        vscode.window.showWarningMessage(`Amicode: ${creds.reason} → ${creds.fix}`);
        return;
      }
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
    // On-site fallback (β.6): stage the bundled pre-baked solve into the runs
    // root. The watcher already running on runsRoot follows `latest` →
    // ingestRunDir replays the converged solve — no Julia, no opencode, no creds.
    vscode.commands.registerCommand("amicode.replayDemo", async () => {
      const demoDir = path.join(ctx.extensionPath, "demo", "run");
      if (!fs.existsSync(path.join(demoDir, "FINISHED"))) {
        void vscode.window.showErrorMessage("Amicode: demo run not bundled — reinstall the VSIX.");
        return;
      }
      try {
        const runDir = stageDemoRun(demoDir, runsRoot);
        runsChannel.appendLine(`[demo] replayed → ${runDir}`);
        await vscode.commands.executeCommand("amicode.runInspector.focus");
      } catch (e) {
        void vscode.window.showErrorMessage(`Amicode: replay failed — ${(e as Error).message}`);
      }
    }),
  );

  opencodeChannel.appendLine(`[boot] activated; runsRoot=${runsRoot}; amicoRunBinDir=${amicoRunBinDir ?? "(none)"}`);
}

export function deactivate(): void {
  sseClient?.dispose();
  serverManager?.stop();
  watcher?.dispose();
  statusBar?.dispose();
}

