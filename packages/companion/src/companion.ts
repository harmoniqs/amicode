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

/** The one command the companion contributes (see package.json contributes). */
export const REOPEN_COMMAND = "amicode.companion.reopenWindow";

/** The client-side setting the companion probes — it reads ONLY this, never a
 *  host-side instance or posture file (that independence is the whole point). */
export const COMPANION_HUB_URL_SETTING = "amicode.companion.hubUrl";

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
}

/** The activated companion's API — the wired probe + reopen, returned so the
 *  host (and the tests) can drive them. */
export interface CompanionApi {
  /** Probe the client-configured hub for liveness (AC2). */
  probeHub(): Promise<HubProbeResult>;
  /** Programmatically flip the window Remote-SSH↔local (AC3), direction chosen
   *  from the current window mode. */
  reopen(args?: ReopenArgs): Promise<ReopenOutcome>;
  /** Dispose the registered command. */
  dispose(): void;
}

function readHubUrlSetting(): string | undefined {
  const v = vscode.workspace.getConfiguration().get<string>(COMPANION_HUB_URL_SETTING, "");
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

  return {
    probeHub,
    reopen,
    dispose: () => disposable.dispose(),
  };
}

/** Deactivate — nothing to tear down beyond the disposables VS Code owns. */
export function deactivate(): void {
  /* no-op: the registered command is disposed via context.subscriptions */
}
