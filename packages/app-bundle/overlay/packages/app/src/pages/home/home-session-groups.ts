// D1 client-side (spec spec-20260905-045114-session-device-lifecycle, revised
// placement), issue #817: every session home is first-class WITHOUT server
// project rows, boot-time backfill, or a junk lint. Project grouping resolves
// CLIENT-side over directory/projectID — data the global session list already
// returns — so a non-git home (the founding incident's ~/armonia, 687
// sessions API-visible but panel-invisible) renders as its own group. When a
// non-git home later becomes a git repo, the git-derived project supersedes
// the synthesized group by construction: opened projects resolve first.
//
// Pure and dependency-free (type imports only) so it unit-tests headless.
import type { Session } from "@opencode-ai/sdk/v2/client"
import type { LocalProject } from "@/context/layout"
import { pathKey } from "../../utils/path-key"

export type HomeSessionRecord = {
  session: Session
  project: LocalProject
  projectName: string
}

const baseName = (worktree: string) => {
  const key = pathKey(worktree).replace(/\/+$/, "")
  const idx = key.lastIndexOf("/")
  return idx === -1 || key === "/" ? key || worktree : key.slice(idx + 1)
}

/** Resolve a session's directory to a first-class project group. Resolution
 *  keys on the WORKTREE PATH (the D1 identity): an opened project whose
 *  worktree (or sandbox) matches the session's path wins; a projectID match
 *  alone never steals a session from its path. A directory with no opened
 *  project — a non-git home — becomes its OWN group, keyed on the path, with
 *  no server row and no backfill. */
export function resolveSessionProject(
  session: Pick<Session, "directory" | "projectID">,
  projects: LocalProject[],
): { project: LocalProject; projectName: string } {
  const directory = pathKey(session.directory)
  const matched = projects.find(
    (project) =>
      pathKey(project.worktree) === directory ||
      project.sandboxes?.some((sandbox) => pathKey(sandbox) === directory),
  )
  const project =
    matched ??
    // The synthesized first-class home: worktree = the session's directory.
    ({ worktree: session.directory, expanded: true }) as LocalProject
  return { project, projectName: project.name || baseName(project.worktree) || project.worktree }
}

export function buildHomeSessionRecords(input: {
  sessions: readonly Session[]
  /** Directories in scope (the selected project's, or all opened projects'). */
  projectDirectories: readonly string[]
  projects: readonly LocalProject[]
  /** True for the all-projects home scope: no directory is dropped — every
   *  home renders, first-class (D1). False keeps the per-project scoping. */
  scopeAll: boolean
}): HomeSessionRecord[] {
  const directories = new Set(input.projectDirectories.map(pathKey))
  const sessions = input.scopeAll
    ? [...input.sessions]
    : input.sessions.filter((session) => directories.has(pathKey(session.directory)))
  return [...new Map(sessions.map((session) => [session.id, session] as const)).values()]
    .sort(compareSessionTime)
    .map((session) => {
      const { project, projectName } = resolveSessionProject(session, input.projects)
      return { session, project, projectName }
    })
}

function compareSessionTime(a: Session, b: Session) {
  const updated = (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created)
  if (updated !== 0) return updated
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}
