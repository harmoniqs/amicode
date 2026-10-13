// PEER WORKSPACE ROUTE (#1643 remote-create unblock) — a machine's OWN honest
// description of its workspace, served for a remote-create picker.
//
//   GET /amicode/fleet/peer-workspace
//
// When the composer picks a remote machine, the local app fetches THIS route on
// that machine to learn (a) its home-base default directory — where a remote
// session lands when no project is chosen (the fix for the "Couldn't resolve a
// working directory" no-remote-root refusal), and (b) its projects. Served by
// the OWNING machine (it describes ITSELF), under /amicode/fleet/* so it stays
// local (never proxied — a machine's own truth, ADR 0027 §4).
//
// Extensible: the projects list is the seed for the deferred selector cascade
// (worktrees + branches join later). home_base unblocks the create today.

import type { ProjectDirEntry } from "./project";

export interface PeerWorkspaceDeps {
  /** This machine's home-base default directory (its projects parent). undefined
   *  when unresolvable — the app then blocks the create with no-remote-root. */
  homeBaseDir: () => string | undefined;
  /** This machine's projects (listProjectDirs). */
  listProjects: () => ProjectDirEntry[];
}

export interface RouteResult {
  status?: number;
  body: string;
}

/** GET /amicode/fleet/peer-workspace. Never throws: a read failure degrades to
 *  an empty project list; an unresolvable home-base is omitted (honest). */
export function peerWorkspaceResponse(deps: PeerWorkspaceDeps): RouteResult {
  let home: string | undefined;
  try {
    const h = deps.homeBaseDir();
    home = typeof h === "string" && h.trim() !== "" ? h.trim() : undefined;
  } catch {
    home = undefined;
  }

  let projects: ProjectDirEntry[] = [];
  try {
    projects = deps.listProjects();
  } catch {
    projects = [];
  }

  return {
    status: 200,
    body: JSON.stringify({
      ok: true,
      ...(home !== undefined ? { home_base: home } : {}),
      projects,
    }),
  };
}
