// AMICODE: the CredentialStore — the ONE seam through which connection
// credentials reach disk (ADR 0001, amicode#159/#162). Per-connection-type
// backends declare their file (env override → ~/.amico default, the
// problems.ts idiom — here the override vars are the SAME ones the amicode
// CLI honors, so the test seam and the CLI-compatibility seam are one
// mechanism) and their schema. Byte shapes are golden-fixture locked
// (test/server/fixtures/credentials): cloud.json must stay parseable by the
// amicode CLI's remote-config reader (amico-run/src/remote_config.ts)
// unchanged. SECURITY: no credential value ever appears in an error message
// or log line — errors carry structure, never bytes.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { homedir } from "node:os"
import path from "node:path"

export type BuiltInConnectionType = "company-compute" | "pasqal-cloud" | "slack" | "github" | "linear" | "google" | "google-drive"
export type ConnectionType = BuiltInConnectionType | (string & {})

/** FROZEN byte shape — every existing CLI consumer parses this unchanged. */
export interface CompanyComputeCredential {
  base_url: string
  token: string
}
/** Token-only at rest: project id + real token (+ optional expiry metadata).
 *  A password NEVER has a field to land in — see the poison guard below. */
export interface PasqalCredential {
  project_id: string
  token: string
  expires_at?: string
}
export interface TokenCredential {
  token: string
}
export type Credential = CompanyComputeCredential | PasqalCredential | TokenCredential

/** $AMICO_CLOUD_FILE overrides the path — the same override the amicode CLI's
 *  remote-config reader honors (remote_config.ts cloudConfigFile). */
export function cloudFile(): string {
  const env = process.env.AMICO_CLOUD_FILE
  if (env && env.trim() !== "") return env
  return path.join(homedir(), ".amico", "cloud.json")
}
/** $AMICO_PASQAL_FILE override; default lives beside cloud.json. */
export function pasqalFile(): string {
  const env = process.env.AMICO_PASQAL_FILE
  if (env && env.trim() !== "") return env
  return path.join(homedir(), ".amico", "pasqal.json")
}
export function slackFile(): string {
  const env = process.env.AMICO_SLACK_FILE
  if (env && env.trim() !== "") return env
  return path.join(homedir(), ".amico", "slack.json")
}
export function githubFile(): string {
  const env = process.env.AMICO_GITHUB_FILE
  if (env && env.trim() !== "") return env
  return path.join(homedir(), ".amico", "github.json")
}
export function linearFile(): string {
  const env = process.env.AMICO_LINEAR_FILE
  if (env && env.trim() !== "") return env
  return path.join(homedir(), ".amico", "linear.json")
}
export function googleFile(): string {
  const env = process.env.AMICO_GOOGLE_FILE
  if (env && env.trim() !== "") return env
  return path.join(homedir(), ".amico", "google.json")
}
export function googleDriveFile(): string {
  const env = process.env.AMICO_GOOGLE_DRIVE_FILE
  if (env && env.trim() !== "") return env
  return path.join(homedir(), ".amico", "google-drive.json")
}

// --- poison guard: writing any object carrying a password-like key through
// this seam must be impossible. The encoders below are allowlist-only (they
// build a fresh object from the declared schema keys), so a stray key can
// never serialize; this guard additionally makes the attempt LOUD instead of
// silently trimmed. The message never echoes the key or its value.
const POISON_KEY = /pass|pwd|user|login|secret/i
function rejectPoisonKeys(value: Record<string, unknown>): void {
  for (const key of Object.keys(value)) {
    if (POISON_KEY.test(key)) throw new Error("credential rejected: password-like keys are never persisted")
  }
}

interface Backend {
  file(): string
  /** allowlist-encode to the frozen byte shape; throws on schema violations */
  encode(value: Record<string, unknown>): string
  /** tolerant decode: anything off-schema is absent, never a throw */
  decode(raw: unknown): Credential | undefined
}

const BACKENDS: Record<string, Backend> = {
  "company-compute": {
    file: cloudFile,
    encode(value) {
      rejectPoisonKeys(value)
      const base = typeof value.base_url === "string" ? value.base_url.trim().replace(/\/+$/, "") : ""
      const token = typeof value.token === "string" ? value.token.trim() : ""
      if (base === "" || token === "")
        throw new Error('company-compute credential needs non-empty "base_url" and "token"')
      return JSON.stringify({ base_url: base, token }, null, 2) + "\n"
    },
    decode(raw) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined
      const d = raw as Record<string, unknown>
      if (typeof d.base_url !== "string" || d.base_url === "") return undefined
      if (typeof d.token !== "string" || d.token === "") return undefined
      return { base_url: d.base_url.replace(/\/+$/, ""), token: d.token }
    },
  },
  "pasqal-cloud": {
    file: pasqalFile,
    encode(value) {
      rejectPoisonKeys(value)
      const project = typeof value.project_id === "string" ? value.project_id.trim() : ""
      const token = typeof value.token === "string" ? value.token.trim() : ""
      if (project === "" || token === "")
        throw new Error('pasqal-cloud credential needs non-empty "project_id" and "token"')
      const out: PasqalCredential = { project_id: project, token }
      if (typeof value.expires_at === "string" && value.expires_at.trim() !== "")
        out.expires_at = value.expires_at.trim()
      return JSON.stringify(out, null, 2) + "\n"
    },
    decode(raw) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined
      const d = raw as Record<string, unknown>
      if (typeof d.project_id !== "string" || d.project_id === "") return undefined
      if (typeof d.token !== "string" || d.token === "") return undefined
      const out: PasqalCredential = { project_id: d.project_id, token: d.token }
      if (typeof d.expires_at === "string" && d.expires_at !== "") out.expires_at = d.expires_at
      return out
    },
  },
  slack: {
    file: slackFile,
    encode(value) {
      rejectPoisonKeys(value)
      const token = typeof value.token === "string" ? value.token.trim() : ""
      if (token === "") throw new Error('slack credential needs non-empty "token"')
      return JSON.stringify({ token }, null, 2) + "\n"
    },
    decode(raw) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined
      const d = raw as Record<string, unknown>
      if (typeof d.token !== "string" || d.token === "") return undefined
      return { token: d.token }
    },
  },
  github: {
    file: githubFile,
    encode(value) {
      rejectPoisonKeys(value)
      const token = typeof value.token === "string" ? value.token.trim() : ""
      if (token === "") throw new Error('github credential needs non-empty "token"')
      return JSON.stringify({ token }, null, 2) + "\n"
    },
    decode(raw) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined
      const d = raw as Record<string, unknown>
      if (typeof d.token !== "string" || d.token === "") return undefined
      return { token: d.token }
    },
  },
  linear: {
    file: linearFile,
    encode(value) {
      rejectPoisonKeys(value)
      const token = typeof value.token === "string" ? value.token.trim() : ""
      if (token === "") throw new Error('linear credential needs non-empty "token"')
      return JSON.stringify({ token }, null, 2) + "\n"
    },
    decode(raw) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined
      const d = raw as Record<string, unknown>
      if (typeof d.token !== "string" || d.token === "") return undefined
      return { token: d.token }
    },
  },
  google: {
    file: googleFile,
    encode(value) {
      rejectPoisonKeys(value)
      const token = typeof value.token === "string" ? value.token.trim() : ""
      if (token === "") throw new Error('google credential needs non-empty "token"')
      return JSON.stringify({ token }, null, 2) + "\n"
    },
    decode(raw) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined
      const d = raw as Record<string, unknown>
      if (typeof d.token !== "string" || d.token === "") return undefined
      return { token: d.token }
    },
  },
  "google-drive": {
    file: googleDriveFile,
    encode(value) {
      rejectPoisonKeys(value)
      const token = typeof value.token === "string" ? value.token.trim() : ""
      if (token === "") throw new Error('google-drive credential needs non-empty "token"')
      return JSON.stringify({ token }, null, 2) + "\n"
    },
    decode(raw) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined
      const d = raw as Record<string, unknown>
      if (typeof d.token !== "string" || d.token === "") return undefined
      return { token: d.token }
    },
  },
}

// --- atomic 0600-at-birth writer ---

export interface WriteHooks {
  /** Test seam: observe or replace the rename step, e.g. to assert the tmp
   *  file's mode BEFORE it becomes the target (mode-at-birth, never a
   *  post-rename chmod). Production callers pass nothing. */
  rename?: (tmp: string, target: string) => void
}

/** Atomic replace: write a sibling tmp file with mode 0600 set AT CREATION
 *  (the mode option on the open — the Bun/Node default is 0666 & ~umask,
 *  i.e. world-readable), then rename over the target. rename() swaps the
 *  inode, so a pre-existing wrong-permission target comes out 0600 too. On
 *  ANY failure the tmp is removed: the target is never partial — it holds
 *  either the old bytes or the new bytes, nothing in between. */
export function atomicWriteFileSync(target: string, data: string, hooks?: WriteHooks): void {
  mkdirSync(path.dirname(target), { recursive: true })
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(6).toString("hex")}.tmp`)
  try {
    writeFileSync(tmp, data, { mode: 0o600 })
    ;(hooks?.rename ?? renameSync)(tmp, target)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

// --- the seam surface: read / write / clear per connection type ---

export function readCredential(type: "company-compute"): CompanyComputeCredential | undefined
export function readCredential(type: "pasqal-cloud"): PasqalCredential | undefined
export function readCredential(type: "slack"): TokenCredential | undefined
export function readCredential(type: "github"): TokenCredential | undefined
export function readCredential(type: "linear"): TokenCredential | undefined
export function readCredential(type: "google"): TokenCredential | undefined
export function readCredential(type: "google-drive"): TokenCredential | undefined
export function readCredential(type: string): Credential | undefined
export function readCredential(type: ConnectionType): Credential | undefined
export function readCredential(type: ConnectionType): Credential | undefined {
  const backend = BACKENDS[type]
  if (!backend) return undefined
  const file = backend.file()
  let raw: unknown
  try {
    if (!existsSync(file)) return undefined
    raw = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return undefined // missing/unreadable/unparseable → absent, never a throw
  }
  return backend.decode(raw)
}

export function writeCredential(type: "company-compute", value: CompanyComputeCredential, hooks?: WriteHooks): void
export function writeCredential(type: "pasqal-cloud", value: PasqalCredential, hooks?: WriteHooks): void
export function writeCredential(type: "slack", value: TokenCredential, hooks?: WriteHooks): void
export function writeCredential(type: "github", value: TokenCredential, hooks?: WriteHooks): void
export function writeCredential(type: "linear", value: TokenCredential, hooks?: WriteHooks): void
export function writeCredential(type: "google", value: TokenCredential, hooks?: WriteHooks): void
export function writeCredential(type: "google-drive", value: TokenCredential, hooks?: WriteHooks): void
export function writeCredential(type: string, value: Credential, hooks?: WriteHooks): void
export function writeCredential(type: ConnectionType, value: Credential, hooks?: WriteHooks): void {
  const backend = BACKENDS[type]
  if (!backend) throw new Error(`unknown connection id: ${type}`)
  const bytes = backend.encode(value as unknown as Record<string, unknown>) // encode BEFORE touching disk
  atomicWriteFileSync(backend.file(), bytes, hooks)
}

/** Remove the credential file; absent is a no-op. */
export function clearCredential(type: ConnectionType): void {
  const backend = BACKENDS[type]
  if (!backend) return
  rmSync(backend.file(), { force: true })
}

/** The credential FILE's mtime in ms — the hand-edit detector (amicode#170
 *  AC1): a file newer than its last validation marks the status stale.
 *  Absent/unreadable → undefined, never a throw. */
export function credentialFileMtime(type: ConnectionType): number | undefined {
  try {
    const backend = BACKENDS[type]
    if (!backend) return undefined
    return statSync(backend.file()).mtimeMs
  } catch {
    return undefined
  }
}

export function isBuiltInConnectionId(id: string): id is BuiltInConnectionType {
  return id in BACKENDS
}
