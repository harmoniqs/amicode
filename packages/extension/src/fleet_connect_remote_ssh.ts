// fleet_connect_remote_ssh.ts — Remote-SSH connection for fleet devices.
// Generalised (#1412, ADR 0030 §D8) from the hub-only command (#1271, ADR 0025)
// to accept any fleet device's sshAlias. One resolver, two callers: the hub path
// (`connectToHubOverRemoteSsh`) and the device path (`connectToDeviceOverRemoteSsh`).
//
// ONE TOPOLOGY READER (ADR 0023): the hub path still reads coordinates from the
// projection via `readFleetTopology()` — the SAME path the status bar and the
// hub-restart command read. The device path accepts a raw sshAlias and skips the
// topology entirely.
//
// WORKSPACE-PATH DECISION (documented, unchanged): the remote folder is resolved
// from the `amicode.fleet.hubWorkspacePath` setting when configured, else the
// HOME DEFAULT `~`. Both paths share the same validation (`isLawfulWorkspacePath`).
//
// ERROR MESSAGES are split by audience: the generic resolver emits device-neutral
// messages; the hub adapter (`resolveRemoteSshFromTopology`) overrides the
// `no-ssh-alias` message with hub-specific framing that points to the projection.
// ADR 0025 AC2: every error path is honest and actionable — no crash, no half-window.

import * as vscode from "vscode";
import {
  readFleetTopology,
  FLEET_TOPOLOGY_REFRESH_COMMAND,
  type FleetTopologyState,
  type FleetCanonical,
} from "./fleet_topology";

/** The setting that overrides the remote folder the Remote-SSH window opens. */
export const HUB_WORKSPACE_PATH_SETTING = "amicode.fleet.hubWorkspacePath";

/** The home default when no `hubWorkspacePath` is configured — the hub's home,
 *  where `~/.amico/` (the whole fleet/state root) lives. Relies on Remote-SSH's
 *  server-side `~` expansion; override with the setting for an absolute folder. */
export const DEFAULT_HUB_WORKSPACE_PATH = "~";

/** The Remote-SSH extension id — probed before offering the option. */
const REMOTE_SSH_EXTENSION_ID = "ms-vscode-remote.remote-ssh";

/** Why a Remote-SSH target could not be resolved — each maps to an honest,
 *  actionable message (never a half-window). */
export type RemoteSshUnresolvableReason =
  | "topology-absent" // the projection cache is absent (carries the refresh pointer)
  | "topology-broken" // the projection failed the contract read (carries the rejection)
  | "no-ssh-alias" // no sshAlias configured for the target device
  | "invalid-workspace-path" // a configured hubWorkspacePath is neither absolute nor ~-rooted
  | "read-error" // the topology read itself threw (defensive; readFleetTopology normally never throws)
  | "open-failed" // executeCommand("vscode.openFolder", …) rejected
  | "extension-not-installed"; // the Remote-SSH extension is not installed (#1412)

/** The resolution of device coordinates → a Remote-SSH open target, or a typed
 *  cannot-resolve reason with a rendered actionable message. */
export type RemoteSshResolution =
  | {
      ok: true;
      /** The Remote-SSH authority, `ssh-remote+<alias>`. */
      authority: string;
      /** The resolved remote folder path (`~`, `~/…`, or an absolute path). */
      path: string;
      /** The full `vscode-remote://…` URI for `vscode.openFolder`. */
      uri: string;
    }
  | { ok: false; reason: RemoteSshUnresolvableReason; detail: string };

/** A configured workspace path is lawful when it is absolute (`/`-rooted) or
 *  home-relative (`~` or `~/…`). Anything else (a bare relative path) is a
 *  misconfiguration we refuse rather than open a half-window against. */
function isLawfulWorkspacePath(p: string): boolean {
  return p.startsWith("/") || p === "~" || p.startsWith("~/");
}

// ── Generic resolver (accepts raw sshAlias OR FleetCanonical) ────────────────

/** PURE: sshAlias (+ optional configured workspace path) → the Remote-SSH open
 *  target. Accepts either a raw sshAlias string or a FleetCanonical object for
 *  backward compatibility with the hub path. No vscode, no I/O — unit-testable.
 *
 *  Error messages are device-neutral; the hub adapter overrides them with
 *  hub-specific framing when needed. */
export function resolveRemoteSshTarget(
  aliasOrCanonical: string | FleetCanonical | undefined,
  workspacePath?: string,
): RemoteSshResolution {
  // Extract the alias: from a string directly, or from FleetCanonical.sshAlias
  let rawAlias: string;
  if (typeof aliasOrCanonical === "string") {
    rawAlias = aliasOrCanonical;
  } else {
    rawAlias = typeof aliasOrCanonical?.sshAlias === "string" ? aliasOrCanonical.sshAlias : "";
  }
  const alias = rawAlias.trim();

  if (alias === "") {
    return {
      ok: false,
      reason: "no-ssh-alias",
      detail: `Amicode: No SSH alias configured for this device — there is nothing to connect to over Remote-SSH.`,
    };
  }

  const configured = typeof workspacePath === "string" ? workspacePath.trim() : "";
  let path: string;
  if (configured === "") {
    path = DEFAULT_HUB_WORKSPACE_PATH;
  } else if (isLawfulWorkspacePath(configured)) {
    path = configured;
  } else {
    return {
      ok: false,
      reason: "invalid-workspace-path",
      detail:
        `Amicode: the configured workspace path '${configured}' is not absolute (\`/\`-rooted) or ` +
        `home-relative (\`~\`). Fix \`${HUB_WORKSPACE_PATH_SETTING}\` in Settings, then retry — Amicode will ` +
        `not open a half-configured Remote-SSH window.`,
    };
  }

  const authority = `ssh-remote+${alias}`;
  const uri = `vscode-remote://${authority}/${path.replace(/^\/+/, "")}`;
  return { ok: true, authority, path, uri };
}

// ── Hub-specific adapter ─────────────────────────────────────────────────────

/** The ONE topology reader → a Remote-SSH resolution. Absent/broken states
 *  carry the reader's OWN rendered actionable message VERBATIM (the refresh
 *  pointer / the contract rejection) — this module invents no second message
 *  for them (#1271 AC2). An ok state delegates to the pure resolver, then
 *  overrides the `no-ssh-alias` message with hub-specific framing. */
export function resolveRemoteSshFromTopology(
  state: FleetTopologyState,
  workspacePath?: string,
): RemoteSshResolution {
  if (state.kind === "absent") return { ok: false, reason: "topology-absent", detail: state.detail };
  if (state.kind === "broken") return { ok: false, reason: "topology-broken", detail: state.detail };
  const resolution = resolveRemoteSshTarget(state.canonical, workspacePath);
  // Override the generic no-ssh-alias message with hub-specific framing
  if (!resolution.ok && resolution.reason === "no-ssh-alias") {
    return {
      ok: false,
      reason: "no-ssh-alias",
      detail:
        `Amicode: the fleet projection names no hub SSH alias, so there is nothing to connect to over Remote-SSH. ` +
        `Refresh it with \`${FLEET_TOPOLOGY_REFRESH_COMMAND}\` (or run 'Amicode: Fleet — Repair'), then retry.`,
    };
  }
  return resolution;
}

// ── Extension check ──────────────────────────────────────────────────────────

/** Probe whether the Remote-SSH extension is installed. Synchronous —
 *  `vscode.extensions.getExtension` is a sync API. Callers use this for Quick
 *  Pick precondition gating without attempting a connection. */
export function isRemoteSshAvailable(): boolean {
  return vscode.extensions.getExtension(REMOTE_SSH_EXTENSION_ID) !== undefined;
}

// ── Deps interfaces (shared base + hub-specific extension) ───────────────────

/** Shared deps for any Remote-SSH action (hub or device). */
export interface RemoteSshActionDeps {
  /** The configured workspace path override (default: home `~`). */
  workspacePath?: string;
  /** How to open the folder (injectable; default: `vscode.openFolder` in a new window). */
  openFolder?: (uri: string) => void | Promise<void>;
  /** How to surface the honest error (injectable; default: `showErrorMessage`). */
  showError?: (message: string) => void;
}

/** Hub-specific deps — extends the shared base with the topology reader. */
export interface ConnectRemoteSshDeps extends RemoteSshActionDeps {
  /** The topology read (injectable; default: `readFleetTopology()` — the one reader). */
  readTopology?: () => FleetTopologyState;
}

/** Device-specific deps — extends the shared base with the extension check. */
export interface ConnectDeviceRemoteSshDeps extends RemoteSshActionDeps {
  /** Remote-SSH extension presence check (injectable; default: `isRemoteSshAvailable`). */
  isRemoteSshAvailable?: () => boolean;
}

// ── Command handlers ─────────────────────────────────────────────────────────

async function defaultOpenFolder(uri: string): Promise<void> {
  await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.parse(uri), { forceNewWindow: true });
}

function defaultShowError(message: string): void {
  void vscode.window.showErrorMessage(message);
}

/** Hub command handler: read the projection → resolve → open the Remote-SSH
 *  window (happy path) OR surface the honest actionable message and open
 *  NOTHING (every error path). Returns the resolution so the caller can act
 *  on the typed outcome. Never throws. */
export async function connectToHubOverRemoteSsh(deps: ConnectRemoteSshDeps = {}): Promise<RemoteSshResolution> {
  const readTopology = deps.readTopology ?? (() => readFleetTopology());
  const openFolder = deps.openFolder ?? defaultOpenFolder;
  const showError = deps.showError ?? defaultShowError;

  let state: FleetTopologyState;
  try {
    state = readTopology();
  } catch (e) {
    const detail =
      `Amicode: could not read the fleet projection — ${(e as Error).message}. ` +
      `Refresh it with \`${FLEET_TOPOLOGY_REFRESH_COMMAND}\` and retry.`;
    showError(detail);
    return { ok: false, reason: "read-error", detail };
  }

  const resolution = resolveRemoteSshFromTopology(state, deps.workspacePath);
  if (!resolution.ok) {
    showError(resolution.detail);
    return resolution;
  }

  try {
    await openFolder(resolution.uri);
  } catch (e) {
    const detail = `Amicode: failed to open the Remote-SSH window (${resolution.uri}) — ${(e as Error).message}.`;
    showError(detail);
    return { ok: false, reason: "open-failed", detail };
  }
  return resolution;
}

/** Device command handler (#1412): resolve from a raw sshAlias → open a
 *  Remote-SSH window. Checks the extension is installed before attempting.
 *  Never throws; every failure is an honest, typed resolution + a message. */
export async function connectToDeviceOverRemoteSsh(
  sshAlias: string,
  deps: ConnectDeviceRemoteSshDeps = {},
): Promise<RemoteSshResolution> {
  const openFolder = deps.openFolder ?? defaultOpenFolder;
  const showError = deps.showError ?? defaultShowError;
  const checkExtension = deps.isRemoteSshAvailable ?? isRemoteSshAvailable;

  // Internal extension guard — callers outside the sidebar don't have to check
  if (!checkExtension()) {
    const detail = `Amicode: the Remote-SSH extension is not installed — install \`${REMOTE_SSH_EXTENSION_ID}\` to connect to devices over SSH.`;
    showError(detail);
    return { ok: false, reason: "extension-not-installed", detail };
  }

  const resolution = resolveRemoteSshTarget(sshAlias, deps.workspacePath);
  if (!resolution.ok) {
    showError(resolution.detail);
    return resolution;
  }

  try {
    await openFolder(resolution.uri);
  } catch (e) {
    const detail = `Amicode: failed to open the Remote-SSH window (${resolution.uri}) — ${(e as Error).message}.`;
    showError(detail);
    return { ok: false, reason: "open-failed", detail };
  }
  return resolution;
}
