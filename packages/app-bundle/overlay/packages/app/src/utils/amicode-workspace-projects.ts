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
 *  The extension forwards this to the sidebar (collapse others, expand selected).
 *  autoExpand=true (default) for explicit dropdown clicks; false for session
 *  navigation (highlight only, don't toggle folder state). */
export function notifyProjectSelected(worktree: string, autoExpand = true): void {
  window.parent.postMessage({ source: "amicode", kind: "project-selected", path: worktree, autoExpand }, "*")
}
