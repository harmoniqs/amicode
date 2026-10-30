// amicode#663: workspace-projects signal — the chat iframe's project selector
// reads from this reactive store. The extension host pushes the list via
// postMessage on app-ready and on workspace-folder change; the bridge handler
// below adopts it into a SolidJS signal.
import { createSignal } from "solid-js"

export interface WorkspaceProject {
  name: string
  worktree: string
  type: "research" | "dev"
  status?: string
}

const [projects, setProjects] = createSignal<WorkspaceProject[]>([])

/** Adopt a workspace-projects push from the extension host. */
export function adoptWorkspaceProjects(data: WorkspaceProject[]): void {
  setProjects(Array.isArray(data) ? data : [])
}

/** Reactive accessor — returns the current workspace project list. */
export function workspaceProjects(): WorkspaceProject[] {
  return projects()
}

/** Post an add-workspace-project request to the extension host. */
export function requestAddWorkspaceProject(): void {
  window.parent.postMessage({ source: "amicode", kind: "add-workspace-project" }, "*")
}

/** Notify the extension host that the user selected a project in the dropdown.
 *  The extension forwards this to the sidebar with a three-valued mode:
 *  - "reset"  (default) — expand selected, collapse others (project selector)
 *  - "expand" — expand selected if collapsed, leave others alone (session open / tab switch)
 *  - "none"   — highlight only, no folder state changes (orphan fallback, replay)
 */
export type ActiveProjectMode = "none" | "expand" | "reset"

export function notifyProjectSelected(worktree: string, mode: ActiveProjectMode = "reset"): void {
  window.parent.postMessage({ source: "amicode", kind: "project-selected", path: worktree, mode }, "*")
}

/** Ask the extension host to reveal a file in the Amicode sidebar project tree
 *  ("Find in sidebar" in the Preview tab context menu). A dedicated message
 *  kind is required because the generic `command` bridge lane forwards no
 *  arguments, so it cannot carry the file path. Empty paths are ignored. */
export function notifyRevealInSidebar(path: string): void {
  if (!path) return
  window.parent.postMessage({ source: "amicode", kind: "reveal-in-sidebar", path }, "*")
}
