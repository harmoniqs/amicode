import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import { ServerManager } from "./server_manager";
import { fetchProviderSignal } from "./llm_creds.mjs";
import { resolveOpencodeBinary, OpencodeMissingError, unsupportedHostAdvice } from "./opencode_binary";
import { ChatPanel } from "./chat_panel";
import { DeckPanel } from "./deck_panel";
import { registerRunInspector, revealInspector } from "./run_inspector";
import { registerCatalogCard } from "./catalog_card_shell";
import { registerTrees } from "./trees";
import { StatusBarManager } from "./status_bar";
import {
  prepareOpencodeProject,
  resolveJuliaProject,
  buildOpencodeConfigContent,
  resolveModelPin,
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
import { writeStopFile, savePulseTo, catalogPulsesDir, stopPlan, forceStop, runLogMtime } from "./run_controls";
import { watchSolverMode, applyEntitlementForMode, effectiveSolverMode, reconcileSolverMode } from "./solver_mode";
import { runSetCloudKeyCommand } from "./cloud_key";
import { amicodeOpsDir } from "./substrate/vault_store";
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
import { resolveMountStack, personalMount, defaultVaultsRoot } from "./substrate/mount_store";
import { initDistillerTransport, triggerRunDistill, triggerSweep, type DistillerSetup } from "./substrate/distiller";
import * as os from "node:os";
import { readTomlSafe } from "./run_dir_reader";
import { parse as parseYaml } from "yaml";
import { registerDeviceInspector, getDeviceInspector, revealDeviceInspector } from "./device_inspector";
import { loadGraph } from "./calibration_graph";
import { parseStateJson } from "./device_registry";
import { buildDeviceStatus, nextActions, capabilityHint, type DriveLine } from "./device_status";
import { SchusterJobServer } from "./qick_client";
import type { QueueView } from "./qick_job_server";

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
let runsManager: RunsManager | undefined;
let opencodeReadyUrl: URL | undefined;
/** Set once the binary + vault are known; the watcher's onRunFinished closure
 *  and the distillNow command read it lazily (undefined = distiller disabled). */
let distillerSetup: DistillerSetup | undefined;
/** Device Inspector poll timer (Spec A §5.1) — cleared on deactivate. */
let devicePollTimer: ReturnType<typeof setInterval> | undefined;

const DEVICE_POLL_MS = 2500; // mirror the RunsManager cadence

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

/** Poll tick (Spec A §3, §5.1). Dormant until `amicode.device.name` +
 *  `amicode.device.graph` are set. All I/O is never-reject: a dead endpoint /
 *  missing file degrades the projection to uncharacterized/offline, never
 *  crashes the session. The heavy package-resolution entitlement authority
 *  (qick_client.isQilcEntitled) runs at session prep, not this hot path — here
 *  the fast health() capability flag is the advisory hint (§5.2). */
async function refreshDeviceInspector(channel: vscode.OutputChannel): Promise<void> {
  const inspector = getDeviceInspector();
  if (!inspector) return;
  const cfg = vscode.workspace.getConfiguration("amicode");
  const deviceName = (cfg.get<string>("device.name", "") || "").trim();
  const graphPath = (cfg.get<string>("device.graph", "") || "").trim();
  if (!deviceName || !graphPath) return; // dormant until a device is configured

  try {
    const loaded = loadGraph(fs.readFileSync(graphPath, "utf8"));
    if (!loaded.ok) {
      channel.appendLine(`[device] graph ${graphPath} failed to load: ${loaded.error}`);
      return;
    }
    // rolling ops state (§4.2): ~/.amico/amicode/devices/<name>/state.json
    const stateFile = path.join(amicodeOpsDir(), "devices", deviceName, "state.json");
    let state = {};
    try {
      state = parseStateJson(fs.readFileSync(stateFile, "utf8"));
    } catch {
      /* no state yet → everything reads uncharacterized (honest) */
    }
    const card = readDeviceCard((cfg.get<string>("device.card", "") || "").trim());

    // queue + health from the configured job-server endpoint (never-reject); no
    // endpoint → empty queue (idle) + no online channels (all drive lines offline).
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
    const entitled = capabilityHint("qilc", capabilities); // advisory hint; authority = package resolution (prep)
    const { ranked_actions } = nextActions(loaded.graph, state, queue, now, { entitled });

    inspector.postDeviceStatus(deviceName, status);
    inspector.postActions(deviceName, ranked_actions);
    inspector.activate(deviceName);
  } catch (e) {
    channel.appendLine(`[device] refresh error: ${(e as Error).message}`);
  }
}

/** Run dirs with a cooperative stop in flight (escalation timer armed) — a
 *  second Stop click must not stack a second dialog. */
const pendingStops = new Set<string>();

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
  ): Record<string, string> =>
    (currentSpawnEnv = buildServerSpawnEnv({
      ...o,
      amicoPython,
      telemetry: resolveTelemetryContext(ctx, { sessionId: telemetrySessionId }),
    }));

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

  // 1. UI surfaces
  const trees = registerTrees(ctx);
  registerRunInspector(ctx);
  registerDeviceInspector(ctx); // Spec A §3 — device dashboard, sibling to the Run Inspector
  registerCatalogCard(ctx); // #47 dev scaffold — card opens via the save-to-catalog flow
  ctx.subscriptions.push(
    // #47 session catalog: record the save (workspaceState + tree), then open
    // the card. Both prompts (demo replay, live promote) route through here.
    vscode.commands.registerCommand("amicode.catalog.save", async (runDir: string) => {
      const manifest = readTomlSafe(path.join(runDir, "run.toml")) ?? {};
      const result = readTomlSafe(path.join(runDir, "result.toml")) ?? {};
      const params = (result.params ?? {}) as Record<string, unknown>;
      const family = typeof params.system === "string" ? params.system : undefined;
      // System identity is USER-NAMED (researchers think in named devices —
      // "Emerald-Q3" — not families); the family prefills as the default and
      // level counts stay in the card's params rows. Esc keeps the family.
      const name = await vscode.window.showInputBox({
        prompt: "Name this system (shown on the catalog entry)",
        value: family ?? "",
        placeHolder: "e.g. Emerald-Q3",
      });
      const system = name?.trim() ? name.trim() : family;
      // Tags: the quick-digest handles for hyperparameter sweeps ("high-R",
      // "T=8", "fast-ansatz") — optional, comma-separated.
      const tagsRaw = await vscode.window.showInputBox({
        prompt: "Tags (comma-separated, optional)",
        placeHolder: "e.g. high-R, T=8, fast",
      });
      const tags =
        tagsRaw
          ?.split(",")
          .map((t) => t.trim())
          .filter(Boolean) ?? [];
      await trees.catalog.save({
        run_id: String(manifest.run_id ?? path.basename(runDir)),
        runDir,
        lab_id: String(manifest.lab_id ?? "default"),
        gate: typeof params.gate === "string" ? params.gate : undefined,
        system,
        tags,
        fidelity: Number(result.fidelity ?? 0),
        saved_at: new Date().toISOString(),
      });
      await vscode.commands.executeCommand("amicode.catalogCard.open", runDir, system, tags);
    }),
    vscode.commands.registerCommand("amicode.catalog.refresh", () => trees.catalog.refresh()),
    // Context-menu removal: unsave the pointer; run artifacts stay on disk.
    vscode.commands.registerCommand("amicode.catalog.remove", async (entry?: { run_id?: string }) => {
      if (entry?.run_id) await trees.catalog.remove(entry.run_id);
    }),
  );
  statusBar = new StatusBarManager();
  ctx.subscriptions.push({ dispose: () => statusBar?.dispose() });

  // 2. Start the multi-run RunsManager immediately — it tails the append-only
  // runs/index (1.2, #57), so solves from prior dev-host sessions register and
  // a still-live run resumes; every concurrent run is tracked to completion.
  fs.mkdirSync(runsRoot, { recursive: true });
  runsManager = new RunsManager({
    runsRoot,
    channel: runsChannel,
    statusBar,
    // Distill trigger 1 (spec-20260705-002847 §4.1): every LIVE completion —
    // including failures (failure lessons are first-class knowledge, §4.4).
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
      effectiveSolverMode() === "hp" ? "solve_template_hp.jl" : "solve_template.jl",
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

  if (binary !== undefined) {
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
          vscode.workspace.getConfiguration("amicode").get<string>("defaultModel", "").trim() || resolveModelPin(),
          // Telemetry gate → experimental.openTelemetry (span generation), coupled
          // to the exporter env this same spawnEnv resolves.
          telemetryOpen(),
        ),
      }),
      channel: opencodeChannel,
    });
    ctx.subscriptions.push({ dispose: () => void serverManager?.stop() });

    // Before watching for NEW switches, repair a half-landed old one. The mode
    // file only changes on a `status:"switching"` request, so a dropped write
    // leaves it stale while the issimo entitlement says otherwise — and every
    // cloud decision (routing, template SOLVER, the app's own toggle) reads the
    // file. Observed 2026-08-05: file said piccolo (Jul 28) with issimo granted
    // and Harmoniqs Cloud connected, so a paid-tier solve ran locally on IPOPT
    // and nothing anywhere said so.
    {
      const { healed, mode } = reconcileSolverMode();
      if (healed)
        opencodeChannel.appendLine(
          `[solver] solver-mode.json disagreed with the issimo entitlement — healed to ${mode}. ` +
            `A switch request lost its write; the tier is ${mode}.`,
        );
    }
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
        });
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
              vscode.workspace.getConfiguration("amicode").get<string>("defaultModel", "").trim() || resolveModelPin(),
              telemetryOpen(), // gate → experimental.openTelemetry (span generation)
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
      // Open the chat as soon as the server is up (amicode.chat.autoOpen,
      // default on) — the chat IS the product's front door.
      if (vscode.workspace.getConfiguration("amicode").get<boolean>("chat.autoOpen", true)) {
        ChatPanel.openOrReveal(ctx, url, serverAuthToken(serverPassword), opencodeProject.projectDir);
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
        effectiveSolverMode() === "hp" ? "solve_template_hp.jl" : "solve_template.jl",
      ),
      juliaProject: resolveJuliaProject(vscode.workspace.getConfiguration("amicode").get<string>("juliaProject", "")),
      skillRoots: cfgArr("skillRoots"),
      skillLibraryRoots: cfgLibraryRoots(),
      vaultDir: vscode.workspace.getConfiguration("amicode").get<string>("vaultDir", "") || undefined,
      projectDir: path.join((ctx.storageUri ?? ctx.globalStorageUri).fsPath, "opencode-project"),
    });
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
          vscode.workspace.getConfiguration("amicode").get<string>("defaultModel", "").trim() || resolveModelPin(),
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
  if (
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
    vscode.commands.registerCommand("amicode.openInspector", async () => {
      await revealInspector();
    }),
    // Run picker (pre-UX4 utility): switch the inspector between tracked runs.
    // Picking pins the selection (a background solve won't steal the view);
    // "Follow latest" releases the pin and resumes newest-run auto-follow.
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
          // A "live" run whose log has gone cold is stalled — the picker must
          // agree with the status bar, not advertise a wedge as live.
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
      await revealInspector();
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
      const catalog = catalogPulsesDir();
      const picks = [catalog ? "Save to catalog" : undefined, "Save to file…"].filter(Boolean) as string[];
      const choice = await vscode.window.showQuickPick(picks, { title: "Save pulse" });
      if (!choice) return;
      try {
        if (choice === "Save to catalog" && catalog) {
          const name = `${path.basename(dir)}.jld2`;
          savePulseTo(dir, path.join(catalog, name));
          vscode.window.showInformationMessage(`Amicode: saved pulse to catalog (${name}).`);
        } else {
          const uri = await vscode.window.showSaveDialog({
            filters: { JLD2: ["jld2"] },
            defaultUri: vscode.Uri.file(path.join(dir, "pulse.jld2")),
          });
          if (uri) {
            savePulseTo(dir, uri.fsPath);
            vscode.window.showInformationMessage("Amicode: pulse saved.");
          }
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
      opencodeChannel.appendLine(`[boot] restart requested`);
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
        await revealInspector();
        // Save-to-catalog prompt (#47): the watcher suppresses the promote
        // prompt for runs already finished at switch (anti-re-pop), so the
        // explicit replay owns its own prompt → the catalog card.
        const fid = Number((readTomlSafe(path.join(runDir, "result.toml")) ?? {}).fidelity ?? NaN);
        if (fid >= 0.99) {
          const choice = await vscode.window.showInformationMessage(
            `Amicode: demo solve converged (F=${fid.toFixed(4)}). Save to catalog?`,
            "Save to catalog",
            "Not now",
          );
          if (choice === "Save to catalog") await vscode.commands.executeCommand("amicode.catalog.save", runDir);
        }
      } catch (e) {
        void vscode.window.showErrorMessage(`Amicode: replay failed — ${(e as Error).message}`);
      }
    }),
  );

  // Device Inspector commands + poll loop (Spec A §3, §5.1).
  ctx.subscriptions.push(
    vscode.commands.registerCommand("amicode.openDeviceInspector", async () => {
      await revealDeviceInspector();
      void refreshDeviceInspector(devicesChannel);
    }),
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

  opencodeChannel.appendLine(`[boot] activated; runsRoot=${runsRoot}; amicoRunBinDir=${amicoRunBinDir ?? "(none)"}`);
}

export function deactivate(): void {
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
