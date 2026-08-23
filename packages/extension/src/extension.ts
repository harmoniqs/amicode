import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import { ServerManager } from "./server_manager";
import { fetchProviderSignal } from "./llm_creds.mjs";
import { resolveOpencodeBinary, OpencodeMissingError, unsupportedHostAdvice } from "./opencode_binary";
import { ChatPanel } from "./chat_panel";
import { DeckPanel } from "./deck_panel";
import { registerWorkspaceTree } from "./workspace_tree";
import { StatusBarManager } from "./status_bar";
import {
  prepareOpencodeProject,
  resolveJuliaProject,
  buildOpencodeConfigContent,
  resolveModelPin,
  validatedModelPin,
} from "./opencode_config";
import { parseLibraryRootSpecs } from "./scores/package_skills";
import { resolveAmicoRunBinDir, resolveRunsRoot } from "./opencode_paths";
import {
  mintServerPassword,
  serverAuthHeader,
  serverAuthToken,
  buildServerSpawnEnv,
  buildTelemetryEnv,
  telemetryGateOpen,
  TELEMETRY_ENV_KEYS,
} from "./server_auth";
import {
  mintTelemetrySession,
  resolveTelemetryContext,
  maybePromptTelemetryConsent,
} from "./telemetry";
import { resolveLabTomlPath, checkLabToml } from "./lab_config";
import { OpencodeEventClient } from "./sse_client";
import { RunsManager } from "./runs_manager";
import { stageDemoRun } from "./demo_replay";
import { writeStopFile, savePulseTo, stopPlan, forceStop, runLogMtime } from "./run_controls";
import { watchSolverMode, applyEntitlementForMode, readSolverModeState } from "./solver_mode";
import { runSetCloudKeyCommand } from "./cloud_key";
import { amicodeOpsDir } from "./substrate/vault_store";
import { registerOnboardingPanel, onOnboardingCancelled, getOnboardingPanel, releaseOnboardingPanel } from "./onboarding_panel";
import { registerFleetPanel } from "./fleet_panel";
import { isModelConfigured } from "./onboarding_routing";
import { stagePasqalConnector } from "./pasqal_assets";
import { needsProvision, pasqalVenvDir, provisionPasqalPython } from "./pasqal_python";
import { createLocalPersonalVault, sanitizeVaultName, suggestVaultName } from "./substrate/vault_setup";
import {
  pinnedJuliaMinor,
  hasJuliaup,
  hasChannel,
  projectInstantiated,
  shouldOfferJuliaSetup,
  buildSetupSteps,
  resolveJuliaupCommands,
  juliaProjectFingerprint,
} from "./substrate/julia_setup";
import { probeCommand, formatHealthReport, type HealthResult } from "./healthcheck";
import { fleetHealthReport, FLEET_GUARD_REL } from "./fleet_health";
import { isFleetClient, getFleetRole, goStandalone, readFleetConfig, migrateLegacyFallback } from "./fleet_fallback";
import { registerAmicodeTerminal } from "./terminal";
import { amicodeServiceDisposal, startAmicodeService } from "./amicode_service_wiring";
import { registerOpencodeUpdater } from "./opencode_updater_wiring";
import { resolveMountStack, personalMount, defaultVaultsRoot } from "./substrate/mount_store";
import { initDistillerTransport, triggerRunDistill, triggerSweep, type DistillerSetup } from "./substrate/distiller";
import {
  registerBugReport,
  unregisterBugReport,
  bugReportSkillStaged,
  REPORT_BUG_COMMAND,
} from "./bug_report";
import * as os from "node:os";
import { parse as parseYaml } from "yaml";
import { loadGraph } from "./calibration_graph";
import { parseStateJson } from "./device_registry";
import { buildDeviceStatus, nextActions, capabilityHint, type DriveLine } from "./device_status";
import { SchusterJobServer } from "./qick_client";
import type { QueueView } from "./qick_job_server";
import { postDeviceStatus, postDeviceActions, postDeviceActivate } from "./inspector_bridge";

// ============================================================================
// Extension entry point. Boot order on activate:
//   1. Register UI surfaces (trees, inspector, status bar, commands)
//   2. Start watching /tmp/amicode-runs/latest/ for new runs
//   3. Write per-session opencode project dir with AGENTS.md
//   4. Spawn `opencode serve` with PATH augmented to find amico-run
//   5. SSE-subscribe once opencode is healthy
// ============================================================================

let serverManager: ServerManager | undefined;
let amicodeService: { url: string; authHeader: string } | undefined;
let statusBar: StatusBarManager | undefined;
let sseClient: OpencodeEventClient | undefined;
let runsManager: RunsManager | undefined;
let opencodeReadyUrl: URL | undefined;
/** Set once the binary + vault are known; the watcher's onRunFinished closure
 *  and the distillNow command read it lazily (undefined = distiller disabled). */
let distillerSetup: DistillerSetup | undefined;
/** Device Inspector poll timer (Spec A §5.1) — cleared on deactivate. */
let devicePollTimer: ReturnType<typeof setInterval> | undefined;
/** Fleet client tunnel poll — when the machine is a fleet client (guard `exit 1`), we don't spawn. */
let fleetClientPoll: ReturnType<typeof setInterval> | undefined;

const DEVICE_POLL_MS = 2500; // mirror the RunsManager cadence

/** Fleet client detection — reads role from ~/.amico/ops/fleet/fleet.json.
 *  A fleet client (role="client" in fleet.json, guard installed) must NOT spawn
 *  a local server; it rides the tunnel. This check prevents the "opencode failed
 *  to start within 30s" storm when the guard correctly `exit 1`s. (#338) */
function isFleetClientGuard(binary: string | undefined): boolean {
  if (process.platform !== "darwin") return false;
  if (!binary || !binary.endsWith("amico-opencode-fleet-guard")) return false;
  // Role from fleet.json — "client" means ride the tunnel, anything else means spawn locally
  return isFleetClient();
}

/** Drive-line + qubit list from a device card's YAML frontmatter (§3.1). The
 *  card is durable knowledge (vault); this only READS it. Never throws. */
function readDeviceCard(cardPath: string): { driveLines: DriveLine[]; qubits: string[] } | undefined {
  try {
    const md = fs.readFileSync(cardPath, "utf8");
    const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) return undefined;
    const fm = parseYaml(m[1]) as Record<string, unknown>;
    const dlRaw = Array.isArray(fm.drive_lines) ? (fm.drive_lines as Record<string, unknown>[]) : [];
    const driveLines: DriveLine[] = dlRaw
      .filter((d) => d && typeof d === "object" && typeof d.id === "string")
      .map((d) => ({
        id: String(d.id),
        target: typeof d.target === "string" ? d.target : undefined,
        kind: typeof d.kind === "string" ? d.kind : undefined,
      }));
    const qubits =
      typeof fm.qubits === "number"
        ? Array.from({ length: fm.qubits }, (_v, i) => `Q${i + 1}`)
        : Array.isArray(fm.qubits)
          ? (fm.qubits as unknown[]).map(String)
          : [...new Set(driveLines.map((d) => d.target).filter((t): t is string => !!t))];
    return { driveLines, qubits };
  } catch {
    return undefined;
  }
}

/** Poll tick (Spec A §3, §5.1) — now posts to the Work Column bridge instead
 *  of the deleted Device Inspector webview. Dormant until `amicode.device.name`
 *  + `amicode.device.graph` are set. */
async function refreshDeviceInspector(channel: vscode.OutputChannel): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("amicode");
  const deviceName = (cfg.get<string>("device.name", "") || "").trim();
  const graphPath = (cfg.get<string>("device.graph", "") || "").trim();
  if (!deviceName || !graphPath) return;

  try {
    const loaded = loadGraph(fs.readFileSync(graphPath, "utf8"));
    if (!loaded.ok) {
      channel.appendLine(`[device] graph ${graphPath} failed to load: ${loaded.error}`);
      return;
    }
    const stateFile = path.join(amicodeOpsDir(), "devices", deviceName, "state.json");
    let state = {};
    try {
      state = parseStateJson(fs.readFileSync(stateFile, "utf8"));
    } catch {
      /* no state yet → everything reads uncharacterized (honest) */
    }
    const card = readDeviceCard((cfg.get<string>("device.card", "") || "").trim());

    let queue: QueueView = { running: undefined, pending: [] };
    let onlineChannels: string[] | undefined;
    let capabilities: string[] | undefined;
    let mainConfig;
    const endpoint = (cfg.get<string>("device.endpoint", "") || "").trim();
    if (endpoint) {
      const client = new SchusterJobServer({ baseUrl: endpoint });
      const q = await client.queue();
      if (q.ok) queue = q.value;
      const h = await client.health();
      if (h.ok) {
        onlineChannels = h.value.channels;
        capabilities = h.value.capabilities;
      }
      const mc = await client.mainConfig("hw");
      if (mc.ok) mainConfig = mc.value ?? undefined;
    }

    const now = Date.now();
    const status = buildDeviceStatus({
      graph: loaded.graph,
      state,
      now,
      driveLines: card?.driveLines ?? [],
      qubits: card?.qubits,
      onlineChannels,
      mainConfig,
    });
    const entitled = capabilityHint("qilc", capabilities);
    const { ranked_actions } = nextActions(loaded.graph, state, queue, now, { entitled });

    postDeviceStatus(deviceName, status);
    postDeviceActions(deviceName, ranked_actions);
    postDeviceActivate(deviceName);
  } catch (e) {
    channel.appendLine(`[device] refresh error: ${(e as Error).message}`);
  }
}

/** Run dirs with a cooperative stop in flight (escalation timer armed) — a
 *  second Stop click must not stack a second dialog. */
const pendingStops = new Set<string>();

// Domain-pack activation gate (ADR 0008): quantum-control is the first and
// only domain pack, always active today. This gate exists so domain-specific
// infrastructure (Julia substrate, domain tools) is visibly gated rather than
// implicitly unconditional. A second domain pack would make this configurable.
function isQuantumControlPackActive(): boolean {
  return true;
}

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  const opencodeChannel = vscode.window.createOutputChannel("Amicode — opencode");
  const runsChannel = vscode.window.createOutputChannel("Amicode — runs");
  const devicesChannel = vscode.window.createOutputChannel("Amicode — devices");
  ctx.subscriptions.push(opencodeChannel, runsChannel, devicesChannel);

  // Runs root (resolved early — the inspector needs it for its CSP resource roots).
  const runsRoot = resolveRunsRoot(vscode.workspace.getConfiguration("amicode").get<string>("runsRoot", ""));

  // #161: stage the Pasqal connector into the ops dir at every activation —
  // the DEFAULT path the fork's Connections panel resolves when
  // $AMICO_PASQAL_VALIDATOR is unset (<opsDir>/scripts/pasqal-connector/).
  // Always-copy: the default path is extension-owned (overrides live behind
  // the env var, elsewhere), so the refresh can't clobber user work and every
  // extension update ships the current script. Never blocks activation.
  try {
    const pasqal = stagePasqalConnector(ctx.extensionPath);
    opencodeChannel.appendLine(`[pasqal] connector staged: ${pasqal.dir} (${pasqal.staged.join(", ")})`);
  } catch (e) {
    opencodeChannel.appendLine(`[pasqal] connector staging failed: ${(e as Error).message}`);
  }

  // Provision the Pasqal validator's interpreter (the fresh-install fix): a
  // venv from the STAGED requirements.txt, handed to the server spawn as
  // AMICO_PYTHON — the override the fork's validator spawn resolves before
  // falling back to bare `python3` (which on a fresh machine has no
  // pasqal-cloud → validator exit 1 → the panel's misleading "unreachable").
  // Fast path (stamped venv or host $AMICO_PYTHON) resolves synchronously;
  // the slow path (fresh install / requirements change) provisions in the
  // BACKGROUND — never blocks activation — then injects into the live spawn
  // env (ServerManager re-reads it at start()) and bounces the server via the
  // existing restart command, so a fresh install self-heals without a reload.
  let amicoPython: string | undefined;
  let currentSpawnEnv: Record<string, string> | undefined;
  try {
    if (needsProvision()) {
      opencodeChannel.appendLine(`[pasqal] python provisioning (background): ${pasqalVenvDir()}`);
      void provisionPasqalPython().then((r) => {
        if (r.ok) {
          amicoPython = r.pythonPath;
          if (r.provisioned) {
            if (currentSpawnEnv) currentSpawnEnv.AMICO_PYTHON = r.pythonPath;
            opencodeChannel.appendLine(
              `[pasqal] python provisioned: ${r.pythonPath} — restarting server to pick it up`,
            );
            void vscode.commands.executeCommand("amicode.restartServer");
          }
        } else {
          opencodeChannel.appendLine(`[pasqal] ${r.message}`);
        }
      });
    } else {
      const r = await provisionPasqalPython(); // no-op resolve: stamped venv or host override
      if (r.ok) amicoPython = r.pythonPath;
    }
  } catch (e) {
    opencodeChannel.appendLine(`[pasqal] python provisioning failed: ${(e as Error).message}`);
  }
  // Run-corpus telemetry (feat/telemetry-bearer-auth): auth is the user's
  // EXISTING Solve/cloud bearer token from ~/.amico/cloud.json — no ingest secret
  // to manage here. resolveTelemetryContext reads it fresh per spawn, so
  // connecting/rotating the cloud key takes effect on the next respawn. One
  // per-activation session id groups this activation's runs.
  const telemetrySessionId = mintTelemetrySession();

  /** One builder for every server spawn site: threads the CURRENT amicoPython
   *  (closure read — late provisioning is picked up by later respawns) and
   *  keeps a handle on the live env object for the background self-heal. Also
   *  resolves a FRESH TelemetryContext per spawn, so a late consent answer, a
   *  cloud-key connect, or a config change activates on the next respawn;
   *  buildServerSpawnEnv applies the consent gate, so NO OTLP var is added until
   *  enabled + consent + endpoint + token all hold (the exporter stays dormant
   *  otherwise). */
  const spawnEnv = (
    o: Omit<Parameters<typeof buildServerSpawnEnv>[0], "amicoPython" | "telemetry">,
  ): Record<string, string> => {
    const env = buildServerSpawnEnv({
      ...o,
      amicoPython,
      telemetry: resolveTelemetryContext(ctx, { sessionId: telemetrySessionId }),
    });
    // Data & Storage overrides (#378): inject OPENCODE_DB / OPENCODE_CONFIG_DIR
    // from the user's VS Code settings when non-empty. On cold start + on
    // restartServer, the new env reaches the fresh server process.
    const cfg = vscode.workspace.getConfiguration("amicode");
    const sessionDb = cfg.get<string>("sessionDatabase", "");
    const configDirOverride = cfg.get<string>("configDir", "");
    if (sessionDb) env.OPENCODE_DB = sessionDb;
    if (configDirOverride) env.OPENCODE_CONFIG_DIR = configDirOverride;
    return (currentSpawnEnv = env);
  };

  /** Is the telemetry gate open RIGHT NOW? Threaded into buildOpencodeConfigContent
   *  at each spawn site so the config's experimental.openTelemetry (span generation)
   *  tracks the SAME gate as the exporter env — armed-exporter-no-spans is exactly
   *  the whole-pipeline bug this couples away. */
  const telemetryOpen = (): boolean =>
    telemetryGateOpen(resolveTelemetryContext(ctx, { sessionId: telemetrySessionId }));

  /** Reconcile telemetry on the LIVE spawn env in place (the amicoPython
   *  self-heal pattern: ServerManager re-reads opts.env at start()). Re-gates the
   *  OTLP env keys AND toggles experimental.openTelemetry inside the live
   *  OPENCODE_CONFIG_CONTENT — both from ONE gate read, so a consent flip or a key
   *  change takes effect (exporter + span generation together) on the next
   *  `amicode.restartServer` WITHOUT a window reload. No live env yet → no-op. */
  const refreshTelemetryLiveEnv = (): void => {
    if (!currentSpawnEnv) return;
    const open = telemetryOpen();
    // exporter env
    for (const k of TELEMETRY_ENV_KEYS) delete currentSpawnEnv[k];
    Object.assign(
      currentSpawnEnv,
      buildTelemetryEnv(resolveTelemetryContext(ctx, { sessionId: telemetrySessionId })),
    );
    // span-generation flag — patch the live config JSON in place (works whatever
    // project the current server was spawned from; toggles only our one field).
    try {
      const cfg = JSON.parse(currentSpawnEnv.OPENCODE_CONFIG_CONTENT ?? "{}") as {
        experimental?: Record<string, unknown>;
      };
      if (open) cfg.experimental = { ...(cfg.experimental ?? {}), openTelemetry: true };
      else if (cfg.experimental) {
        delete cfg.experimental.openTelemetry;
        if (Object.keys(cfg.experimental).length === 0) delete cfg.experimental;
      }
      currentSpawnEnv.OPENCODE_CONFIG_CONTENT = JSON.stringify(cfg);
    } catch {
      /* malformed config JSON (never, we built it) → leave it; env gate still applied */
    }
  };

  // First-run consent (fire-and-forget, like the vault/julia popups). Until it is
  // answered the gate stays shut; on Enable we reconcile + bounce the server so
  // capture starts on THIS boot rather than waiting for the next activation.
  void maybePromptTelemetryConsent(ctx, {
    onEnable: () => {
      refreshTelemetryLiveEnv();
      if (serverManager) void vscode.commands.executeCommand("amicode.restartServer");
    },
  });

  // 1. UI surfaces — Workspace sidebar (opencode#215 AC6)
  const workspaceTree = registerWorkspaceTree(ctx);
  // Mute the "Chat with Amico" button when a chat panel is open
  ChatPanel.onLiveChange((count) => workspaceTree.setChatActive(count > 0));
  registerOnboardingPanel(ctx); // #433 — Stage 0 model-setup webview
  registerFleetPanel(ctx); // #527 — Fleet & Versions: the view over doctor's JSON
  statusBar = new StatusBarManager();
  ctx.subscriptions.push({ dispose: () => statusBar?.dispose() });

  // 2. Start the multi-run RunsManager — tails the append-only runs/index;
  // #351: posts run data to the Work Column bridge (no bottom panel).
  fs.mkdirSync(runsRoot, { recursive: true });
  runsManager = new RunsManager({
    runsRoot,
    channel: runsChannel,
    onRunFinished: ({ runId }) => {
      if (distillerSetup) triggerRunDistill(distillerSetup, runId);
    },
  });
  runsManager.start();
  ctx.subscriptions.push(runsManager);

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
  // Configured skill-index overrides (spec-20260704-113005 §3) — an empty/unset
  // array falls through to the module defaults (undefined → the `??` default).
  const cfgArr = (key: string): string[] | undefined => {
    const v = vscode.workspace.getConfiguration("amicode").get<string[]>(key, []);
    return Array.isArray(v) && v.length ? v : undefined;
  };
  // Typed library roots (ADR-0003): the setting mixes bare strings (public-only,
  // pre-ADR behavior) and {path, surfaces} objects; malformed entries drop + warn.
  const cfgLibraryRoots = () => {
    const raw = vscode.workspace.getConfiguration("amicode").get<unknown>("skillLibraryRoots", []);
    const parsed = parseLibraryRootSpecs(raw);
    return parsed.length ? parsed : undefined;
  };
  const opencodeProject = prepareOpencodeProject({
    agentsSrc: path.resolve(ctx.extensionPath, "AGENTS.md"),
    // MODE-SELECTED vetted template: HP sessions get the Piccolissimo variant
    // (same run-dir contract, spline solver layer). An AGENTS.md instruction
    // can't beat the procedural template path — the file itself must swap.
    templateSrc: path.resolve(
      ctx.extensionPath,
      "templates",
      readSolverModeState().mode === "hp" ? "solve_template_hp.jl" : "solve_template.jl",
    ),
    juliaProject: resolveJuliaProject(vscode.workspace.getConfiguration("amicode").get<string>("juliaProject", "")),
    skillRoots: cfgArr("skillRoots"),
    skillLibraryRoots: cfgLibraryRoots(),
    // User-memory substrate (spec-20260705-002847): "" in the setting keeps the
    // auto-resolve (kind=personal marker scan); a path pins the vault explicitly.
    vaultDir: vscode.workspace.getConfiguration("amicode").get<string>("vaultDir", "") || undefined,
    // Stable across activations: the app persists the selected project per
    // server workspace, so a fresh mkdtemp every boot leaves that selection
    // dangling — its bootstrap fails, the agent list stays empty, and the
    // composer blocks with "Select an agent and model". storageUri scopes the
    // dir per workspace (window isolation); globalStorageUri covers
    // no-workspace windows. F5 dev hosts never showed this because their
    // webview storage is ephemeral.
    projectDir: path.join((ctx.storageUri ?? ctx.globalStorageUri).fsPath, "opencode-project"),
  });
  opencodeChannel.appendLine(`[boot] opencode project dir: ${opencodeProject.projectDir}`);
  opencodeChannel.appendLine(`[boot] AGENTS.md: ${opencodeProject.agentsPath}`);
  opencodeChannel.appendLine(`[boot] template: ${opencodeProject.templatePath}`);
  // amicode#250 AC5: the composer bug button gates on the staged skill set —
  // re-pinned after EVERY session prep (boot, solver switch, vault respawn).
  ChatPanel.setBugReportAvailable(bugReportSkillStaged(opencodeProject.skillPaths));
  opencodeChannel.appendLine(
    `[boot] armonia mounts: ${opencodeProject.mounts.length} (${opencodeProject.mounts.map((m) => m.name).join(", ")})`,
  );

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
      // An unsupported host is the expected landing spot for the Marketplace's
      // binary-less cover packages (win32-*, darwin-x64 — see release.yml), so the
      // toast must say where Amicode DOES run, not just that this host failed.
      // On Windows that's WSL, and the reopen action is offered only when the WSL
      // extension is actually installed to provide the command.
      const advice = unsupportedHostAdvice();
      opencodeChannel.appendLine(`[boot] ${e.message} — chat disabled — ${advice}`);
      void (async () => {
        const REOPEN = "Reopen in WSL";
        const canReopen =
          process.platform === "win32" && (await vscode.commands.getCommands(true)).includes("remote-wsl.reopenInWSL");
        const pick = await vscode.window.showErrorMessage(`Amicode: ${advice}`, ...(canReopen ? [REOPEN] : []));
        if (pick === REOPEN) void vscode.commands.executeCommand("remote-wsl.reopenInWSL");
      })();
    } else throw e;
  }

  // Per-boot server password (#163, ADR 0002 graft 1): arms the fork's route
  // auth, which is a no-op without OPENCODE_SERVER_PASSWORD in the spawn env.
  // Minted fresh each activation, held in memory only — never persisted, never
  // logged. ONE value for the whole activation: respawns (solver switch, vault
  // refresh, restart) reuse it, because the open chat iframe carries the boot
  // credential and a mid-session rotation would strand it on 401s.
  const serverPassword = mintServerPassword();
  // The extension's own calls to the server (health probe aside — ServerManager
  // derives its own from the spawn env) authenticate with the matching Basic
  // credential: SSE /event, the /config* signal probes, and the chat iframe
  // (via the app's ?auth_token= bootstrap).
  const serverAuthHeaders = { Authorization: serverAuthHeader(serverPassword) };

  // Bug-report orchestration (amicode#250, ADR 0004): the window's ONE
  // BugReportManager — owns the bug session's id end-to-end (create / arm /
  // open), the machine-managed lifecycle (archive-on-filed, abort+delete on
  // abandon), and the single-open invariant. Deps are closures over live
  // activation state (ready URL, runs manager), so respawns need no rewire.
  const bugReport = registerBugReport({
    server: () =>
      opencodeReadyUrl ? { url: opencodeReadyUrl.toString(), authorization: serverAuthHeaders.Authorization } : undefined,
    workspaceDir: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    activeRunPointer: () => runsManager?.getActiveRunPointer(),
    postDown: (msg) => {
      // The dock lives in the main app surface — ensure a chat panel when we
      // can (palette invocation with none open), else post to the live one.
      const url = opencodeReadyUrl;
      const panel = url
        ? ChatPanel.openOrReveal(ctx, url, serverAuthToken(serverPassword), opencodeProject.projectDir)
        : ChatPanel.peek();
      if (!panel) {
        opencodeChannel.appendLine("[bug] no chat surface for the dock message — dropped");
        return;
      }
      panel.postToApp(msg);
    },
    showError: (m) => void vscode.window.showErrorMessage(m),
    log: (line) => opencodeChannel.appendLine(line),
    // Same pin rule as the boot/restart config pins above: ONLY an explicit
    // amicode.defaultModel pins a model; empty means "let the server decide".
    defaultModel: () => vscode.workspace.getConfiguration("amicode").get<string>("defaultModel", "").trim() || undefined,
  });
  ctx.subscriptions.push({ dispose: () => unregisterBugReport() });

  // Fleet client: guard would `exit 1` on this host (role=client in fleet.json) —
  // don't spawn and storm "opencode failed to start within 30s".
  // Ride the tunnel instead; "Go Standalone" switches to local mode permanently.
  const fleetClient = isFleetClientGuard(binary);
  if (binary !== undefined && fleetClient) {
    const fleetCfg = readFleetConfig();
    const fleetPort = fleetCfg?.canonical?.port ?? 4096;
    opencodeChannel.appendLine(`[fleet] client mode — guard ${binary} would refuse on ${os.hostname()} — riding tunnel 127.0.0.1:${fleetPort}`);
    opencodeChannel.appendLine(`[fleet] hint: canonical offline? Palette → Amicode: Fleet — Go Standalone`);
    // Distiller still arms on the client (uses vendored binary directly, not the guard)
    const clientBinary = (() => {
      try {
        return resolveOpencodeBinary(ctx.extensionPath, "").path;
      } catch {
        return undefined;
      }
    })();
    if (opencodeProject.vaultDir && clientBinary) {
      try {
        distillerSetup = {
          binary: clientBinary,
          distillerMdPath: path.resolve(ctx.extensionPath, "DISTILLER.md"),
          vaultDir: opencodeProject.vaultDir,
          opsDir: amicodeOpsDir(),
          problemsRoot: path.join(os.homedir(), ".amico", "problems"),
          runsRoot,
          model: vscode.workspace.getConfiguration("amicode").get<string>("distillerModel", "opencode/big-pickle"),
        };
        initDistillerTransport(distillerSetup);
        opencodeChannel.appendLine(`[boot] distiller armed (client, vault: ${opencodeProject.vaultDir})`);
      } catch (e) {
        opencodeChannel.appendLine(`[boot] distiller transport failed: ${e}`);
        distillerSetup = undefined;
      }
    }
    sseClient = new OpencodeEventClient({
      channel: opencodeChannel,
      statusBar,
      authorization: serverAuthHeaders.Authorization,
    });
    ctx.subscriptions.push(sseClient);
    // Poll the tunnel — when the canonical server is reachable the forward answers 200.
    let fleetReady = false;
    let fleetChecks = 0;
    let fleetNotified = false;
    const checkFleet = async () => {
      fleetChecks++;
      try {
        const r = await fetch(`http://127.0.0.1:${fleetPort}/`, {
          signal: AbortSignal.timeout(1500),
          headers: serverAuthHeaders,
        });
        const up = r.ok || (r.status >= 200 && r.status < 400);
        if (up && !fleetReady) {
          fleetReady = true;
          fleetNotified = false;
          opencodeReadyUrl = new URL(`http://127.0.0.1:${fleetPort}`);
          statusBar?.setServerReady(true);
          sseClient?.connect(opencodeReadyUrl);
          if (vscode.workspace.getConfiguration("amicode").get<boolean>("chat.autoOpen", true)) {
            ChatPanel.openOrReveal(ctx, opencodeReadyUrl, serverAuthToken(serverPassword), opencodeProject.projectDir);
          }
          void fetchProviderSignal(opencodeReadyUrl.toString(), { headers: serverAuthHeaders }).then((sig) => {
            opencodeChannel.appendLine(sig.ok ? `[fleet] LLM provider: configured (${sig.provider})` : `[fleet] LLM provider: ${sig.reason} → ${sig.fix}`);
          });
          opencodeChannel.appendLine(`[fleet] tunnel up at ${opencodeReadyUrl} — chat attached`);
        } else if (!up && fleetReady) {
          fleetReady = false;
          opencodeReadyUrl = undefined;
          statusBar?.setServerReady(false);
          opencodeChannel.appendLine(`[fleet] tunnel down — canonical unreachable (go standalone to work locally)`);
        } else if (!up && !fleetReady && fleetChecks === 1) {
          opencodeChannel.appendLine(`[fleet] waiting for tunnel 127.0.0.1:${fleetPort} — canonical unreachable, will retry`);
        }
        // After ~10s (5 checks) still down → offer standalone visibly, not just a log
        if (!up && !fleetReady && !fleetNotified && fleetChecks >= 5) {
          fleetNotified = true;
          opencodeChannel.appendLine(`[fleet] tunnel still down after ${fleetChecks} checks — offering standalone`);
          void vscode.window
            .showWarningMessage(`Amicode: fleet tunnel down — canonical unreachable. Go standalone?`, `Go Standalone`, `Show log`)
            .then((pick) => {
              if (pick === `Go Standalone`) void vscode.commands.executeCommand(`amicode.fleet.goStandalone`);
              else if (pick === `Show log`) opencodeChannel.show();
            });
        }
      } catch {
        if (fleetReady) {
          fleetReady = false;
          opencodeReadyUrl = undefined;
          statusBar?.setServerReady(false);
          opencodeChannel.appendLine(`[fleet] tunnel down — will retry`);
        } else if (fleetChecks === 1) {
          opencodeChannel.appendLine(`[fleet] waiting for tunnel 127.0.0.1:${fleetPort} — will retry`);
        }
        if (!fleetReady && !fleetNotified && fleetChecks >= 5) {
          fleetNotified = true;
          opencodeChannel.appendLine(`[fleet] tunnel still down after ${fleetChecks} checks — offering standalone`);
          void vscode.window
            .showWarningMessage(`Amicode: fleet tunnel down — canonical unreachable. Go standalone?`, `Go Standalone`, `Show log`)
            .then((pick) => {
              if (pick === `Go Standalone`) void vscode.commands.executeCommand(`amicode.fleet.goStandalone`);
              else if (pick === `Show log`) opencodeChannel.show();
            });
        }
      }
    };
    fleetClientPoll = setInterval(() => void checkFleet(), 2000);
    ctx.subscriptions.push({ dispose: () => { if (fleetClientPoll) clearInterval(fleetClientPoll); fleetClientPoll = undefined; } });
    void checkFleet();
    // Fallback status bar already handles the fallback-active case; in pure
    // client mode we surface tunnel health via the fleet health warning above.
  } else if (binary !== undefined) {
    // amico-run is argv-only (β.1) — no AMICO_* env propagation (S37), with ONE
    // recorded exception: AMICO_PYTHON (Pasqal python provisioning) rides the
    // server child env for the FORK's validator spawn — server plumbing, not
    // amico-run contract; amico-run itself still receives nothing via env. The agent
    // gets the Julia project from AGENTS.md (substituted at session-copy time)
    // and passes it as `--project`. PATH just needs to resolve the launcher.
    if (amicoRunBinDir === undefined) {
      opencodeChannel.appendLine(
        `[boot] WARNING: amico-run launcher not found — chat can author but solves won't run (build amico-run or check the VSIX)`,
      );
    }
    // opencode owns the LLM credential (0.3): amico injects NO key into the
    // spawn env — opencode resolves its provider from its own env / config /
    // auth.json. The spawn env carries only PATH (so amico-run resolves), the
    // amico instructions/permission config, and the per-boot server password
    // that arms the fork's route auth (#163).
    const configuredPort = vscode.workspace.getConfiguration("amicode").get<number>("opencodePort", 0);
    if (configuredPort > 0) {
      opencodeChannel.appendLine(`[boot] amicode.opencodePort = ${configuredPort} (static)`);
    }
    serverManager = new ServerManager({
      binary,
      cwd: opencodeProject.projectDir,
      port: configuredPort > 0 ? configuredPort : undefined,
      env: spawnEnv({
        amicoRunBinDir,
        serverPassword,
        // Inject the amico solve workflow as opencode `instructions` (loaded for
        // every session regardless of its cwd) — merges over the user's global
        // config, so the model/provider are preserved. This is what makes the
        // chat actually author + run solves instead of behaving like vanilla
        // opencode (the session cwd is the workspace, not opencodeProject.projectDir).
        configContent: buildOpencodeConfigContent(
          opencodeProject.agentsPath,
          opencodeProject.templatePath,
          runsRoot,
          undefined,
          undefined,
          opencodeProject.skillPaths,
          opencodeProject.skillsStageDir,
          opencodeProject.vaultDir,
          // Armonia mount stack (spec-20260707-002846 C1): per-mount read grants.
          opencodeProject.mounts,
          // Model pin. ONLY an explicit `amicode.defaultModel` pins config.model
          // (which is authoritative — it outranks the user's recent pick). Empty
          // → resolveModelPin() is undefined (NO forced pin), so opencode uses
          // the user's recent selection, else the provider default. A hardcoded
          // fallback here used to override the user's own choice. The in-chat
          // picker still overrides per session.
          // Validate: don't inject a pin that references an unconnected provider —
          // it causes 500s when the server tries to resolve it.
          validatedModelPin(vscode.workspace.getConfiguration("amicode").get<string>("defaultModel", "").trim() || resolveModelPin()),
          // Telemetry gate → experimental.openTelemetry (span generation), coupled
          // to the exporter env this same spawnEnv resolves.
          telemetryOpen(),
          // Context plugin: injects live stack state (solver mode, routing,
          // active problem, live runs) per system-prompt build.
          [path.resolve(ctx.extensionPath, "opencode-plugin", "amicode_context.ts")],
        ),
      }),
      channel: opencodeChannel,
    });
    ctx.subscriptions.push({ dispose: () => void serverManager?.stop() });

    // Amicode service (#451 M1): the extension-host port of the 31 fork
    // amicode routes, booted in PARALLEL-RUN alongside the fork server (the
    // chat/widgets still hit the fork until the M3 cutover). Stateless — no
    // restart coupling with solver-mode switches or config re-preps.
    const serviceBoot = await startAmicodeService(opencodeChannel);
    amicodeService = serviceBoot ?? undefined;
    ctx.subscriptions.push(amicodeServiceDisposal(serviceBoot));

    // Solver-mode switcher (rchari/solver-wire): the app's toggle POSTs
    // {status:"switching"}; we do the REAL switch — grant/revoke the issimo
    // entitlement, re-prep the session project (skills/scores/allowlist follow
    // the entitlement), restart the server, and only then report ready (the
    // watcher writes it). The app's switch wizard polls through the gap.
    ctx.subscriptions.push(
      watchSolverMode(async (mode) => {
        opencodeChannel.appendLine(`[solver] switching → ${mode}`);
        applyEntitlementForMode(mode, path.join(os.homedir(), ".amico", "amicode"));
        const project2 = prepareOpencodeProject({
          agentsSrc: path.resolve(ctx.extensionPath, "AGENTS.md"),
          // Same mode-selection as boot; `mode` is the requested target of THIS
          // switch (the state file still reads status:"switching" here).
          templateSrc: path.resolve(
            ctx.extensionPath,
            "templates",
            mode === "hp" ? "solve_template_hp.jl" : "solve_template.jl",
          ),
          juliaProject: resolveJuliaProject(
            vscode.workspace.getConfiguration("amicode").get<string>("juliaProject", ""),
          ),
          skillRoots: cfgArr("skillRoots"),
          skillLibraryRoots: cfgLibraryRoots(),
          vaultDir: vscode.workspace.getConfiguration("amicode").get<string>("vaultDir", "") || undefined,
          projectDir: path.join((ctx.storageUri ?? ctx.globalStorageUri).fsPath, "opencode-project"),
        });
        ChatPanel.setBugReportAvailable(bugReportSkillStaged(project2.skillPaths)); // #250 AC5
        await serverManager?.stop();
        serverManager = new ServerManager({
          binary: binary!,
          cwd: project2.projectDir,
          port: configuredPort > 0 ? configuredPort : undefined,
          env: spawnEnv({
            amicoRunBinDir,
            serverPassword, // per-boot value survives the switch (chat iframe keeps its credential)
            configContent: buildOpencodeConfigContent(
              project2.agentsPath,
              project2.templatePath,
              runsRoot,
              undefined,
              undefined,
              project2.skillPaths,
              project2.skillsStageDir,
              project2.vaultDir,
              // Armonia mount stack (spec-20260707-002846 C1): per-mount read grants.
              project2.mounts,
              // Same pin rule as boot: only an explicit amicode.defaultModel pins.
              validatedModelPin(vscode.workspace.getConfiguration("amicode").get<string>("defaultModel", "").trim() || resolveModelPin()),
              telemetryOpen(), // gate → experimental.openTelemetry (span generation)
              // Context plugin: injects live stack state per system-prompt build.
              [path.resolve(ctx.extensionPath, "opencode-plugin", "amicode_context.ts")],
            ),
          }),
          channel: opencodeChannel,
        });
        serverManager.onReady((url) => {
          opencodeReadyUrl = url;
        });
        await serverManager.start();
        opencodeChannel.appendLine(`[solver] switched → ${mode} (server back up)`);
        void vscode.window.showInformationMessage(
          mode === "hp"
            ? "Amicode: High-Performance + Cloud active (Piccolissimo + Altissimo — solves run in the cloud; connect an API key if you haven't)."
            : "Amicode: back on the Piccolo stack (free, local).",
        );
      }),
    );

    // Distiller transport (spec-20260705-002847 §4): written once per
    // activation so every spawner — the run-finished trigger here, the plugin's
    // onboarding trigger, and the batch shell — produces identical headless
    // distillers. Requires a resolved personal vault; without one the distiller
    // stays disabled and the session is simply unpersonalized.
    if (opencodeProject.vaultDir) {
      try {
        distillerSetup = {
          binary,
          distillerMdPath: path.resolve(ctx.extensionPath, "DISTILLER.md"),
          vaultDir: opencodeProject.vaultDir,
          opsDir: amicodeOpsDir(),
          problemsRoot: path.join(os.homedir(), ".amico", "problems"),
          runsRoot,
          model: vscode.workspace.getConfiguration("amicode").get<string>("distillerModel", "opencode/big-pickle"),
        };
        initDistillerTransport(distillerSetup);
        opencodeChannel.appendLine(
          `[boot] distiller armed (vault: ${opencodeProject.vaultDir}, model: ${distillerSetup.model})`,
        );
      } catch (e) {
        opencodeChannel.appendLine(`[boot] distiller transport failed (memory disabled this session): ${e}`);
        distillerSetup = undefined;
      }
    } else {
      opencodeChannel.appendLine(`[boot] no personal vault resolved — distiller disabled, session unpersonalized`);
    }

    // SSE event channel — opens once opencode is healthy. Carries the per-boot
    // credential (#163): the fork 401s an anonymous /event.
    sseClient = new OpencodeEventClient({
      channel: opencodeChannel,
      statusBar,
      authorization: serverAuthHeaders.Authorization,
    });
    ctx.subscriptions.push(sseClient);

    serverManager.onReady((url) => {
      opencodeReadyUrl = url;
      statusBar?.setServerReady(true);
      sseClient?.connect(url);
      // Onboarding gate: if no model is configured, open the Stage 0 webview
      // instead of chat. The webview will fire onOnboardingComplete when done,
      // which then opens chat.
      if (!isModelConfigured() && vscode.workspace.getConfiguration("amicode").get<boolean>("chat.autoOpen", true)) {
        void vscode.commands.executeCommand("amicode.onboarding.open");
        // Wire: when onboarding completes, the server restarts and the
        // onReady handler (else-if branch below) opens the chat panel.
        // We do NOT open chat here — that would race the server restart
        // and show behind the transition splash.
        // Wire: when onboarding is cancelled (X), open chat normally
        onOnboardingCancelled(() => {
          ChatPanel.openOrReveal(ctx, url, serverAuthToken(serverPassword), opencodeProject.projectDir);
        });
      } else if (vscode.workspace.getConfiguration("amicode").get<boolean>("chat.autoOpen", true)) {
        // Normal path: model configured → open chat directly
        // Post-onboarding: adopt the onboarding panel as the chat panel (zero
        // tab switching — the splash overlay fades out revealing the chat).
        if (ChatPanel.consumePendingOnboardingGreeting()) {
          const onboardPanel = getOnboardingPanel();
          if (onboardPanel) {
            releaseOnboardingPanel(); // detach from onboarding lifecycle
            const panel = ChatPanel.adopt(onboardPanel, ctx, url, serverAuthToken(serverPassword), opencodeProject.projectDir);
            panel.postOnboardingGreeting();
          } else {
            // Fallback: no onboarding panel alive (user closed it manually)
            const panel = ChatPanel.openOrReveal(ctx, url, serverAuthToken(serverPassword), opencodeProject.projectDir);
            panel.postOnboardingGreeting();
          }
        } else {
          ChatPanel.openOrReveal(ctx, url, serverAuthToken(serverPassword), opencodeProject.projectDir);
        }
      }
      // Surface ONE explicit LLM-provider signal at boot, read from opencode's
      // OWN resolution (its live /config/providers) — not a silent hang at the
      // chat box (Q129). Key-free; never logs a credential.
      void fetchProviderSignal(url.toString(), { headers: serverAuthHeaders }).then((sig) => {
        opencodeChannel.appendLine(
          sig.ok
            ? `[boot] LLM provider: configured (${sig.provider}${sig.source ? ` via ${sig.source}` : ""})`
            : `[boot] LLM provider: ${sig.reason} → ${sig.fix}`,
        );
      });
    });

    serverManager.start().catch((err) => {
      vscode.window.showErrorMessage(`Amicode: opencode failed to start — ${err.message}`);
      opencodeChannel.appendLine(`[boot] start failed: ${err.stack ?? err.message}`);
    });
  }

  // Vault setup (#13): first-run popup + `amicode.setupVault` command that creates
  // a LOCAL personal vault (dotfolder-style; no GitHub). This is the first step of
  // a broader workspace setup — synced tiers (team/public) and the Julia env are
  // intended follow-ups. Hot-refresh (no window reload): re-prep + respawn the
  // server + re-arm the distiller, mirroring the solver-mode switch above.
  const respawnForVault = async (): Promise<void> => {
    if (!binary || !serverManager) {
      const c = await vscode.window.showInformationMessage(
        "Amicode: personal vault created. Reload the window to activate it.",
        "Reload window",
      );
      if (c === "Reload window") void vscode.commands.executeCommand("workbench.action.reloadWindow");
      return;
    }
    const port = vscode.workspace.getConfiguration("amicode").get<number>("opencodePort", 0);
    const project2 = prepareOpencodeProject({
      agentsSrc: path.resolve(ctx.extensionPath, "AGENTS.md"),
      templateSrc: path.resolve(
        ctx.extensionPath,
        "templates",
        readSolverModeState().mode === "hp" ? "solve_template_hp.jl" : "solve_template.jl",
      ),
      juliaProject: resolveJuliaProject(vscode.workspace.getConfiguration("amicode").get<string>("juliaProject", "")),
      skillRoots: cfgArr("skillRoots"),
      skillLibraryRoots: cfgLibraryRoots(),
      vaultDir: vscode.workspace.getConfiguration("amicode").get<string>("vaultDir", "") || undefined,
      projectDir: path.join((ctx.storageUri ?? ctx.globalStorageUri).fsPath, "opencode-project"),
    });
    ChatPanel.setBugReportAvailable(bugReportSkillStaged(project2.skillPaths)); // #250 AC5
    await serverManager.stop();
    serverManager = new ServerManager({
      binary,
      cwd: project2.projectDir,
      port: port > 0 ? port : undefined,
      env: spawnEnv({
        amicoRunBinDir,
        serverPassword, // per-boot value survives the vault respawn too
        configContent: buildOpencodeConfigContent(
          project2.agentsPath,
          project2.templatePath,
          runsRoot,
          undefined,
          undefined,
          project2.skillPaths,
          project2.skillsStageDir,
          project2.vaultDir,
          project2.mounts,
          validatedModelPin(vscode.workspace.getConfiguration("amicode").get<string>("defaultModel", "").trim() || resolveModelPin()),
          telemetryOpen(), // gate → experimental.openTelemetry (span generation)
        ),
      }),
      channel: opencodeChannel,
    });
    serverManager.onReady((url) => {
      opencodeReadyUrl = url;
      statusBar?.setServerReady(true);
      sseClient?.connect(url);
    });
    await serverManager.start();
    if (project2.vaultDir) {
      try {
        distillerSetup = {
          binary,
          distillerMdPath: path.resolve(ctx.extensionPath, "DISTILLER.md"),
          vaultDir: project2.vaultDir,
          opsDir: amicodeOpsDir(),
          problemsRoot: path.join(os.homedir(), ".amico", "problems"),
          runsRoot,
          model: vscode.workspace.getConfiguration("amicode").get<string>("distillerModel", "opencode/big-pickle"),
        };
        initDistillerTransport(distillerSetup);
        opencodeChannel.appendLine(`[vault] distiller armed (vault: ${project2.vaultDir})`);
      } catch (e) {
        opencodeChannel.appendLine(`[vault] distiller transport failed: ${e}`);
        distillerSetup = undefined;
      }
    }
  };

  const runVaultSetup = async (fromCommand: boolean): Promise<void> => {
    if (personalMount(resolveMountStack())) {
      if (fromCommand) void vscode.window.showInformationMessage("Amicode: a personal vault is already set up.");
      return;
    }
    if (!fromCommand && ctx.globalState.get<boolean>("amicode.vaultSetup.dismissed") === true) return;
    if (!fromCommand) {
      const choice = await vscode.window.showInformationMessage(
        "Set up a personal vault? Amico will remember your systems, pulses, and problems across sessions — stored locally under ~/.amico/vaults.",
        "Create vault",
        "Not now",
        "Don't ask again",
      );
      if (choice === "Don't ask again") {
        await ctx.globalState.update("amicode.vaultSetup.dismissed", true);
        return;
      }
      if (choice !== "Create vault") return;
    }
    const raw = await vscode.window.showInputBox({
      title: "Set up a personal vault",
      prompt: "Name your vault — created locally at ~/.amico/vaults/<name> (no GitHub)",
      value: suggestVaultName(),
      validateInput: (v) => (v && sanitizeVaultName(v) ? undefined : "enter a name"),
    });
    if (!raw) return;
    let created;
    try {
      created = createLocalPersonalVault(defaultVaultsRoot(), raw);
    } catch (e) {
      void vscode.window.showErrorMessage(`Amicode: vault setup failed — ${(e as Error).message}`);
      return;
    }
    opencodeChannel.appendLine(`[vault] created local personal vault: ${created.path} (git=${created.gitInit})`);
    await respawnForVault();
    void vscode.window.showInformationMessage(`Amicode: personal vault "${created.name}" created and active.`);
  };
  ctx.subscriptions.push(vscode.commands.registerCommand("amicode.setupVault", () => void runVaultSetup(true)));
  // Personal vault by default. The onboarding wizard (opencode-side) writes the
  // profile but NOT a vault, and a genuine first-timer has none — so Amico would
  // have nowhere to remember them (distiller disabled, session unpersonalized).
  // Silently provision a LOCAL personal vault on first run when none resolves —
  // no modal, like the Julia project. The `amicode.setupVault` command remains
  // for naming / re-creating; the wizard finale offers attaching other vaults.
  // Failure-tolerant: a creation error just leaves the session unpersonalized.
  const ensureDefaultPersonalVault = async (): Promise<void> => {
    if (personalMount(resolveMountStack())) return;
    let created;
    try {
      created = createLocalPersonalVault(defaultVaultsRoot(), suggestVaultName());
    } catch (e) {
      opencodeChannel.appendLine(`[vault] default personal vault not created: ${(e as Error).message}`);
      return;
    }
    opencodeChannel.appendLine(
      `[vault] auto-provisioned local personal vault: ${created.path} (git=${created.gitInit})`,
    );
    await respawnForVault();
  };
  void ensureDefaultPersonalVault();

  // Julia setup (#8): amicode manages the Julia toolchain via juliaup — install
  // juliaup if absent, add the channel pinned to the Manifest's MINOR, and
  // instantiate the Piccolo project. Runs in a visible terminal (the consent
  // surface for the network installer). We pin the MINOR channel (latest patch,
  // e.g. 1.12.6 vs the Manifest's 1.12.3) — a patch drift install.sh already
  // treats as fine. Resolve juliaup and its sibling launcher together so a
  // standalone Julia earlier on PATH cannot intercept the `+<minor>` argument.
  const runJuliaSetup = async (fromCommand: boolean): Promise<void> => {
    const manifestSrc = path.resolve(ctx.extensionPath, "julia", "Manifest.toml");
    const projectSrc = path.resolve(ctx.extensionPath, "julia", "Project.toml");
    const minor = pinnedJuliaMinor(manifestSrc);
    const projectFingerprint = juliaProjectFingerprint(projectSrc, manifestSrc);
    if (!minor || !projectFingerprint) {
      if (fromCommand)
        void vscode.window.showErrorMessage("Amicode: could not fingerprint the bundled Julia project.");
      return;
    }
    const project = resolveJuliaProject(vscode.workspace.getConfiguration("amicode").get<string>("juliaProject", ""));
    const juliaupCommands = resolveJuliaupCommands();
    const juliaupPresent = hasJuliaup(undefined, juliaupCommands);
    const channelPresent = juliaupPresent && hasChannel(minor, undefined, juliaupCommands);
    const ready = juliaupPresent && channelPresent && projectInstantiated(project, projectFingerprint);
    if (ready) {
      if (fromCommand) void vscode.window.showInformationMessage(`Amicode: Julia ${minor} is already set up.`);
      return;
    }
    if (!fromCommand && ctx.globalState.get<boolean>("amicode.juliaSetup.dismissed") === true) return;
    if (!fromCommand) {
      const choice = await vscode.window.showInformationMessage(
        `Amicode uses Julia ${minor} (via juliaup) to run solves. Set it up now? The first run installs and precompiles the Piccolo project (a few minutes).`,
        "Set up Julia",
        "Not now",
        "Don't ask again",
      );
      if (choice === "Don't ask again") {
        await ctx.globalState.update("amicode.juliaSetup.dismissed", true);
        return;
      }
      if (choice !== "Set up Julia") return;
    }
    const steps = buildSetupSteps({
      minor,
      juliaupPresent,
      channelPresent,
      project,
      projectSrc,
      manifestSrc,
      projectFingerprint,
      juliaupCommands: juliaupCommands ?? undefined,
    });
    // Run in a visible terminal: the user watches the network installer + the
    // precompile, and cancels by closing it. We deliberately DON'T pipe to a
    // hidden task — transparency is the consent.
    const term = vscode.window.createTerminal({ name: "Amicode: Julia setup" });
    term.show();
    term.sendText(steps.map((s) => `echo '[amicode] ${s.label}...' && ${s.command}`).join(" && \\\n"));
    opencodeChannel.appendLine(`[julia] setup started (channel ${minor}, ${steps.length} step(s)) — see the terminal`);
    void vscode.window.showInformationMessage(
      `Amicode: setting up Julia ${minor} in the terminal. When it finishes, run "Amicode: Healthcheck" (Command Palette) to verify.`,
    );
  };
  ctx.subscriptions.push(vscode.commands.registerCommand("amicode.setupJulia", () => void runJuliaSetup(true)));
  // Auto-offer on first run when the toolchain isn't ready (juliaup/channel/
  // project missing) and the user hasn't dismissed. Command bypasses the gate.
  // Gated: Julia substrate belongs to the quantum-control domain pack (ADR 0008).
  if (
    isQuantumControlPackActive() &&
    shouldOfferJuliaSetup({
      juliaupPresent: hasJuliaup(),
      channelPresent: (() => {
        const m = pinnedJuliaMinor(path.resolve(ctx.extensionPath, "julia", "Manifest.toml"));
        return m ? hasChannel(m) : false;
      })(),
      projectInstantiated: projectInstantiated(
        resolveJuliaProject(vscode.workspace.getConfiguration("amicode").get<string>("juliaProject", "")),
        juliaProjectFingerprint(
          path.resolve(ctx.extensionPath, "julia", "Project.toml"),
          path.resolve(ctx.extensionPath, "julia", "Manifest.toml"),
        ) ?? "",
      ),
      dismissed: ctx.globalState.get<boolean>("amicode.juliaSetup.dismissed") === true,
    })
  ) {
    void runJuliaSetup(false);
  }

  // Healthcheck (the real `amicode.healthcheck`): verify the managed Julia
  // toolchain (Piccolo loads), the opencode server, and LLM creds. This is what
  // the Julia-setup notification points users at to confirm setup worked.
  const runHealthcheck = async (): Promise<void> => {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Amicode: running healthcheck…" },
      async () => {
        const results: HealthResult[] = [];

        // Julia: managed toolchain + `using Piccolo` loads (async; can precompile for minutes).
        const manifestSrc = path.resolve(ctx.extensionPath, "julia", "Manifest.toml");
        const projectSrc = path.resolve(ctx.extensionPath, "julia", "Project.toml");
        const minor = pinnedJuliaMinor(manifestSrc);
        const projectFingerprint = juliaProjectFingerprint(projectSrc, manifestSrc);
        const project = resolveJuliaProject(
          vscode.workspace.getConfiguration("amicode").get<string>("juliaProject", ""),
        );
        if (!minor || !projectFingerprint) {
          results.push({ name: "Julia", ok: false, detail: "could not fingerprint bundled Julia project" });
        } else if (!projectInstantiated(project, projectFingerprint)) {
          results.push({ name: "Julia", ok: false, detail: `project not instantiated — run "Amicode: Set up Julia"` });
        } else {
          const juliaupCommands = resolveJuliaupCommands();
          const channel =
            hasJuliaup(undefined, juliaupCommands) && hasChannel(minor, undefined, juliaupCommands);
          const args = channel
            ? [`+${minor}`, `--project=${project}`, "-e", "using Piccolo"]
            : [`--project=${project}`, "-e", "using Piccolo"];
          const t0 = Date.now();
          const r = await probeCommand(channel && juliaupCommands ? juliaupCommands.julia : "julia", args, 180_000);
          results.push({
            name: "Julia",
            ok: r.ok,
            ms: Date.now() - t0,
            detail: r.ok
              ? `Piccolo loads (${channel ? `juliaup ${minor}` : "system julia"})`
              : `Piccolo did not load (${r.err ?? `exit ${r.code}`})`,
            log: r.ok ? undefined : r.output || r.err, // #19: the actual Julia error, not just the exit code
          });
        }

        // opencode server (in-extension readiness state).
        results.push({
          name: "opencode server",
          ok: opencodeReadyUrl !== undefined,
          detail: opencodeReadyUrl
            ? `up at ${opencodeReadyUrl.toString()}`
            : 'down — try "Amicode: Restart opencode server"',
        });

        // LLM provider (opencode's own resolution).
        if (opencodeReadyUrl) {
          const t1 = Date.now();
          try {
            const sig = await fetchProviderSignal(opencodeReadyUrl.toString(), { headers: serverAuthHeaders });
            results.push({
              name: "LLM creds",
              ok: sig.ok,
              ms: Date.now() - t1,
              detail: sig.ok ? `configured (${sig.provider})` : `${sig.reason} → ${sig.fix}`,
            });
          } catch (e) {
            results.push({ name: "LLM creds", ok: false, ms: Date.now() - t1, detail: `check failed: ${(e as Error).message}` });
          }
        } else {
          results.push({ name: "LLM creds", ok: false, detail: "skipped (server down)" });
        }

        // Fleet (ADR 0005, #279, #324): guard + settings + tunnel. Only enforced on
        // darwin (the fleet is Mac fleet); elsewhere these checks self-skip as OK.
        // Synchronous file reads; never throws — a bad read is a failed check, not a crash.
        try {
          const repoGuardPath = path.resolve(ctx.extensionPath, FLEET_GUARD_REL);
          const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", "co.harmoniqs.amico-tunnel.plist");
          let plistContent: string | null = null;
          try {
            plistContent = fs.readFileSync(plistPath, "utf8");
          } catch {
            plistContent = null;
          }
          const fleetChecks = fleetHealthReport({
            repoGuardPath,
            configuredBinary: vscode.workspace.getConfiguration("amicode").get<string>("opencodeBinary", ""),
            configuredPort: vscode.workspace.getConfiguration("amicode").get<number>("opencodePort", 0),
            plistContent,
          });
          for (const c of fleetChecks) {
            results.push({ name: c.name, ok: c.ok, detail: c.ok ? c.detail : `${c.detail} → ${c.fix ?? ""}`.trim() });
          }
        } catch (e) {
          results.push({ name: "Fleet", ok: false, detail: `check failed: ${(e as Error).message}` });
        }

        const report = formatHealthReport(results);
        opencodeChannel.appendLine(`[healthcheck] ${new Date().toISOString()}`);
        report.lines.forEach((l) => opencodeChannel.appendLine(`  ${l}`));
        if (report.allOk) {
          void vscode.window.showInformationMessage(report.summary);
        } else {
          const c = await vscode.window.showWarningMessage(report.summary, "Show details");
          if (c === "Show details") opencodeChannel.show();
        }
      },
    );
  };
  ctx.subscriptions.push(vscode.commands.registerCommand("amicode.healthcheck", () => void runHealthcheck()));

  // Fleet repair: reinstall guard + tunnel + machine settings (idempotent).
  // Exposed for the fleet health warning's "Fix fleet" action and palette.
  const runFleetRepair = async (): Promise<void> => {
    const script = path.resolve(ctx.extensionPath, "tools", "fleet", "install.sh");
    if (!fs.existsSync(script)) {
      void vscode.window.showErrorMessage(`Amicode: fleet installer not found at ${script} — git pull?`);
      return;
    }
    const term = vscode.window.createTerminal({ name: "Amicode: Fleet repair" });
    term.show();
    term.sendText(`bash "${script}"`);
    opencodeChannel.appendLine(`[fleet] repair started: bash ${script} — watch the terminal`);
  };
  ctx.subscriptions.push(vscode.commands.registerCommand("amicode.fleet.repair", () => void runFleetRepair()));
  ctx.subscriptions.push(
    vscode.commands.registerCommand("amicode.repo.sync", async () => {
      const repoRoot = path.resolve(ctx.extensionPath, "..", "..");
      // Prefer the repo-root script when running from a checked-out workspace (F5), else the packaged copy.
      const target = fs.existsSync(path.join(repoRoot, "scripts", "repo-sync.sh")) ? path.join(repoRoot, "scripts", "repo-sync.sh") : path.resolve(ctx.extensionPath, "scripts", "repo-sync.sh");
      if (!fs.existsSync(target)) {
        void vscode.window.showErrorMessage(`Amicode: repo-sync not found at ${target} — git pull?`);
        return;
      }
      const term = vscode.window.createTerminal({ name: "Amicode: Repo Sync" });
      term.show();
      term.sendText(`bash "${target}" --fix`);
      opencodeChannel.appendLine(`[repo-sync] started: bash ${target} --fix`);
    }),
  );

  // Amicode terminal — bundles the canonical opencode (vendored + fleet-aware)
  // so `opencode` in the terminal is the same binary + same OPENCODE_CONFIG_CONTENT
  // the chat server was spawned with. That terminal can `pnpm sync`, `bash tools/fleet/install.sh --check`,
  // `amico` etc., and its `opencode` knows about fleet/fallback and can be used
  // to diagnose the same panel the user sees.
  registerAmicodeTerminal(ctx, {
    extensionPath: ctx.extensionPath,
    getConfigContent: () => currentSpawnEnv?.OPENCODE_CONFIG_CONTENT,
    getSpawnEnv: () => currentSpawnEnv,
    channel: opencodeChannel,
    getAmicodeService: () => amicodeService,
  });

  // Canonical-opencode runtime updater (#451 M4): managed install under
  // ~/.amico/opencode/canonical (first-activation bootstrap, daily checks,
  // adopt gate per the spec). The Amicode terminal's `opencode` resolves to
  // it (managed-canonical-wins); `opencode-amicode` shims the vendored fork.
  registerOpencodeUpdater(ctx, opencodeChannel);

  // Fleet mode — "Go Standalone" per CONTEXT.md (#338).
  // Config: ~/.amico/ops/fleet/fleet.json (no file = standalone).
  // Migrate legacy fallback.json on activation.
  migrateLegacyFallback();

  const fleetStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  ctx.subscriptions.push(fleetStatusItem);
  const refreshFleetStatus = (): void => {
    const role = getFleetRole();
    if (role === "client") {
      const cfg = readFleetConfig();
      fleetStatusItem.text = "$(cloud) Fleet: client";
      fleetStatusItem.tooltip = `Fleet client → ${cfg?.canonical?.host ?? "unknown"}:${cfg?.canonical?.port ?? 4096}`;
      fleetStatusItem.command = "amicode.fleet.goStandalone";
      fleetStatusItem.show();
    } else {
      fleetStatusItem.hide();
    }
  };
  refreshFleetStatus();

  const runFleetGoStandalone = async (): Promise<void> => {
    const role = getFleetRole();
    if (role === "standalone") {
      void vscode.window.showInformationMessage("Amicode: already in standalone mode (local server).");
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      "Go Standalone? This machine will leave the fleet and run its own local server permanently. You will see local sessions only.",
      { modal: true },
      "Go Standalone",
      "Cancel",
    );
    if (choice !== "Go Standalone") return;
    const cfg = vscode.workspace.getConfiguration("amicode");
    const prevBinary = cfg.get<string>("opencodeBinary", "");
    const prevPort = cfg.get<number>("opencodePort", 0);
    goStandalone({ previousBinary: prevBinary, previousPort: prevPort });
    try {
      // Clear the fleet guard override → vendored binary, ephemeral port
      await cfg.update("opencodeBinary", "", vscode.ConfigurationTarget.Global);
      await cfg.update("opencodePort", 0, vscode.ConfigurationTarget.Global);
    } catch (e) {
      opencodeChannel.appendLine(`[fleet] go standalone: settings update failed: ${(e as Error).message}`);
    }
    // Unload tunnel plist if present (best-effort, darwin only)
    if (process.platform === "darwin") {
      try {
        const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", "co.harmoniqs.amico-tunnel.plist");
        const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
        execFileSync("launchctl", ["unload", plistPath], { timeout: 5000, stdio: "ignore" });
        opencodeChannel.appendLine(`[fleet] unloaded tunnel plist ${plistPath}`);
      } catch {
        // plist may not exist or already unloaded — fine
      }
    }
    refreshFleetStatus();
    opencodeChannel.appendLine(`[fleet] Go Standalone — restarting server locally (was binary=${prevBinary || "(vendored)"} port=${prevPort})`);
    try {
      await serverManager?.stop();
      statusBar?.setServerReady(false);
      opencodeReadyUrl = undefined;
      // Stop the fleet client poll if running
      if (fleetClientPoll) { clearInterval(fleetClientPoll); fleetClientPoll = undefined; }
      // Spawn a fresh local server (vendored binary, ephemeral port)
      const resolved = resolveOpencodeBinary(ctx.extensionPath, "");
      const amicoRunBinDir2 = resolveAmicoRunBinDir(ctx.extensionPath);
      const freshManager = new ServerManager({
        binary: resolved.path,
        cwd: opencodeProject.projectDir,
        port: undefined, // ephemeral — standalone
        env: spawnEnv({
          amicoRunBinDir: amicoRunBinDir2,
          serverPassword,
          configContent: buildOpencodeConfigContent(
            opencodeProject.agentsPath,
            opencodeProject.templatePath,
            runsRoot,
            undefined,
            undefined,
            opencodeProject.skillPaths,
            opencodeProject.skillsStageDir,
            opencodeProject.vaultDir,
            opencodeProject.mounts,
            validatedModelPin(vscode.workspace.getConfiguration("amicode").get<string>("defaultModel", "").trim() || resolveModelPin()),
            telemetryOpen(),
          ),
        }),
        channel: opencodeChannel,
      });
      serverManager = freshManager;
      ctx.subscriptions.push({ dispose: () => void freshManager.stop() });
      freshManager.onReady((url) => {
        opencodeReadyUrl = url;
        statusBar?.setServerReady(true);
        sseClient?.connect(url);
        if (vscode.workspace.getConfiguration("amicode").get<boolean>("chat.autoOpen", true)) {
          ChatPanel.openOrReveal(ctx, url, serverAuthToken(serverPassword), opencodeProject.projectDir);
        }
      });
      await freshManager.start();
      void vscode.window.showInformationMessage("Amicode: Standalone mode — running locally. Your local sessions are now visible.");
    } catch (e) {
      void vscode.window.showErrorMessage(`Amicode: go standalone failed — ${(e as Error).message}`);
      opencodeChannel.appendLine(`[fleet] go standalone failed: ${(e as Error).message}`);
    }
  };

  ctx.subscriptions.push(vscode.commands.registerCommand("amicode.fleet.goStandalone", () => void runFleetGoStandalone()));

  // Activation-time fleet drift warning (darwin only). If this machine is a fleet
  // client but the guard is missing/stale or the tunnel is mis-tuned, surface
  // ONE warning with a Fix action — don't silently fork.
  void (() => {
    if (process.platform !== "darwin") return;
    try {
      const repoGuardPath = path.resolve(ctx.extensionPath, FLEET_GUARD_REL);
      const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", "co.harmoniqs.amico-tunnel.plist");
      let plistContent: string | null = null;
      try {
        plistContent = fs.readFileSync(plistPath, "utf8");
      } catch {
        plistContent = null;
      }
      const checks = fleetHealthReport({
        repoGuardPath,
        configuredBinary: vscode.workspace.getConfiguration("amicode").get<string>("opencodeBinary", ""),
        configuredPort: vscode.workspace.getConfiguration("amicode").get<number>("opencodePort", 0),
        plistContent,
      });
      const failed = checks.filter((c) => !c.ok);
      if (failed.length === 0) return;
      const detail = failed.map((c) => `${c.name}: ${c.detail}`).join("; ");
      opencodeChannel.appendLine(`[fleet] drift detected: ${detail}`);
      void vscode.window
        .showWarningMessage(`Amicode fleet drift — ${failed.map((c) => c.name).join(", ")}: ${failed[0].detail}`, "Fix fleet", "Show details")
        .then((pick) => {
          if (pick === "Fix fleet") void runFleetRepair();
          else if (pick === "Show details") opencodeChannel.show();
        });
    } catch (e) {
      opencodeChannel.appendLine(`[fleet] drift check failed: ${(e as Error).message}`);
    }
  })();

  // Connect Cloud (amicode.setCloudKey): prompt for the cloud API key and POST
  // it to the local server's connections submit route (#171) — the SERVER owns
  // validate → write ~/.amico/cloud.json → HP flip (#165/#167), so this command
  // and the panel share ONE write path and ONE flip path (ADR 0001). No direct
  // file write, entitlement grant, or switch request remains here, and there is
  // no direct-write fallback when the server is down (AC4).
  // SECURITY: the token never enters a log line or the opencodeChannel — it
  // rides only in the request body of the #163-authenticated local call.
  const runSetCloudKey = (): Promise<void> =>
    runSetCloudKeyCommand({
      ui: {
        showInputBox: (options) => vscode.window.showInputBox(options),
        withProgress: (title, task) =>
          vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, task),
        showInformationMessage: (m) => void vscode.window.showInformationMessage(m),
        showWarningMessage: (m) => void vscode.window.showWarningMessage(m),
        showErrorMessage: (m) => void vscode.window.showErrorMessage(m),
      },
      cloudUrl: vscode.workspace.getConfiguration("amicode").get<string>("cloudUrl", ""),
      server: opencodeReadyUrl
        ? { url: opencodeReadyUrl.toString(), authorization: serverAuthHeaders.Authorization }
        : undefined,
      log: (line) => opencodeChannel.appendLine(line),
    });
  // amicode#200 AC6: the solver toggle owns the connect flow — the palette
  // command deep-links the chat's defaults capsule into it, so command, panel,
  // and agent copy converge on ONE ui flow. The legacy input-box prompt stays
  // only as the fallback when no ready server exists to host the panel.
  ctx.subscriptions.push(
    vscode.commands.registerCommand("amicode.setCloudKey", () => {
      const readyUrl = opencodeReadyUrl;
      if (readyUrl) {
        ChatPanel.openOrReveal(ctx, readyUrl, serverAuthToken(serverPassword), opencodeProject.projectDir).postComputeConnect();
        return;
      }
      void runSetCloudKey();
    }),
  );

  // 5. Commands
  ctx.subscriptions.push(
    vscode.commands.registerCommand("amicode.openChat", async () => {
      // Snapshot the ready URL before any await: restartServer nulls
      // opencodeReadyUrl, so a restart racing this handler would otherwise reach
      // openOrReveal as undefined (or reveal a panel bound to a stale server).
      const readyUrl = opencodeReadyUrl;
      if (!readyUrl) {
        vscode.window.showWarningMessage(
          "Amicode: opencode server isn't ready yet. Check the 'Amicode — opencode' output channel.",
        );
        return;
      }
      // Creds gate — opencode serves HTTP 200 (→ "ready") even with zero
      // providers, so a missing credential would otherwise sail past the ready
      // check and silently hang at the chat box (Q129). Ask opencode's own live
      // resolution (/config/providers, same signal the healthcheck uses) so the
      // cause is named, not hidden. Key-free.
      const creds = await fetchProviderSignal(readyUrl.toString(), { headers: serverAuthHeaders });
      if (!creds.ok) {
        vscode.window.showWarningMessage(`Amicode: ${creds.reason} → ${creds.fix}`);
        return;
      }
      ChatPanel.openOrReveal(ctx, readyUrl, serverAuthToken(serverPassword), opencodeProject.projectDir);
    }),
    // Side-by-side sessions: ALWAYS a fresh editor tab (ViewColumn.Beside, so
    // it splits next to whatever is focused) pinned to the app's /new-session
    // draft route — each tab owns its conversation over the one server. Same
    // ready/creds gates as openChat: a second tab that can't chat is worse
    // than a named warning.
    vscode.commands.registerCommand("amicode.newChat", async () => {
      const readyUrl = opencodeReadyUrl;
      if (!readyUrl) {
        vscode.window.showWarningMessage(
          "Amicode: opencode server isn't ready yet. Check the 'Amicode — opencode' output channel.",
        );
        return;
      }
      const creds = await fetchProviderSignal(readyUrl.toString(), { headers: serverAuthHeaders });
      if (!creds.ok) {
        vscode.window.showWarningMessage(`Amicode: ${creds.reason} → ${creds.fix}`);
        return;
      }
      const draftUrl = new URL(readyUrl.href);
      draftUrl.pathname = "/new-session";
      draftUrl.search = "";
      draftUrl.hash = "";
      ChatPanel.openNew(ctx, draftUrl, serverAuthToken(serverPassword), opencodeProject.projectDir);
    }),
    // Chat Deck: MANY panes inside ONE editor tab — tab strips, drag-to-split,
    // merge-back, sashes (dist/deck_shell.js). Same ready/creds gates as the
    // other chat entries. The deck shares the one server with every ChatPanel.
    vscode.commands.registerCommand("amicode.chatDeck", async () => {
      const readyUrl = opencodeReadyUrl;
      if (!readyUrl) {
        vscode.window.showWarningMessage(
          "Amicode: opencode server isn't ready yet. Check the 'Amicode — opencode' output channel.",
        );
        return;
      }
      const creds = await fetchProviderSignal(readyUrl.toString(), { headers: serverAuthHeaders });
      if (!creds.ok) {
        vscode.window.showWarningMessage(`Amicode: ${creds.reason} → ${creds.fix}`);
        return;
      }
      DeckPanel.openOrReveal(ctx, readyUrl, serverAuthToken(serverPassword), opencodeProject.projectDir);
    }),
    // Report a Bug (amicode#250): the palette entry + the composer bug button's
    // bridge command share this one handler — the manager owns create/arm/open,
    // the lifecycle, and the single-open invariant.
    vscode.commands.registerCommand(REPORT_BUG_COMMAND, () => void bugReport.reportBug()),
    // Run picker: switch the Work Column Run Inspector between tracked runs.
    // Now posts to the bridge (no bottom panel to reveal).
    vscode.commands.registerCommand("amicode.selectRun", async () => {
      const runs = runsManager?.runs() ?? [];
      if (runs.length === 0) {
        void vscode.window.showInformationMessage("Amicode: no runs tracked yet.");
        return;
      }
      const items: (vscode.QuickPickItem & { runId?: string; follow?: boolean })[] = [
        {
          label: "$(radio-tower) Follow latest",
          description: "auto-follow the newest run (release pin)",
          follow: true,
        },
        ...[...runs].reverse().map((r) => {
          const stalled = r.phase === "live" && stopPlan(r.runDir) === "force";
          return {
            label: `${r.phase === "live" ? (stalled ? "$(warning)" : "$(pulse)") : r.status === "completed" ? "$(pass)" : r.status === "stopped" ? "$(debug-pause)" : "$(error)"} ${r.runId}`,
            description: [
              r.phase === "live"
                ? stalled
                  ? `stalled · iter ${r.latestIter ?? 0}`
                  : `live · iter ${r.latestIter ?? 0}`
                : r.status,
              r.fidelity !== undefined ? `F=${r.fidelity.toFixed(5)}` : undefined,
              r.scriptPath ? path.basename(r.scriptPath) : undefined,
            ]
              .filter(Boolean)
              .join(" · "),
            runId: r.runId,
          };
        }),
      ];
      const pick = await vscode.window.showQuickPick(items, { placeHolder: "Amicode: select the run to inspect" });
      if (!pick) return;
      if (pick.follow) runsManager?.resumeAutoFollow();
      else if (pick.runId) runsManager?.selectRun(pick.runId);
    }),
    vscode.commands.registerCommand("amicode.stopRun", async () => {
      const dir = runsManager?.getActiveRunDir();
      if (!dir) {
        vscode.window.showWarningMessage("Amicode: no active run to stop.");
        return;
      }
      // Escalation ladder: cooperative STOP only works while a solver is alive
      // to poll it — a stalled run gets the hard path immediately, a healthy
      // one gets a grace window and then an explicit Force-stop offer (never a
      // silent kill: one long Ipopt iteration can look wedged).
      const label = path.basename(dir); // every toast names the run — stop A, start B, a nameless dialog at t+120s reads as "B is wedged"
      if (pendingStops.has(dir)) {
        vscode.window.showInformationMessage(`Amicode: stop already in progress for ${label}.`);
        return;
      }
      const plan = stopPlan(dir);
      if (plan === "already-finished") {
        vscode.window.showInformationMessage(`Amicode: run ${label} has already finished.`);
        return;
      }
      // Best-effort: a deleted run dir throws ENOENT here, and the force path
      // below must still be reachable to clear the registry/UI entry.
      try {
        writeStopFile(dir);
      } catch {
        /* dir gone — force path handles it */
      }
      if (plan === "force") {
        await forceStop(dir);
        vscode.window.showInformationMessage(`Amicode: run ${label} was stalled — force-stopped and marked aborted.`);
        return;
      }
      vscode.window.showInformationMessage(
        `Amicode: stop requested for ${label} — the solve will halt at the next iteration.`,
      );
      const mtimeAtStop = runLogMtime(dir);
      pendingStops.add(dir);
      const timer = setTimeout(async () => {
        pendingStops.delete(dir);
        if (stopPlan(dir) === "already-finished") return; // cooperative stop landed
        if (runLogMtime(dir) !== mtimeAtStop) return; // still iterating — let it reach the callback
        const pick = await vscode.window.showWarningMessage(
          `Amicode: run ${label} hasn't responded to stop.`,
          "Force stop",
          "Keep waiting",
        );
        if (pick === "Force stop") {
          await forceStop(dir);
          vscode.window.showInformationMessage(`Amicode: run ${label} force-stopped and marked aborted.`);
        }
      }, 120_000);
      ctx.subscriptions.push({
        dispose: () => {
          clearTimeout(timer);
          pendingStops.delete(dir);
        },
      });
    }),
    vscode.commands.registerCommand("amicode.openRunDir", async () => {
      const dir = runsManager?.getActiveRunDir();
      if (!dir) {
        vscode.window.showWarningMessage("Amicode: no active run.");
        return;
      }
      // revealFileInOS wants a FILE (a bare directory errors on macOS) — reveal
      // the manifest, which every run dir has from birth; fall back to opening
      // the folder externally if the reveal still fails.
      const manifest = path.join(dir, "run.toml");
      try {
        await vscode.commands.executeCommand(
          "revealFileInOS",
          vscode.Uri.file(fs.existsSync(manifest) ? manifest : dir),
        );
      } catch {
        await vscode.env.openExternal(vscode.Uri.file(dir));
      }
    }),
    vscode.commands.registerCommand("amicode.savePulse", async () => {
      const dir = runsManager?.getActiveRunDir();
      if (!dir) {
        vscode.window.showWarningMessage("Amicode: no active run.");
        return;
      }
      try {
        const uri = await vscode.window.showSaveDialog({
          filters: { JLD2: ["jld2"] },
          defaultUri: vscode.Uri.file(path.join(dir, "pulse.jld2")),
        });
        if (uri) {
          savePulseTo(dir, uri.fsPath);
          vscode.window.showInformationMessage("Amicode: pulse saved.");
        }
      } catch (e) {
        vscode.window.showErrorMessage(`Amicode: ${(e as Error).message}`);
      }
    }),
    // Distill trigger 3 (manual): coarse idempotent sweep — safe to mash.
    vscode.commands.registerCommand("amicode.distillNow", () => {
      if (!distillerSetup) {
        void vscode.window.showWarningMessage("Amicode: distiller disabled (no personal vault resolved).");
        return;
      }
      triggerSweep(distillerSetup, true);
      void vscode.window.showInformationMessage("Amicode: distilling recent sessions in the background.");
    }),
    vscode.commands.registerCommand("amicode.restartServer", async () => {
      // Fix #382: error page's Restart now posts this from the iframe
      // (opencode#210's entry.tsx posts amicode.restartServer before reload);
      // the bridge allowlist already permits it, so the server restart here
      // clears the "Something went wrong" state instead of being a no-op.
      opencodeChannel.appendLine(`[boot] restart requested`);
      // Fleet client: no local server to restart — just re-probe the tunnel
      if (binary !== undefined && isFleetClientGuard(binary)) {
        const fleetCfgRestart = readFleetConfig();
        const restartPort = fleetCfgRestart?.canonical?.port ?? 4096;
        opencodeChannel.appendLine(`[fleet] client restart — re-probing tunnel 127.0.0.1:${restartPort}`);
        statusBar?.setServerReady(false);
        opencodeReadyUrl = undefined;
        // poke the poll immediately — it will re-attach when the forward is back
        try {
          const r = await fetch(`http://127.0.0.1:${restartPort}/`, { signal: AbortSignal.timeout(1500), headers: serverAuthHeaders });
          if (r.ok || (r.status >= 200 && r.status < 400)) {
            opencodeReadyUrl = new URL(`http://127.0.0.1:${restartPort}`);
            statusBar?.setServerReady(true);
            sseClient?.connect(opencodeReadyUrl);
            opencodeChannel.appendLine(`[fleet] tunnel up at ${opencodeReadyUrl}`);
          } else {
            opencodeChannel.appendLine(`[fleet] tunnel still down (status ${r.status}) — go standalone to work locally`);
          }
        } catch (e) {
          opencodeChannel.appendLine(`[fleet] tunnel still down — ${(e as Error).message} — go standalone to work locally`);
        }
        return;
      }
      await serverManager?.stop();
      statusBar?.setServerReady(false);
      opencodeReadyUrl = undefined;
      try {
        await serverManager?.start();
      } catch (err) {
        vscode.window.showErrorMessage(`Amicode: restart failed — ${(err as Error).message}`);
      }
    }),
    // On-site fallback (β.6): stage the bundled pre-baked solve into the runs
    // root. Under the multi-run RunsManager (#57) a run that is FINISHED at
    // discovery registers quietly (no auto-display), so the demo is shown by
    // EXPLICIT selection: poke the index tail (same-tick registration), then
    // selectRun → the display replay renders the converged solve — no Julia,
    // no opencode, no creds. Promote stays suppressed (finished at discovery).
    vscode.commands.registerCommand("amicode.replayDemo", async () => {
      const demoDir = path.join(ctx.extensionPath, "demo", "run");
      if (!fs.existsSync(path.join(demoDir, "FINISHED"))) {
        void vscode.window.showErrorMessage("Amicode: demo run not bundled — reinstall the VSIX.");
        return;
      }
      try {
        const runDir = stageDemoRun(demoDir, runsRoot);
        runsManager?.pokeDiscovery();
        runsManager?.selectRun(path.basename(runDir));
        runsChannel.appendLine(`[demo] replayed → ${runDir}`);
      } catch (e) {
        void vscode.window.showErrorMessage(`Amicode: replay failed — ${(e as Error).message}`);
      }
    }),
  );

  // Device Inspector poll loop — now posts to the Work Column bridge.
  ctx.subscriptions.push(
    vscode.commands.registerCommand("amicode.device.refresh", () => {
      void refreshDeviceInspector(devicesChannel);
    }),
  );
  // Fixed-cadence poll; DORMANT (early-return) until a device is configured, so
  // this is always safe to run. Cleared on deactivate.
  devicePollTimer = setInterval(() => void refreshDeviceInspector(devicesChannel), DEVICE_POLL_MS);
  ctx.subscriptions.push({
    dispose: () => {
      if (devicePollTimer) {
        clearInterval(devicePollTimer);
        devicePollTimer = undefined;
      }
    },
  });

  // Redo Onboarding (developer tool): reset onboarding state and re-open the
  // Stage 0 webview. For existing users, preserves current model config.
  ctx.subscriptions.push(
    vscode.commands.registerCommand("amicode.redoOnboarding", async () => {
      // Reset onboarding state files
      const onboardDir = path.join(amicodeOpsDir(), "onboarding");
      const eventsFile = path.join(onboardDir, "events.jsonl");
      const stateFile = path.join(amicodeOpsDir(), "onboarding_state.json");
      try { fs.unlinkSync(eventsFile); } catch { /* may not exist */ }
      try { fs.unlinkSync(stateFile); } catch { /* may not exist */ }
      try { fs.unlinkSync(path.join(os.homedir(), ".amico", "profile.json")); } catch { /* may not exist */ }
      // Close the chat panel so the onboarding panel is visible
      ChatPanel.disposeCurrent();
      // Open the onboarding panel
      void vscode.commands.executeCommand("amicode.onboarding.open");
    }),
  );

  opencodeChannel.appendLine(`[boot] activated; runsRoot=${runsRoot}; amicoRunBinDir=${amicoRunBinDir ?? "(none)"}`);
}

export function deactivate(): void {
  if (fleetClientPoll) {
    clearInterval(fleetClientPoll);
    fleetClientPoll = undefined;
  }
  if (devicePollTimer) {
    clearInterval(devicePollTimer);
    devicePollTimer = undefined;
  }
  // Distill trigger 2 (session close): queue-only — a drain must not delay
  // shutdown; the next activation or trigger drains the queue.
  if (distillerSetup) triggerSweep(distillerSetup, false);
  sseClient?.dispose();
  serverManager?.stop();
  runsManager?.dispose();
  statusBar?.dispose();
}
