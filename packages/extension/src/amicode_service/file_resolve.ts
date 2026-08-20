// AMICODE: chat file-reference resolver (GET /amicode/resolve-file?path=<text>).
// Resolves a path-like string from chat markdown (an inline-code pill, or a
// relative authored link) to an absolute on-disk path, so the app can wrap it
// in a file:// link and the VS Code bridge can open it. RESOLVES ONLY — never
// reads content. Contract (same as vault-browser.ts): the body builder returns
// a JSON string and never throws.
//
// Resolution tiers, in order:
//   1. absolute path (/…)                → existsSync
//   2. ~ / ~/…                           → home expansion, then existsSync
//   3. mount-prefixed (<mount>/<rel>)    → under that mount (containment-guarded)
//   4. relative with a directory part    → first-hit relpath across mounts in
//      precedence order, then <mount>/amicode/<rel> (problem & demo cards),
//      then project-directory-relative (the server's cwd)
//   5. bare filename                     → typed-prefix vault search ONLY
//      (insight-* → insights/, spec-* → specs/, … per the amico-vault folder
//      contract). A bare name with no typed prefix never resolves — a random
//      `result.toml` must not become a link into the vault.
import { realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { browseAllowed, mountDir } from "./vault_browser"
import { listMounts } from "./vaults"

const MAX_LEN = 4_096

function vaultsRoot(): string {
  return process.env.AMICO_VAULTS_ROOT || path.join(homedir(), ".amico", "vaults")
}

const err = (code: string, detail: string) => JSON.stringify({ ok: false, error: `${code}: ${detail}` })

/** Vault naming contract (amico-vault skill, folder table): a timestamped
 *  note's filename prefix maps to its typed folder. Order irrelevant except
 *  that `morning-brief-` must precede nothing — prefixes are disjoint. */
const TYPED_PREFIX_DIRS: ReadonlyArray<readonly [prefix: string, dir: string]> = [
  ["experiment-", "experiments"],
  ["method-", "methods"],
  ["paper-", "papers"],
  ["insight-", "insights"],
  ["spec-", "specs"],
  ["plan-", "plans"],
  ["meeting-", "meetings"],
  ["hypothesis-", "hypotheses"],
  ["hopper-", "hopper"],
  ["retro-", "retrospectives"],
  ["morning-brief-", "briefs"],
  ["person-", "people"],
  ["org-", "orgs"],
  ["session-", "sessions"],
]

export type ResolvedRef = { path: string; mount?: string; kind: "file" | "dir" }

/** stat an absolute candidate; undefined when absent or not file/dir. */
function statRef(abs: string, mount?: string): ResolvedRef | undefined {
  let st
  try {
    st = statSync(abs)
  } catch {
    return undefined
  }
  if (st.isDirectory()) return { path: abs, mount, kind: "dir" }
  if (st.isFile()) return { path: abs, mount, kind: "file" }
  return undefined
}

/** Join + realpath containment guard (mounts may be symlinked, and a chat
 *  string may carry `..`): returns the REAL path when the candidate exists and
 *  stays inside the mount, else undefined. Same idiom as vaultFileBody. */
function containedExisting(mountDirAbs: string, rel: string): string | undefined {
  let realRoot: string
  let realTarget: string
  try {
    realRoot = realpathSync(mountDirAbs)
    realTarget = realpathSync(path.resolve(mountDirAbs, rel))
  } catch {
    return undefined
  }
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) return undefined
  return realTarget
}

/** The project directory the server was launched with (extension spawns
 *  `opencode serve` with cwd = the project). */
function projectDir(): string {
  return process.env.AMICODE_PROJECT_DIR || process.cwd()
}

export function resolveFileRef(
  text: string,
  opts: { vaultRoot?: string; cwd?: string; home?: string } = {},
): ResolvedRef | undefined {
  const home = opts.home ?? homedir()
  const vaultRoot = opts.vaultRoot ?? vaultsRoot()
  const cwd = opts.cwd ?? projectDir()
  const t = text.trim()
  if (!t || t.length > MAX_LEN) return undefined
  // scheme-ful strings (https://, mailto:, …) are not file refs
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) || /^mailto:/i.test(t)) return undefined

  const expanded = t === "~" ? home : t.startsWith("~/") ? path.join(home, t.slice(2)) : t

  // tiers 1–2: absolute / home-expanded
  if (path.isAbsolute(expanded)) return statRef(expanded)

  // normalize away a leading ./ so segment logic sees the real first segment
  const rel = expanded.startsWith("./") ? expanded.slice(2) : expanded
  if (!rel || rel === "." || rel === "..") return undefined
  const segs = rel.split("/").filter((s) => s !== "")
  if (segs.length === 0) return undefined

  // tier 3: first segment names an attached mount
  const mounted = mountDir(segs[0], vaultRoot)
  if (mounted) {
    if (segs.length === 1) return statRef(mounted, segs[0])
    const inside = containedExisting(mounted, segs.slice(1).join("/"))
    if (inside) return statRef(inside, segs[0])
    return undefined // an explicit mount reference does not fall through
  }

  // tier 4: relative with a directory part — vault precedence first-hit, then
  // the mount's amicode/ state dir (problem cards, demo cards), then the
  // project directory.
  if (segs.length > 1) {
    for (const m of listMounts(vaultRoot)) {
      const hit = containedExisting(m.dir, rel)
      if (hit) return statRef(hit, m.id)
    }
    for (const m of listMounts(vaultRoot)) {
      const hit = containedExisting(m.dir, path.join("amicode", rel))
      if (hit) return statRef(hit, m.id)
    }
    return statRef(path.resolve(cwd, rel))
  }

  // tier 5: bare filename — typed-prefix vault search only
  for (const [prefix, dir] of TYPED_PREFIX_DIRS) {
    if (!rel.startsWith(prefix)) continue
    for (const m of listMounts(vaultRoot)) {
      const hit = containedExisting(m.dir, path.join(dir, rel))
      if (hit) return statRef(hit, m.id)
    }
    return undefined // one prefix matched; never try other prefixes or dirs
  }
  return undefined
}

/** Route body builder: `{ok:true, found, path?, mount?, kind?}` on success,
 *  `{ok:false, error}` on bad input or a gated deployment. Never throws. */
export function resolveFileBody(text: string | undefined): string {
  if (!browseAllowed())
    return err("forbidden", "file resolution serves loopback servers only (set AMICO_VAULT_BROWSER=1 to override)")
  if (!text) return err("bad_request", "path is required")
  let hit: ResolvedRef | undefined
  try {
    hit = resolveFileRef(text)
  } catch (e) {
    return err("resolve_failed", String(e))
  }
  if (!hit) return JSON.stringify({ ok: true, found: false })
  return JSON.stringify({ ok: true, found: true, path: hit.path, mount: hit.mount ?? null, kind: hit.kind })
}
