// companion.ts — the always-local `ui`-kind companion's extension-host entry
// (#1274, ADR 0025 P2). This is the load-bearing feasibility artifact for the
// default-flip: a SEPARATE extension declaring `extensionKind: ["ui"]` (see
// package.json) so it ALWAYS activates on the CLIENT and stays alive while the
// main extension (`extensionKind: ["workspace"]`) relocates to the host under
// Remote-SSH. It holds NO engine or store (never-fork) — only a client-side
// probe (probe.ts) and the programmatic window reopen (reopen.ts).
//
// UNIT-PROVABLE here (AC1 testable half): activate() registers its command and
// wires the probe + reopen client-side. The "remains running during a LIVE
// relocation" half is runtime/HITL — it lives in the go/no-go artifact
// (docs/fleet/p2-companion-go-no-go-1274.md), not a unit test.

import * as vscode from "vscode";
import { probeHubHealth, type HubProbeResult } from "./probe";
import {
  resolveRemoteSshReopenTarget,
  resolveLocalReopenTarget,
  reopenWindow,
  type ReopenOutcome,
} from "./reopen";
import { LinkSensor, type LinkPosture, type SensorScheduler } from "./link_sensor";
import { AutoDownSwitch } from "./auto_switch";
import { PromptUpSwitch } from "./prompt_up";

/** The one command the companion contributes (see package.json contributes). */
export const REOPEN_COMMAND = "amicode.companion.reopenWindow";

/** The client-side setting the companion probes — it reads ONLY this, never a
 *  host-side instance or posture file (that independence is the whole point). */
export const COMPANION_HUB_URL_SETTING = "amicode.companion.hubUrl";

/** The client-side setting naming the LOCAL workspace folder the auto-DOWN drop
 *  (#1276) reopens into — the thin-client lifeboat where #1267's FileSystemProvider
 *  surfaces host files. Empty = no local target known (the drop then surfaces the
 *  transition and the reopen's honest "no local folder" error rather than a
 *  half-window). #1278 will supply/carry this across the switch. */
export const COMPANION_LOCAL_PATH_SETTING = "amicode.companion.localWorkspacePath";

/** The client-side setting naming the hub's Remote-SSH alias the prompt-UP
 *  (#1277) reopen returns into on a sustained recovery. Empty = no Remote-SSH
 *  target known; a recovery then surfaces the honest "cannot resolve" notice
 *  rather than a half-prompt. #1278 may back this with the fleet projection's
 *  sshAlias so it needs no manual setting. */
export const COMPANION_HUB_SSH_ALIAS_SETTING = "amicode.companion.hubSshAlias";

/** Arguments for a programmatic reopen. The alias/paths are supplied by the
 *  caller (a command arg here); #1275-1278 will wire them from the fleet
 *  projection + the window-mode field. */
export interface ReopenArgs {
  /** For LOCAL → Remote-SSH: the hub's SSH alias. */
  alias?: string;
  /** For LOCAL → Remote-SSH: the remote workspace path (default `~`). */
  remotePath?: string;
  /** For Remote-SSH → LOCAL: the absolute local folder path. */
  localPath?: string;
}

/** Injectable seams so activate() is unit-testable without the VS Code host.
 *  Every field defaults to the real client-side wiring in production. */
export interface CompanionDeps {
  /** The probe's fetch (default the global fetch). */
  probeFetch?: typeof fetch;
  /** The client-configured hub base URL (default: read the setting). */
  hubUrl?: () => string | undefined;
  /** The window's remote authority (default: `vscode.env.remoteName`) — decides
   *  the reopen direction (a remote window flips to local, a local one to remote). */
  remoteName?: () => string | undefined;
  /** How to open the folder (default: `vscode.openFolder`). */
  openFolder?: (uri: string, opts: { forceNewWindow: boolean }) => void | Promise<void>;
  /** How to surface an honest error (default: `showErrorMessage`). */
  showError?: (message: string) => void;
  /** The link sensor's timer seam (default: global setInterval/clearInterval).
   *  Injected in tests so the cadence is driven without real timers. */
  scheduler?: SensorScheduler;
  /** Called each sensor tick with the freshly classified posture — an OBSERVER
   *  seam (the built-in #1276 auto-DOWN orchestrator is always wired independently
   *  of this; #1277 prompt-UP will extend the orchestrator, not replace it). */
  onPosture?: (posture: LinkPosture) => void;
  /** #1276 auto-DOWN seams — all injectable so the drop is testable without the
   *  VS Code host or real timers. */
  /** The clock the switch-frequency floor is measured against (default Date.now). */
  now?: () => number;
  /** Whether any editor has unsaved changes — the dirty guard (default reads
   *  `vscode.workspace.textDocuments`). */
  isEditorDirty?: () => boolean;
  /** Surface the auto-DOWN transition (default `vscode.window.showWarningMessage`). */
  showMessage?: (message: string) => void;
  /** The absolute LOCAL folder the auto-DOWN drop reopens into (default: read the
   *  local-workspace setting). */
  localReopenPath?: () => string | undefined;
  /** The switch-frequency floor in ms (default DEFAULT_MIN_SWITCH_INTERVAL_MS). */
  minSwitchIntervalMs?: number;
  /** #1277 prompt-UP seams — all injectable so the prompt + reopen are testable
   *  without the VS Code host or real timers. */
  /** The hub's Remote-SSH alias the prompt-UP reopen returns into (default: read
   *  the hub-ssh-alias setting). #1278 may source this from the fleet projection. */
  remoteSshAlias?: () => string | undefined;
  /** The remote workspace path the reopen targets (default `~`, the home
   *  default — coherent with the fleet state root ~/.amico/). */
  remotePath?: () => string | undefined;
  /** Show the recovery prompt; resolves TRUE iff the user accepted (default:
   *  `showInformationMessage(msg, action)` and accept === the action button). */
  promptUser?: (message: string, action: string) => Promise<boolean>;
  /** The prompt-frequency floor in ms (default DEFAULT_MIN_PROMPT_INTERVAL_MS). */
  minPromptIntervalMs?: number;
}

/** The activated companion's API — the wired probe + reopen, returned so the
 *  host (and the tests) can drive them. */
export interface CompanionApi {
  /** Probe the client-configured hub for liveness (AC2). */
  probeHub(): Promise<HubProbeResult>;
  /** The running client-side link sensor (#1275): it probes the hub on the
   *  standard cadence and feeds each outcome to the bundled MERGED detector,
   *  emitting the classified posture (ok / degraded / hub-down). It is started
   *  on activation and stopped on dispose. */
  linkSensor: LinkSensor;
  /** Programmatically flip the window Remote-SSH↔local (AC3), direction chosen
   *  from the current window mode. */
  reopen(args?: ReopenArgs): Promise<ReopenOutcome>;
  /** The #1276 auto-DOWN orchestrator wired to the sensor's posture stream: on a
   *  sustained hub-down it drops the window to the local lifeboat — guarded and
   *  surfaced. Exposed so #1277 (prompt-UP) can extend the same seam. */
  autoDown: AutoDownSwitch;
  /** The #1277 prompt-UP orchestrator wired to the SAME posture stream: on a
   *  sustained recovery back to `fleet` it PROMPTS to reopen in Remote-SSH, and
   *  reopens only if the user accepts (never a forced up-switch). */
  promptUp: PromptUpSwitch;
  /** Dispose the registered command. */
  dispose(): void;
}

function readHubUrlSetting(): string | undefined {
  const v = vscode.workspace.getConfiguration().get<string>(COMPANION_HUB_URL_SETTING, "");
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

function readLocalPathSetting(): string | undefined {
  const v = vscode.workspace.getConfiguration().get<string>(COMPANION_LOCAL_PATH_SETTING, "");
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

function readHubSshAliasSetting(): string | undefined {
  const v = vscode.workspace.getConfiguration().get<string>(COMPANION_HUB_SSH_ALIAS_SETTING, "");
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

/** Activate the always-local companion: register the reopen command and return
 *  the wired probe + reopen API. Runs in the CLIENT (ui) extension host. */
export function activate(context: vscode.ExtensionContext, deps: CompanionDeps = {}): CompanionApi {
  const hubUrl = deps.hubUrl ?? readHubUrlSetting;
  const remoteName = deps.remoteName ?? (() => vscode.env.remoteName);

  const probeHub = (): Promise<HubProbeResult> =>
    probeHubHealth(hubUrl(), deps.probeFetch !== undefined ? { fetch: deps.probeFetch } : {});

  const reopen = (args: ReopenArgs = {}): Promise<ReopenOutcome> => {
    // A window with a remote authority is host-side under Remote-SSH → flip it
    // back to local; a local window → flip it to the hub over Remote-SSH.
    const onRemote = typeof remoteName() === "string" && remoteName() !== "";
    const resolution = onRemote
      ? resolveLocalReopenTarget(args.localPath ?? "")
      : resolveRemoteSshReopenTarget(args.alias ?? "", args.remotePath);
    const reopenDeps: Parameters<typeof reopenWindow>[1] = {};
    if (deps.openFolder !== undefined) reopenDeps.openFolder = deps.openFolder;
    if (deps.showError !== undefined) reopenDeps.showError = deps.showError;
    return reopenWindow(resolution, reopenDeps);
  };

  const disposable = vscode.commands.registerCommand(REOPEN_COMMAND, (arg?: ReopenArgs) => reopen(arg));
  context.subscriptions.push(disposable);

  // #1275: the client-side link sensor — probe the hub on the standard cadence
  // and feed each outcome to the BUNDLED merged detector, emitting the
  // classified posture. The companion owns only the probe (it cannot read
  // host-side posture state); the classification is the merged detector's.
  //
  // #1276: the auto-DOWN orchestrator consumes that posture stream. On a
  // SUSTAINED hub-down (the detector's `standalone` hysteresis) it drops the
  // window to the LOCAL lifeboat — gated by the switch-frequency floor + the
  // dirty-editor guard + anti-flap, and SURFACED (never a silent reroute). It is
  // wired independently of deps.onPosture, which stays a pure observer seam.
  const autoDown = new AutoDownSwitch({
    localPath: (deps.localReopenPath ?? readLocalPathSetting)() ?? "",
    now: deps.now ?? (() => Date.now()),
    isEditorDirty: deps.isEditorDirty ?? (() => vscode.workspace.textDocuments.some((d) => d.isDirty)),
    showMessage: deps.showMessage ?? ((m: string) => void vscode.window.showWarningMessage(m)),
    ...(deps.openFolder !== undefined ? { openFolder: deps.openFolder } : {}),
    ...(deps.showError !== undefined ? { showError: deps.showError } : {}),
    ...(deps.minSwitchIntervalMs !== undefined ? { minSwitchIntervalMs: deps.minSwitchIntervalMs } : {}),
  });

  // #1277: the prompt-UP orchestrator consumes the SAME posture stream. On a
  // SUSTAINED recovery back to `fleet` (paired with the hub-down class auto-DOWN
  // dropped on) it PROMPTS to reopen in Remote-SSH, and reopens ONLY if the user
  // accepts — never a forced up-switch (the asymmetry with auto-DOWN by design).
  const promptUp = new PromptUpSwitch({
    sshAlias: (deps.remoteSshAlias ?? readHubSshAliasSetting)() ?? "",
    now: deps.now ?? (() => Date.now()),
    promptUser:
      deps.promptUser ??
      (async (message: string, action: string) =>
        (await vscode.window.showInformationMessage(message, action)) === action),
    showMessage: deps.showMessage ?? ((m: string) => void vscode.window.showWarningMessage(m)),
    ...((deps.remotePath ?? (() => undefined))() !== undefined
      ? { remotePath: (deps.remotePath ?? (() => undefined))() as string }
      : {}),
    ...(deps.openFolder !== undefined ? { openFolder: deps.openFolder } : {}),
    ...(deps.showError !== undefined ? { showError: deps.showError } : {}),
    ...(deps.minPromptIntervalMs !== undefined ? { minPromptIntervalMs: deps.minPromptIntervalMs } : {}),
  });

  const onPosture = (posture: LinkPosture): void => {
    deps.onPosture?.(posture); // observer seam
    autoDown.onPosture(posture); // the auto-DOWN drop (guarded + surfaced)
    promptUp.onPosture(posture); // the prompt-UP offer on recovery (never forced)
  };

  const linkSensor = new LinkSensor({
    probe: probeHub,
    onPosture,
    ...(deps.scheduler !== undefined ? { scheduler: deps.scheduler } : {}),
  });
  linkSensor.start();
  context.subscriptions.push({ dispose: () => linkSensor.stop() });

  return {
    probeHub,
    linkSensor,
    reopen,
    autoDown,
    promptUp,
    dispose: () => {
      linkSensor.stop();
      disposable.dispose();
    },
  };
}

/** Deactivate — nothing to tear down beyond the disposables VS Code owns. */
export function deactivate(): void {
  /* no-op: the registered command is disposed via context.subscriptions */
}
