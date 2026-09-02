// AMICODE: data source for the Vaults panel tab (GET /amicode/vaults).
// Relays `amico-vault status --json` (harmoniqs/amicissimo) verbatim; every
// failure mode is synthesized into the SAME plural shape so the web app
// parses exactly one schema. Contract: status() never rejects.
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { run, which } from "./run"
import { browseAllowed, mountBrowseRefusal, mountDir } from "./vault_browser"

const TIMEOUT_MS = 8_000
const CACHE_MS = 10_000
const CLONE_TIMEOUT_MS = 120_000

export function synthesize(code: string, detail: string): string {
  return JSON.stringify({ ok: false, mounts: [], error: `${code}: ${detail}` })
}

const KIND_RANK: Record<string, number> = { personal: 0, engagement: 1, project: 2, restricted: 3, team: 4, public: 5 }
const kindRank = (k: string) => KIND_RANK[k] ?? 6
const writableByKind = (k: string) => k === "personal" || k === "project" || k === "engagement"

export type MountInfo = { id: string; kind: string; writable: boolean; dir: string }

/** Structured mount listing (precedence-ordered: kind-rank then name) for
 *  in-process consumers — the chat file-ref resolver walks this for
 *  first-hit resolution. `dir` is the mount's on-disk directory. */
export function listMounts(root: string = vaultsRoot()): MountInfo[] {
  let entries: string[]
  try {
    entries = readdirSync(root).sort()
  } catch {
    return []
  }
  const mounts: MountInfo[] = []
  for (const base of entries) {
    let text: string
    try {
      text = readFileSync(path.join(root, base, ".amico-vault.toml"), "utf8")
    } catch {
      continue
    }
    const kind = text.match(/^\s*kind\s*=\s*"([^"]*)"/m)?.[1] ?? ""
    if (!kind) continue
    const name = text.match(/^\s*name\s*=\s*"([^"]*)"/m)?.[1] || base
    mounts.push({ id: name, kind, writable: writableByKind(kind), dir: path.join(root, base) })
  }
  mounts.sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return mounts
}

/** CLI-less mount listing: scan each vault dir under the vaults root for its
 *  `.amico-vault.toml` marker and emit the same `{ok,mounts}` wire shape the
 *  Vaults tab parses. Parity with the extension's resolveMountStack (kind rank +
 *  writable-by-kind); ordering is kind-rank then name. `last_sync` is unknown
 *  without the CLI. Never throws. */
export function scanMounts(root: string = vaultsRoot()): string {
  const mounts = listMounts(root).map(({ id, kind, writable }) => ({ id, kind, writable, last_sync: "unknown" }))
  return JSON.stringify({ ok: true, mounts, error: null })
}

export function candidates(env: Record<string, string | undefined>, home: string): string[] {
  const out: string[] = []
  if (env.AMICO_VAULT_BIN) out.push(env.AMICO_VAULT_BIN)
  if (env.AMICO_OPS) out.push(path.join(env.AMICO_OPS, "scripts", "amico-vault"))
  out.push(path.join(home, ".amico", "ops", "scripts", "amico-vault"))
  return out
}

function resolveCli(): string | undefined {
  for (const candidate of candidates(process.env, homedir())) {
    if (existsSync(candidate)) return candidate
  }
  return which("amico-vault")
}

let cache: { at: number; body: string } | undefined

/** Stamp each mount with `browsable`, computed by the vault-browser's
 *  fail-closed law (deployment gate + per-mount kind/marker rules), so the
 *  app can mark proprietary context locked UPFRONT — e.g. grey out context
 *  tree nodes — instead of discovering the refusal on click. Additive to the
 *  relayed wire shape; an unparseable body passes through untouched. */
export function annotateBrowsable(
  body: string,
  root: string = vaultsRoot(),
  env: Record<string, string | undefined> = process.env,
): string {
  try {
    const parsed = JSON.parse(body) as { mounts?: { id?: unknown; browsable?: boolean; dirName?: string }[] }
    if (!Array.isArray(parsed.mounts)) return body
    const allowed = browseAllowed(env)
    for (const m of parsed.mounts) {
      if (typeof m?.id !== "string") continue
      const dir = allowed ? mountDir(m.id, root) : undefined
      m.browsable = !!dir && !mountBrowseRefusal(m.id, dir, env)
      // amicode#447: the directory identity each mount's FILE paths carry (the
      // basename, not the absolute — the path is the researcher's own). The
      // app reconciles a path-derived vault ref (the directory segment)
      // against the mount list through it; without it a dir≠name mount's
      // notes resolve to no known mount and lock or 404.
      m.dirName = dir ? path.basename(dir) : undefined
    }
    return JSON.stringify(parsed)
  } catch {
    return body
  }
}

export async function status(): Promise<string> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.body
  const body = annotateBrowsable(await statusUncached().catch((err) => synthesize("bad_output", String(err))))
  cache = { at: Date.now(), body }
  return body
}

async function statusUncached(): Promise<string> {
  const cli = resolveCli()
  // No amico-vault CLI (a fresh / marketplace user without the amico-ops
  // install) — don't show a scary error; list mounts straight off disk so the
  // Vaults tab still reflects the personal vault + anything attached here.
  if (!cli) return scanMounts()
  const started = Date.now()
  // abort is the actual deadline; `timeout` is only the SIGTERM→SIGKILL grace
  // period inside the wrapper's abort handler (it does NOT arm a deadline by
  // itself — see util/process.ts:74-107).
  const result = await run([cli, "status", "--json"], {
    abort: AbortSignal.timeout(TIMEOUT_MS),
    timeout: 2_000,
    nothrow: true,
  })
  if (result.code !== 0) {
    if (Date.now() - started >= TIMEOUT_MS)
      return synthesize("timeout", `amico-vault status did not finish within ${TIMEOUT_MS / 1000}s`)
    const detail = result.stderr.toString().trim() || "amico-vault exited non-zero"
    return synthesize(`exit_${result.code}`, detail.slice(0, 300))
  }
  const text = result.stdout.toString().trim()
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an object")
  } catch {
    return synthesize("bad_output", "amico-vault produced unparseable JSON")
  }
  return text
}

// ── Attach an existing vault (POST /amicode/vaults) ────────────────────────
// Clones a repo (primary) or symlinks a local vault dir (secondary) into the
// vaults root, so resolveMountStack discovers it like any other mount. Its
// success does NOT depend on the amico-vault CLI (a fresh user may not have it)
// — it returns its own {ok,name,…} shape, distinct from status()'s mounts shape.

function vaultsRoot(): string {
  return process.env.AMICO_VAULTS_ROOT || path.join(homedir(), ".amico", "vaults")
}

/** Fold a proposed name into a safe mount dir name (lowercase kebab) — parity
 *  with the extension's sanitizeVaultName (substrate/vault_setup.ts). */
export function sanitizeVaultName(raw: string): string {
  const s = (raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
  return s || "vault"
}

export type VaultRef = { kind: "repo"; url: string; name: string } | { kind: "path"; path: string; name: string }

/** Resolve a user reference to a clone URL or local path + destination name:
 *   - absolute / ~ / ./ path   → local attach (symlink)
 *   - git URL (git@… | …://)   → clone
 *   - owner/repo               → clone git@github.com:owner/repo.git
 *   - bare name                → clone git@github.com:harmoniqs/<name>.git */
export function normalizeRef(raw: string): VaultRef | undefined {
  const ref = (raw ?? "").trim()
  if (!ref) return undefined
  const repoName = (r: string) => sanitizeVaultName(path.basename(r).replace(/\.git$/, ""))
  if (ref.startsWith("/") || ref.startsWith("~") || ref.startsWith("./") || ref.startsWith("../")) {
    const abs = ref.startsWith("~") ? path.join(homedir(), ref.slice(1)) : path.resolve(ref)
    return { kind: "path", path: abs, name: sanitizeVaultName(path.basename(abs)) }
  }
  if (ref.includes("://") || ref.startsWith("git@")) return { kind: "repo", url: ref, name: repoName(ref) }
  if (/^[\w.-]+\/[\w.-]+$/.test(ref))
    return { kind: "repo", url: `git@github.com:${ref.replace(/\.git$/, "")}.git`, name: repoName(ref) }
  if (/^[\w.-]+$/.test(ref)) return { kind: "repo", url: `git@github.com:harmoniqs/${ref}.git`, name: sanitizeVaultName(ref) }
  return undefined
}

const attachErr = (code: string, detail: string) => JSON.stringify({ ok: false, error: `${code}: ${detail}` })

/** Attach an existing vault. JSON body `{ ref }`. Returns `{ok:true,name,kind}`
 *  on success (mount discovered on next session), else `{ok:false,error}`. */
export async function attachVault(rawBody: string, root: string = vaultsRoot()): Promise<string> {
  let parsed: { ref?: unknown }
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    return attachErr("bad_request", "body must be JSON {ref}")
  }
  if (typeof parsed.ref !== "string" || parsed.ref.trim() === "") return attachErr("bad_request", "ref is required")
  const spec = normalizeRef(parsed.ref)
  if (!spec) return attachErr("bad_request", `unrecognized vault reference: ${parsed.ref}`)
  const dest = path.join(root, spec.name)
  if (existsSync(dest)) return attachErr("exists", `a vault named "${spec.name}" is already attached`)
  let kind = "personal"
  try {
    mkdirSync(root, { recursive: true })
    if (spec.kind === "path") {
      const marker = path.join(spec.path, ".amico-vault.toml")
      if (!existsSync(marker)) return attachErr("not_a_vault", "that path has no .amico-vault.toml marker")
      symlinkSync(spec.path, dest)
    } else {
      const res = await run(["git", "clone", spec.url, dest], {
        abort: AbortSignal.timeout(CLONE_TIMEOUT_MS),
        nothrow: true,
      })
      if (res.code !== 0) return attachErr("clone_failed", (res.stderr.toString().trim() || "git clone failed").slice(0, 300))
      // An attached vault normally carries its own marker; stamp a personal
      // fallback only if it doesn't, so discovery never skips it for a missing kind.
      const marker = path.join(dest, ".amico-vault.toml")
      if (!existsSync(marker)) writeFileSync(marker, `kind = "personal"\nname = "${spec.name}"\n`)
    }
  } catch (err) {
    return attachErr("attach_failed", String(err))
  }
  cache = undefined // bust the status() cache so the Vaults tab reflects the new mount
  return JSON.stringify({ ok: true, name: spec.name, kind, path: dest })
}
