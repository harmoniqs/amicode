// amicode#203: New-project creation — mkdir + best-effort git init behind an
// amicode server route (same fs-mutation idiom as vaults.ts / library.ts). The
// app calls POST /amicode/project with {name, parentDir}; the response is a
// JSON string, never a rejection — failures come back as ok:false bodies so the
// dialog can render an inline, recoverable error.
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

/** The default parent when the client sends none — the webview doesn't know the
 *  user's home dir, so the server owns the default (created on first use). */
export function defaultParentDir(home: string = homedir()): string {
  return path.join(home, "AmicodeProjects")
}

/** Slugify a project name into a folder basename. Mirrors the app-side
 *  projectNameToSlug (home-projects.ts) — kept in sync by tests on both sides. */
export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
}

export type CreateProjectResult =
  | { ok: true; path: string; slug: string; gitInitialized: boolean }
  | { ok: false; error: "empty-name" | "bad-parent" | "collision" | "unwritable" | "other"; message: string }

/** Parse + validate the request body into a concrete target, without touching
 *  the filesystem. Exported for unit tests. */
export function planCreate(rawBody: string): { target: string; slug: string } | Extract<CreateProjectResult, { ok: false }> {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    return { ok: false, error: "other", message: "malformed request body" }
  }
  const body = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>
  const name = typeof body.name === "string" ? body.name : ""
  const parentDir = typeof body.parentDir === "string" ? body.parentDir : ""
  const slug = slugify(name)
  if (!slug) return { ok: false, error: "empty-name", message: "Enter a project name." }
  // No parent → the server default (~/AmicodeProjects); a provided parent must
  // be absolute (never resolve a client-supplied relative path against the
  // server cwd). The sanitized slug can't traverse (it is [a-z0-9-] only).
  const parent = parentDir ? parentDir : defaultParentDir()
  if (!path.isAbsolute(parent))
    return { ok: false, error: "bad-parent", message: "Choose a location for the project." }
  return { target: path.join(parent, slug), slug }
}

/** Map a Node fs error to the inline error kind the dialog shows. */
export function classifyFsError(err: unknown): Extract<CreateProjectResult, { ok: false }>["error"] {
  const code = ((err as { code?: string })?.code ?? "").toUpperCase()
  if (code === "EEXIST") return "collision"
  if (code === "EACCES" || code === "EPERM" || code === "EROFS" || code === "ENOENT" || code === "ENOTDIR")
    return "unwritable"
  return "other"
}

/** Create the project directory and best-effort git-init it. The directory +
 *  its registration is the atomic unit; git init layers on top and never
 *  blocks creation (amicode#203 AC4). Injectable deps for tests. */
export function createProjectAt(
  target: string,
  slug: string,
  deps: {
    exists?: (p: string) => boolean
    mkdir?: (p: string) => void
    gitInit?: (cwd: string) => boolean
  } = {},
): CreateProjectResult {
  const exists = deps.exists ?? existsSync
  const mkdir = deps.mkdir ?? ((p: string) => void mkdirSync(p, { recursive: true }))
  const gitInit =
    deps.gitInit ??
    ((cwd: string) => {
      try {
        return spawnSync("git", ["init"], { cwd, stdio: "ignore" }).status === 0
      } catch {
        return false // git absent from PATH → best-effort, project still created
      }
    })

  if (exists(target)) return { ok: false, error: "collision", message: "A project with this name already exists here." }
  try {
    mkdir(target)
  } catch (err) {
    const kind = classifyFsError(err)
    return { ok: false, error: kind, message: kind === "unwritable" ? "That location can't be written to." : "Could not create the project." }
  }
  let gitInitialized = false
  try {
    gitInitialized = gitInit(target)
  } catch {
    gitInitialized = false
  }
  return { ok: true, path: target, slug, gitInitialized }
}

/** POST /amicode/project handler body → JSON string (never rejects). */
export function createProject(rawBody: string): string {
  const plan = planCreate(rawBody)
  if ("ok" in plan) return JSON.stringify(plan)
  return JSON.stringify(createProjectAt(plan.target, plan.slug))
}

export type ProjectDirEntry = { slug: string; path: string }

/** Enumerate the immediate subdirectories of the projects parent — each folder
 *  IS a project (amicode is folder-first). This is the source of truth for the
 *  Projects list, so a project surfaces the moment its folder exists, even if it
 *  was never opened — closing the "created-but-invisible" desync where the
 *  collision check (existsSync) saw a folder the list never did. Returns [] when
 *  the parent doesn't exist yet (before the first create). Dotfiles and
 *  non-directories are skipped; results are name-sorted. Injectable for tests. */
export function listProjectDirs(
  parentDir: string = defaultParentDir(),
  deps: {
    exists?: (p: string) => boolean
    readEntries?: (p: string) => Array<{ name: string; isDirectory: boolean }>
  } = {},
): ProjectDirEntry[] {
  const exists = deps.exists ?? existsSync
  const readEntries =
    deps.readEntries ??
    ((p: string) => readdirSync(p, { withFileTypes: true }).map((d) => ({ name: d.name, isDirectory: d.isDirectory() })))
  if (!exists(parentDir)) return []
  return readEntries(parentDir)
    .filter((e) => e.isDirectory && !e.name.startsWith("."))
    .map((e) => ({ slug: e.name, path: path.join(parentDir, e.name) }))
    .sort((a, b) => a.slug.localeCompare(b.slug))
}

export type ListProjectsResult = { ok: true; parentDir: string; projects: ProjectDirEntry[] }

/** GET /amicode/projects handler → JSON string (never rejects). A read error
 *  (e.g. permission) degrades to an empty list rather than failing the list. */
export function listProjects(parentDir: string = defaultParentDir()): string {
  const body: ListProjectsResult = { ok: true, parentDir, projects: [] }
  try {
    body.projects = listProjectDirs(parentDir)
  } catch {
    /* unreadable parent → empty list */
  }
  return JSON.stringify(body)
}

// re-export for a create-then-cleanup path if a caller ever needs to roll back
export const _internal = { rmSync }
