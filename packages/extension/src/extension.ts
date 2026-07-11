import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import { ServerManager } from "./server_manager";
import { fetchProviderSignal } from "./llm_creds.mjs";
import { resolveOpencodeBinary, OpencodeMissingError } from "./opencode_binary";
import { ChatPanel } from "./chat_panel";
import { registerRunInspector, revealInspector } from "./run_inspector";
import { registerCatalogCard } from "./catalog_card_shell";
import { registerTrees } from "./trees";
import { StatusBarManager } from "./status_bar";
import { prepareOpencodeProject, resolveJuliaProject, buildOpencodeConfigContent, resolveModelPin } from "./opencode_config";
import { resolveAmicoRunBinDir, resolveRunsRoot } from "./opencode_paths";
import { resolveLabTomlPath, checkLabToml } from "./lab_config";
import { OpencodeEventClient } from "./sse_client";
import { RunsManager } from "./runs_manager";
import { stageDemoRun } from "./demo_replay";
import { writeStopFile, savePulseTo, catalogPulsesDir, stopPlan, forceStop, runLogMtime } from "./run_controls";
import { amicodeOpsDir } from "./substrate/vault_store";
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
      .map((d) => ({ id: String(d.id), target: typeof d.target === "string" ? d.target : undefined, kind: typeof d.kind === "string" ? d.kind : undefined }));
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

  // 1. UI surfaces
  const trees = registerTrees(ctx);
  registerRunInspector(ctx);
  registerDeviceInspector(ctx);   // Spec A §3 — device dashboard, sibling to the Run Inspector
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
  const opencodeProject = prepareOpencodeProject({
    agentsSrc: path.resolve(ctx.extensionPath, "AGENTS.md"),
    templateSrc: path.resolve(ctx.extensionPath, "templates", "solve_template.jl"),
    juliaProject: resolveJuliaProject(vscode.workspace.getConfiguration("amicode").get<string>("juliaProject", "")),
    skillRoots: cfgArr("skillRoots"),
    skillLibraryRoots: cfgArr("skillLibraryRoots"),
    // User-memory substrate (spec-20260705-002847): "" in the setting keeps the
    // auto-resolve (kind=personal marker scan); a path pins the vault explicitly.
    vaultDir: vscode.workspace.getConfiguration("amicode").get<string>("vaultDir", "") || undefined,
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
      opencodeChannel.appendLine(`[boot] ${e.message} — chat disabled`);
      void vscode.window.showErrorMessage(`Amicode: ${e.message}`);
    } else throw e;
  }

  if (binary !== undefined) {
    // amico-run is argv-only (β.1) — no AMICO_* env propagation (S37). The agent
    // gets the Julia project from AGENTS.md (substituted at session-copy time)
    // and passes it as `--project`. PATH just needs to resolve the launcher.
    if (amicoRunBinDir === undefined) {
      opencodeChannel.appendLine(
        `[boot] WARNING: amico-run launcher not found — chat can author but solves won't run (build amico-run or check the VSIX)`,
      );
    }
    // opencode owns the LLM credential (0.3): amico injects NO key into the
    // spawn env — opencode resolves its provider from its own env / config /
    // auth.json. The spawn env carries only PATH (so amico-run resolves) and the
    // amico instructions/permission config.
    const configuredPort = vscode.workspace.getConfiguration("amicode").get<number>("opencodePort", 0);
    if (configuredPort > 0) {
      opencodeChannel.appendLine(`[boot] amicode.opencodePort = ${configuredPort} (static)`);
    }
    serverManager = new ServerManager({
      binary,
      cwd: opencodeProject.projectDir,
      port: configuredPort > 0 ? configuredPort : undefined,
      env: {
        PATH: `${amicoRunBinDir ? amicoRunBinDir + ":" : ""}${process.env.PATH ?? ""}`,
        // Inject the amico solve workflow as opencode `instructions` (loaded for
        // every session regardless of its cwd) — merges over the user's global
        // config, so the model/provider are preserved. This is what makes the
        // chat actually author + run solves instead of behaving like vanilla
        // opencode (the session cwd is the workspace, not opencodeProject.projectDir).
        OPENCODE_CONFIG_CONTENT: buildOpencodeConfigContent(
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
          // Model pin (fallback-only, resolveModelPin): without it, default
          // resolution gambles on provider ordering — with Google creds it
          // picked a preview model that hung every headless/agent turn.
          resolveModelPin(),
        ),
      },
      channel: opencodeChannel,
    });
    ctx.subscriptions.push({ dispose: () => void serverManager?.stop() });

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

    // SSE event channel — opens once opencode is healthy.
    sseClient = new OpencodeEventClient({ channel: opencodeChannel, statusBar });
    ctx.subscriptions.push(sseClient);

    serverManager.onReady((url) => {
      opencodeReadyUrl = url;
      statusBar?.setServerReady(true);
      sseClient?.connect(url);
      // Open the chat as soon as the server is up (amicode.chat.autoOpen,
      // default on) — the chat IS the product's front door.
      if (vscode.workspace.getConfiguration("amicode").get<boolean>("chat.autoOpen", true)) {
        ChatPanel.openOrReveal(ctx, url);
      }
      // Surface ONE explicit LLM-provider signal at boot, read from opencode's
      // OWN resolution (its live /config/providers) — not a silent hang at the
      // chat box (Q129). Key-free; never logs a credential.
      void fetchProviderSignal(url.toString()).then((sig) => {
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
      const creds = await fetchProviderSignal(readyUrl.toString());
      if (!creds.ok) {
        vscode.window.showWarningMessage(`Amicode: ${creds.reason} → ${creds.fix}`);
        return;
      }
      ChatPanel.openOrReveal(ctx, readyUrl);
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
