// amicode#203: project-first dashboard logic — pure helpers for the Projects
// menu and the New-project creation flow. Kept vscode/solid-free so it unit-
// tests headless (the home.tsx consumer wires these to the SDK + dialogs).

/** Slugify a project name into a folder basename: lowercase, whitespace and
 *  underscores to hyphens, drop anything outside [a-z0-9-], collapse repeats,
 *  trim leading/trailing hyphens. */
export function projectNameToSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
}

export type CreationTarget =
  | { ok: true; slug: string; path: string }
  | { ok: false; reason: "empty-name" }

/** Resolve the target directory for a new project from its name + parent.
 *  Collision/permission are RUNTIME outcomes (see classifyCreateError) — this
 *  only rejects a name that slugifies to nothing. */
export function resolveCreationTarget(input: { name: string; parentDir: string }): CreationTarget {
  const slug = projectNameToSlug(input.name)
  if (!slug) return { ok: false, reason: "empty-name" }
  const sep = input.parentDir.endsWith("/") ? "" : "/"
  return { ok: true, slug, path: `${input.parentDir}${sep}${slug}` }
}

export type CreateErrorKind = "collision" | "unwritable" | "other"

/** Map a filesystem error (by errno code, else message) to the inline error the
 *  dialog shows. EEXIST is a name collision; permission/read-only/missing-parent
 *  is an unwritable location; anything else is a generic failure. */
export function classifyCreateError(err: { code?: string; message?: string } | undefined): CreateErrorKind {
  const code = (err?.code ?? "").toUpperCase()
  if (code === "EEXIST") return "collision"
  if (code === "EACCES" || code === "EPERM" || code === "EROFS" || code === "ENOENT" || code === "ENOTDIR")
    return "unwritable"
  const msg = (err?.message ?? "").toLowerCase()
  if (msg.includes("exists")) return "collision"
  if (msg.includes("permission") || msg.includes("read-only") || msg.includes("not a directory")) return "unwritable"
  return "other"
}

/** Best-effort git-init: the project is created regardless; a non-ok result
 *  only means change-tracking is unavailable and the caller shows a notice. */
export function gitInitNeedsNotice(result: { ok: boolean }): boolean {
  return !result.ok
}

export type TrackedProject = { worktree: string; expanded: boolean }
export type AmicodeProjectEntry = { slug: string; path: string }
export type AmicodeProjectsView =
  | { ok: true; parentDir: string; projects: AmicodeProjectEntry[] }
  | { ok: false }

/** Parse the GET /amicode/projects body defensively — an unexpected shape is a
 *  not-ok view the caller treats as "don't reconcile" (never a throw). */
export function parseAmicodeProjects(raw: unknown): AmicodeProjectsView {
  if (typeof raw !== "object" || raw === null) return { ok: false }
  const body = raw as Record<string, unknown>
  if (body.ok !== true || typeof body.parentDir !== "string" || !Array.isArray(body.projects)) return { ok: false }
  const projects: AmicodeProjectEntry[] = []
  for (const p of body.projects) {
    if (typeof p !== "object" || p === null) continue
    const e = p as Record<string, unknown>
    if (typeof e.slug === "string" && typeof e.path === "string") projects.push({ slug: e.slug, path: e.path })
  }
  return { ok: true, parentDir: body.parentDir, projects }
}

/** True when `child` is `parent` itself or nested beneath it (string prefix on
 *  path segments — the worktrees and parent are both server-absolute paths). */
export function isUnder(child: string, parent: string): boolean {
  if (!parent) return false
  const p = parent.endsWith("/") ? parent.slice(0, -1) : parent
  return child === p || child.startsWith(p + "/")
}

/** The server's own working directory to hide from the switcher (and to leave
 *  unlabeled in Recent), or undefined. In standalone/dev the server's cwd — e.g.
 *  the opencode repo — registers as a project; it isn't one of the user's
 *  AmicodeProjects, so hide it once at least one real AmicodeProjects folder
 *  exists (a bare machine keeps the cwd as the new-session fallback). A cwd that
 *  IS itself an AmicodeProjects folder is a legitimate project and is kept —
 *  so a folder the user genuinely named "opencode" under ~/AmicodeProjects still
 *  shows; only the incidental repo cwd is hidden. */
export function hiddenCwdWorktree(input: {
  cwd: string | undefined
  amicodeParent: string | undefined
  amicodeProjectCount: number
}): string | undefined {
  if (!input.cwd || !input.amicodeParent || input.amicodeProjectCount <= 0) return undefined
  return isUnder(input.cwd, input.amicodeParent) ? undefined : input.cwd
}

/** amicode: fold the AmicodeProjects folders on disk into the tracked list so a
 *  project surfaces the moment its folder exists — even if it was never opened.
 *  This is what fixes the "created a folder, it's invisible, yet its name is
 *  'already taken'" desync: the collision check keys off these same folders, so
 *  now anything that can collide is also something the user can see and open.
 *
 *  Purely ADDITIVE by design — it never removes a tracked project. Membership
 *  and switcher-visibility are separate concerns here (see visibleProjects in
 *  home.tsx): sessions that landed in a non-project dir must stay reachable in
 *  "Recent" via the full list, so hiding the extension scaffold / a standalone
 *  cwd from the switcher is a display filter, NOT a store mutation. Existing
 *  order and per-project `expanded` state are preserved; new folders append in
 *  the given (sorted) order. */
export function reconcileProjectList(input: {
  tracked: TrackedProject[]
  amicodeDirs: string[]
}): TrackedProject[] {
  const seen = new Set(input.tracked.map((p) => p.worktree))
  const appended = input.amicodeDirs
    .filter((dir) => !seen.has(dir))
    .map((dir) => ({ worktree: dir, expanded: false }))
  return [...input.tracked, ...appended]
}

/** Whether two tracked lists are identical (worktree + expanded, in order) — the
 *  reconcile effect uses this to avoid a redundant store write (and any churn). */
export function sameProjectList(a: TrackedProject[], b: TrackedProject[]): boolean {
  if (a.length !== b.length) return false
  return a.every((p, i) => p.worktree === b[i]!.worktree && p.expanded === b[i]!.expanded)
}

export type ProjectGroup<P, S> = { project: P; sessions: S[] }
export type OrphanGroup<S> = { directory: string; sessions: S[] }

/** Nest sessions under their project; sessions whose project is unknown become
 *  orphans grouped by directory — NEVER dropped (amicode#203 AC7, replacing the
 *  old drop-on-no-project behavior). Projects keep their input order and appear
 *  even with zero sessions; sessions keep their input order within a group;
 *  orphan groups appear in first-seen order. */
export function groupSessionsByProject<P extends { worktree: string }, S>(input: {
  projects: P[]
  sessions: S[]
  projectOf: (s: S) => P | undefined
  directoryOf: (s: S) => string
}): { projectGroups: ProjectGroup<P, S>[]; orphans: OrphanGroup<S>[] } {
  const byWorktree = new Map<string, ProjectGroup<P, S>>()
  const projectGroups = input.projects.map((project) => {
    const g: ProjectGroup<P, S> = { project, sessions: [] }
    byWorktree.set(project.worktree, g)
    return g
  })
  const orphanMap = new Map<string, OrphanGroup<S>>()
  const orphans: OrphanGroup<S>[] = []
  for (const s of input.sessions) {
    const p = input.projectOf(s)
    const group = p ? byWorktree.get(p.worktree) : undefined
    if (group) {
      group.sessions.push(s)
      continue
    }
    const dir = input.directoryOf(s)
    let og = orphanMap.get(dir)
    if (!og) {
      og = { directory: dir, sessions: [] }
      orphanMap.set(dir, og)
      orphans.push(og)
    }
    og.sessions.push(s)
  }
  return { projectGroups, orphans }
}
