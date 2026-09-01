// amicode#663: workspace-projects signal — the chat iframe's project selector
// reads from this reactive store. The extension host pushes the list via
// postMessage on app-ready and on workspace-folder change; the bridge handler
// below adopts it into a SolidJS signal.
//
// Pattern follows amicode-hidden-project.ts — module-scoped signal, no
// component tree dependency, importable from any context.

import { createSignal } from "solid-js"

export interface WorkspaceProject {
  name: string
  worktree: string
  type: "research" | "dev"
  status?: string
}

const [projects, setProjects] = createSignal<WorkspaceProject[]>([])

/** Adopt a workspace-projects push from the extension host. Replaces the
 *  entire list (the extension always sends the full set). */
export function adoptWorkspaceProjects(data: WorkspaceProject[]): void {
  setProjects(Array.isArray(data) ? data : [])
}

/** Reactive accessor — returns the current workspace project list. */
export function workspaceProjects(): WorkspaceProject[] {
  return projects()
}

/** Post an add-workspace-project request to the extension host. The extension
 *  shows a native folder picker, adds the selected folder to the VS Code
 *  workspace, and pushes an updated workspace-projects message back. */
export function requestAddWorkspaceProject(): void {
  window.parent.postMessage(
    { source: "amicode", kind: "add-workspace-project" },
    "*",
  )
}
