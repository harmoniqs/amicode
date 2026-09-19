// fleet_connect_remote_ssh.ts — "Amicode: Connect to Hub over Remote-SSH"
// (#1271, ADR 0025, part of #1268). The opt-in ENTRY into the Remote-SSH
// posture: resolve the hub's coordinates from the projection and open a
// Remote-SSH window onto the hub workspace.
//
// ONE TOPOLOGY READER (ADR 0023): the coordinates come from the projection via
// `readFleetTopology()` — the SAME path the status bar and the hub-restart
// command read. There is NO hand-built host string and NO second config
// source; the sshAlias is taken from `canonical.sshAlias` exactly as
// `hub_ops.resolveHubTarget` does. Absent / broken / alias-less projections are
// honest, actionable RENDERED states here — never a crash, never a
// half-opened window (#1271 AC2).
//
// WORKSPACE-PATH DECISION (documented): the projection's `canonical` carries
// `{host, port, sshAlias}` only — it has NO remote workspace path (confirmed at
// both the extension `FleetCanonical` and the schema `BaseTopologyCanonical`).
// So the remote folder to open is resolved as:
//   1. the `amicode.fleet.hubWorkspacePath` setting when the operator has set
//      one (an absolute `/`-rooted path, or a home-relative `~`/`~/…` path); else
//   2. the HOME DEFAULT `~` — coherent with the whole fleet architecture, whose
//      state root is `~/.amico/` (projection, ops, runs all live under home).
// The `~` default relies on Remote-SSH's server-side home expansion for
// `openFolder`; a site that wants a guaranteed absolute folder sets the
// setting. A CONFIGURED-but-misconfigured path (relative, e.g. `foo/bar`) is an
// honest AC2 error — Amicode refuses to open a half-configured window rather
// than guess. (#1274 will drive this same Remote-SSH↔local reopen
// programmatically; it consumes the typed RemoteSshResolution below — the
// `authority`, `path`, and `uri` fields are the stable contract for that.)

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

/** Why a Remote-SSH target could not be resolved — each maps to an honest,
 *  actionable message (never a half-window). */
export type RemoteSshUnresolvableReason =
  | "topology-absent" // the projection cache is absent (carries the refresh pointer)
  | "topology-broken" // the projection failed the contract read (carries the rejection)
  | "no-ssh-alias" // the projection names no hub sshAlias (nothing to connect to)
  | "invalid-workspace-path" // a configured hubWorkspacePath is neither absolute nor ~-rooted
  | "read-error" // the topology read itself threw (defensive; readFleetTopology normally never throws)
  | "open-failed"; // executeCommand("vscode.openFolder", …) rejected

/** The resolution of hub coordinates → a Remote-SSH open target, or a typed
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

/** PURE: canonical coordinates (+ optional configured workspace path) → the
 *  Remote-SSH open target. No vscode, no I/O — the unit-testable core.
 *  The alias is trimmed exactly as `hub_ops.resolveHubTarget` trims it. */
export function resolveRemoteSshTarget(
  canonical: FleetCanonical | undefined,
  workspacePath?: string,
): RemoteSshResolution {
  const alias = typeof canonical?.sshAlias === "string" ? canonical.sshAlias.trim() : "";
  if (alias === "") {
    return {
      ok: false,
      reason: "no-ssh-alias",
      detail:
        `Amicode: the fleet projection names no hub SSH alias, so there is nothing to connect to over Remote-SSH. ` +
        `Refresh it with \`${FLEET_TOPOLOGY_REFRESH_COMMAND}\` (or run 'Amicode: Fleet — Repair'), then retry.`,
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
        `Amicode: the configured hub workspace path '${configured}' is not absolute (\`/\`-rooted) or ` +
        `home-relative (\`~\`). Fix \`${HUB_WORKSPACE_PATH_SETTING}\` in Settings, then retry — Amicode will ` +
        `not open a half-configured Remote-SSH window.`,
    };
  }

  const authority = `ssh-remote+${alias}`;
  const uri = `vscode-remote://${authority}/${path.replace(/^\/+/, "")}`;
  return { ok: true, authority, path, uri };
}

/** The ONE topology reader → a Remote-SSH resolution. Absent/broken states
 *  carry the reader's OWN rendered actionable message VERBATIM (the refresh
 *  pointer / the contract rejection) — this module invents no second message
 *  for them (#1271 AC2). An ok state delegates to the pure resolver. */
export function resolveRemoteSshFromTopology(
  state: FleetTopologyState,
  workspacePath?: string,
): RemoteSshResolution {
  if (state.kind === "absent") return { ok: false, reason: "topology-absent", detail: state.detail };
  if (state.kind === "broken") return { ok: false, reason: "topology-broken", detail: state.detail };
  return resolveRemoteSshTarget(state.canonical, workspacePath);
}

export interface ConnectRemoteSshDeps {
  /** The topology read (injectable; default: `readFleetTopology()` — the one reader). */
  readTopology?: () => FleetTopologyState;
  /** The configured hub workspace path override (default: home `~`). */
  workspacePath?: string;
  /** How to open the folder (injectable; default: `vscode.openFolder` in a new window). */
  openFolder?: (uri: string) => void | Promise<void>;
  /** How to surface the honest error (injectable; default: `showErrorMessage`). */
  showError?: (message: string) => void;
}

async function defaultOpenFolder(uri: string): Promise<void> {
  await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.parse(uri), { forceNewWindow: true });
}

function defaultShowError(message: string): void {
  void vscode.window.showErrorMessage(message);
}

/** The thin command handler: read the projection → resolve → open the
 *  Remote-SSH window (happy path) OR surface the honest actionable message and
 *  open NOTHING (every error path). Returns the resolution so the caller (and
 *  #1274's programmatic driver) can act on the typed outcome. Never throws:
 *  a reader or open failure becomes an honest not-ok resolution + a message. */
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
