// reopen.ts — the always-local companion's programmatic Remote-SSH↔local window
// reopen (#1274 AC3, ADR 0025 P2). Two PURE URI builders (one per direction) +
// one thin driver that calls `vscode.commands.executeCommand("vscode.openFolder",
// …)`. The window flip itself is a runtime act; what is unit-provable here is the
// URI construction and that the openFolder command fires exactly once.
//
// DUPLICATION (documented judgment call, #1274): the ~10-line pure Remote-SSH
// URI builder is DUPLICATED from the main extension's
// src/fleet_connect_remote_ssh.ts (`resolveRemoteSshTarget`) rather than
// imported. The companion is a SEPARATE `ui`-kind package and must not take a
// (cyclic) dependency on the workspace extension — duplicating ten pure lines is
// the simplest correct choice for a spike (the briefing sanctions it). #1275 may
// extract a shared pure helper if the reopen surface grows; the authority/path/
// uri contract below is deliberately identical so that extraction stays trivial.

import * as vscode from "vscode";

export type ReopenDirection = "to-remote" | "to-local";

export type ReopenResolution =
  | { ok: true; direction: ReopenDirection; uri: string }
  | { ok: false; reason: string; detail: string };

export interface ReopenOutcome {
  ok: boolean;
  uri?: string;
}

/** A configured workspace path is lawful when absolute (`/`-rooted) or
 *  home-relative (`~` / `~/…`) — anything else is a misconfiguration we refuse
 *  rather than open a half-window against (mirrors the main extension). */
function isLawfulWorkspacePath(p: string): boolean {
  return p.startsWith("/") || p === "~" || p.startsWith("~/");
}

/** LOCAL → Remote-SSH: canonical alias (+ optional workspace path) → the
 *  `vscode-remote://ssh-remote+<alias>/<path>` open target. Pure, no vscode I/O. */
export function resolveRemoteSshReopenTarget(alias: string, workspacePath?: string): ReopenResolution {
  const a = typeof alias === "string" ? alias.trim() : "";
  if (a === "") {
    return {
      ok: false,
      reason: "no-ssh-alias",
      detail:
        "Amicode Companion: no hub SSH alias to connect to over Remote-SSH. " +
        "Supply the fleet hub alias (from the projection) and retry.",
    };
  }

  const configured = typeof workspacePath === "string" ? workspacePath.trim() : "";
  let path: string;
  if (configured === "") {
    path = "~"; // the home default — coherent with the fleet state root ~/.amico/
  } else if (isLawfulWorkspacePath(configured)) {
    path = configured;
  } else {
    return {
      ok: false,
      reason: "invalid-workspace-path",
      detail:
        `Amicode Companion: the configured remote workspace path '${configured}' is not absolute ` +
        "(`/`-rooted) or home-relative (`~`). Fix it and retry — the companion will not open a " +
        "half-configured Remote-SSH window.",
    };
  }

  const authority = `ssh-remote+${a}`;
  const uri = `vscode-remote://${authority}/${path.replace(/^\/+/, "")}`;
  return { ok: true, direction: "to-remote", uri };
}

/** Remote-SSH → LOCAL: an absolute local folder path → its `file://` open
 *  target. Pure. A blank or non-absolute path is an honest error, never a
 *  half-window. (The `amico-host://` FileSystemProvider URI from #1267 is an
 *  alternative local target #1276-1278 may select; the spike proves `file://`.) */
export function resolveLocalReopenTarget(localPath: string): ReopenResolution {
  const p = typeof localPath === "string" ? localPath.trim() : "";
  if (p === "" || !p.startsWith("/")) {
    return {
      ok: false,
      reason: "invalid-local-path",
      detail:
        `Amicode Companion: the local reopen path '${localPath}' is not an absolute (\`/\`-rooted) ` +
        "folder. Supply the local workspace folder and retry.",
    };
  }
  return { ok: true, direction: "to-local", uri: `file://${p}` };
}

export interface ReopenDeps {
  /** How to open the folder (injectable; default: `vscode.openFolder`). */
  openFolder?: (uri: string, opts: { forceNewWindow: boolean }) => void | Promise<void>;
  /** How to surface the honest error (injectable; default: `showErrorMessage`). */
  showError?: (message: string) => void;
  /** Whether the reopen forces a NEW window. Default false — the switch
   *  orchestration (#1276-1278) flips the CURRENT window; a spike caller may
   *  force a new one. */
  forceNewWindow?: boolean;
}

async function defaultOpenFolder(uri: string, opts: { forceNewWindow: boolean }): Promise<void> {
  await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.parse(uri), {
    forceNewWindow: opts.forceNewWindow,
  });
}

function defaultShowError(message: string): void {
  void vscode.window.showErrorMessage(message);
}

/** Drive the window reopen from a resolved target: fire `vscode.openFolder`
 *  (happy path) OR surface the honest message and open NOTHING (error path).
 *  Never throws — an open failure becomes a not-ok outcome + a message. */
export async function reopenWindow(resolution: ReopenResolution, deps: ReopenDeps = {}): Promise<ReopenOutcome> {
  const openFolder = deps.openFolder ?? defaultOpenFolder;
  const showError = deps.showError ?? defaultShowError;
  const forceNewWindow = deps.forceNewWindow ?? false;

  if (!resolution.ok) {
    showError(resolution.detail);
    return { ok: false };
  }

  try {
    await openFolder(resolution.uri, { forceNewWindow });
  } catch (e) {
    showError(
      `Amicode Companion: failed to reopen the window (${resolution.uri}) — ${
        e instanceof Error ? e.message : String(e)
      }.`,
    );
    return { ok: false };
  }
  return { ok: true, uri: resolution.uri };
}
