// AMICODE: Connections routes data source (amicode#165 / parent #159, ADR
// 0002) — Company Compute connect path. Probe-first validation: a submitted
// key is classified against the solve service's fake-task status route BEFORE
// anything touches disk; only auth-passed classes write through the #162
// CredentialStore seam. SECURITY: secrets ride POST bodies and Authorization
// headers ONLY — never URLs, never query params, never error messages or
// logs. Every status response is built through a redacting whitelist parser,
// so no input (cache file, in-memory state) can leak a token into a body.
import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { homedir } from "node:os"
import path from "node:path"
import {
  atomicWriteFileSync,
  clearCredential,
  credentialFileMtime,
  readCredential,
  writeCredential,
  type ConnectionType,
  type PasqalCredential,
} from "./credentials"
import { pasqalSecretStore } from "./pasqal_secret"
import { parseTomlLite } from "./toml_lite"

// --- status contract (parent #159 data contract; secret-free by construction) ---

/** This slice only ever produces connected / needs-key / invalid /
 *  unreachable / validating for company-compute; expired + unentitled are
 *  forward-compatible states later slices fill in. */
export type ConnectionState =
  | "connected"
  | "needs-key"
  | "invalid"
  | "expired"
  | "unreachable"
  | "unentitled"
  | "validating"

export interface ConnectionDevice {
  id?: string
  name?: string
  state?: string
}

export interface ConnectionStatus {
  id: ConnectionType
  state: ConnectionState
  identity?: string
  /** 170 AC4 (the 2026-07-19 incident canary): the submitter this credential
   *  NOW answers as, when a revalidation echo disagrees with the stored
   *  `identity`. The stored identity is the immutable record; this field is
   *  the diff — presence IS the drift signal. Reconciliation is a human act
   *  (re-submitting the credential resets the record). */
  identity_drift?: string
  entitlements?: string[]
  expires_at?: string
  devices?: ConnectionDevice[]
  validated_at: string | null
  stale: boolean
  /** 169 AC4: connected purely in-memory (Pasqal minted no persistable
   *  token) — the claim dies with the server process. */
  session_only?: boolean
  /** 170 AC3: the last background revalidation could not REACH the service —
   *  a presentation flag on a connected claim ("last verified <validated_at>
   *  as <identity>"), never a verdict on the credential. Connected-only. */
  offline?: boolean
  /** #327: optional icon svg for built-ins, letter avatar for custom */
  icon?: string
  /** #327: display name from registry */
  name?: string
  /** auth methods advertised to the UI — browser for google, token for others */
  auth_methods?: string[]
}

/** The connection cards this module serves; company-compute renders first. */
export const CONNECTION_IDS: ConnectionType[] = ["company-compute", "pasqal-cloud", "slack", "github", "linear", "google", "google-drive"]

// --- Registry (issue #327): formalized built-in catalog with logos + custom ---

/** Inline SVG icons — full-color brand marks, 18×18 with explicit fills (not currentColor). */
export const CONNECTION_ICONS: Record<string, string> = {
  "company-compute":
    '<svg viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg"><rect width="18" height="18" rx="4" fill="#EAB308"/><path fill="white" d="M6.3 11.8h4.2c.8 0 1.4-.6 1.4-1.4 0-.6-.4-1.1-.9-1.3A2.2 2.2 0 0 0 9 7.4a2.2 2.2 0 0 0-2 .9c-.6.1-1 .6-1 1.2 0 .7.6 1.3 1.3 1.3z"/><path fill="white" opacity="0.95" d="M8.1 9.4 9 8.2l1 1.2 1.5-1.8 1 1-2.5 3-2-2.4z"/></svg>',
  "pasqal-cloud":
    '<svg viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg"><rect width="18" height="18" rx="4" fill="#1E1B4B"/><circle cx="9" cy="9" r="1.5" fill="white"/><ellipse cx="9" cy="9" rx="4.6" ry="1.65" fill="none" stroke="#FB713C" stroke-width="0.95" opacity="0.98"/><ellipse cx="9" cy="9" rx="4.6" ry="1.65" fill="none" stroke="#FB713C" stroke-width="0.95" opacity="0.98" transform="rotate(60 9 9)"/><ellipse cx="9" cy="9" rx="4.6" ry="1.65" fill="none" stroke="#FB713C" stroke-width="0.95" opacity="0.98" transform="rotate(-60 9 9)"/></svg>',
  slack:
    '<svg viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg"><rect width="18" height="18" rx="4" fill="white" stroke="#E5E7EB" stroke-width="0.5"/><g transform="translate(3.2 3.2)"><path fill="#E01E5A" d="M3.6 5a1.35 1.35 0 1 1-2.7 0 1.35 1.35 0 0 1 2.7 0zm1.45 0H7.6a1.35 1.35 0 1 0 0-2.7H5.05z"/><path fill="#2EB67D" d="M6.6 3.6a1.35 1.35 0 1 1 0-2.7 1.35 1.35 0 0 1 0 2.7zm0 1.45V7.6a1.35 1.35 0 1 0 2.7 0V5.05z"/><path fill="#ECB22E" d="M8 6.6a1.35 1.35 0 1 1 2.7 0 1.35 1.35 0 0 1-2.7 0zm-1.45 0H4a1.35 1.35 0 1 0 0 2.7h2.55z"/><path fill="#36C5F0" d="M5 8a1.35 1.35 0 1 1 0 2.7 1.35 1.35 0 0 1 0-2.7zm0-1.45V4a1.35 1.35 0 1 0-2.7 0v2.55z"/></g></svg>',
  github:
    '<svg viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg"><rect width="18" height="18" rx="4" fill="white" stroke="#E5E7EB" stroke-width="0.5"/><path fill="#24292F" d="M9 3.2a5.9 5.9 0 0 0-1.86 11.48c.29.05.4-.13.4-.28V13.4c-1.55.34-1.87-.66-1.87-.66-.25-.64-.62-.81-.62-.81-.5-.34.04-.33.04-.33.56.04.85.57.85.57.5.85 1.3.6 1.62.46.05-.36.19-.6.35-.74-1.23-.14-2.52-.62-2.52-2.74 0-.6.22-1.1.57-1.48-.06-.14-.25-.7.05-1.45 0 0 .47-.15 1.54.56A5.34 5.34 0 0 1 9 6.35c.48 0 .96.06 1.41.19 1.07-.71 1.54-.56 1.54-.56.3.75.11 1.31.05 1.45.35.38.57.88.57 1.48 0 2.13-1.3 2.6-2.53 2.74.2.17.38.5.38 1.02v1.51c0 .16.1.34.4.28A5.9 5.9 0 0 0 9 3.2z"/></svg>',
  linear:
    '<svg viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg"><rect width="18" height="18" rx="4" fill="#5E6AD2"/><path fill="white" d="M6.4 5.6h1.7L10.3 9 8 12.5H6.3L8.6 9 6.4 5.6z"/><path fill="white" opacity="0.75" d="M11.2 5.6h1.2v6.9h-1.2z"/></svg>',
  google:
    '<svg viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg"><rect width="18" height="18" rx="4" fill="white" stroke="#E5E7EB" stroke-width="0.5"/><path fill="#4285F4" d="M9.2 13.3c1.5 0 2.5-.5 3.3-1.4l-1.5-1.3c-.3.4-.7.8-1.8.8-1.4 0-2.4-1-2.4-2.3s1-2.3 2.4-2.3c.6 0 1 .2 1.3.4l1.1-1.1C10.9 5.5 10 5 9.2 5 6.9 5 5 6.7 5 9s1.9 4 4.2 4z"/><path fill="#34A853" d="M13.6 9.2c0-.3 0-.5-.1-.8H9.2v1.5h2.5c-.1.6-.5 1.1-1 1.4l1.5 1.2c.9-.8 1.4-2 1.4-3.3z"/><path fill="#FBBC04" d="M7.8 11.3c-.2-.5-.3-1-.3-1.6s.1-1.1.3-1.6L6.2 6.8C5.7 7.7 5.5 8.3 5.5 9s.2 1.3.7 2.2l1.6-1z"/><path fill="#EA4335" d="M9.2 6.3c.8 0 1.3.3 1.6.6l1.2-1.2C11.1 5 10.1 4.6 9.2 4.6 6.9 4.6 5 6.3 5 8.6l1.6 1.3c.4-.9 1.2-1.6 2.6-1.6z"/></svg>',
  "google-drive":
    '<svg viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg"><rect width="18" height="18" rx="4" fill="white" stroke="#E5E7EB" stroke-width="0.5"/><path fill="#4285F4" d="M10.2 4.2 4.5 13.8h3.4l5.7-9.6z"/><path fill="#34A853" d="M10.2 4.2h3.4L9 12.1 7.3 9.2z"/><path fill="#FBBC04" d="M4.5 13.8 9 12.1 7.3 9.2 4.5 13.8z"/></svg>',
}

export interface ConnectionEntry {
  id: string
  kind: "built-in" | "custom"
  name: string
  icon: { kind: "svg"; svg: string } | { kind: "letter"; letter: string }
  validator: "company-compute" | "pasqal" | "slack" | "github" | "linear" | "google" | "google-drive" | "none"
  authShape: "base-url-token" | "token-only" | "pasqal-credentials" | "browser"
  url?: string
}

export const BUILT_IN_CATALOG: ConnectionEntry[] = [
  {
    id: "company-compute",
    kind: "built-in",
    name: "Harmoniqs Cloud",
    icon: { kind: "svg", svg: CONNECTION_ICONS["company-compute"] },
    validator: "company-compute",
    authShape: "base-url-token",
  },
  {
    id: "pasqal-cloud",
    kind: "built-in",
    name: "Pasqal Cloud",
    icon: { kind: "svg", svg: CONNECTION_ICONS["pasqal-cloud"] },
    validator: "pasqal",
    authShape: "pasqal-credentials",
  },
  {
    id: "slack",
    kind: "built-in",
    name: "Slack",
    icon: { kind: "svg", svg: CONNECTION_ICONS["slack"] },
    validator: "slack",
    authShape: "token-only",
  },
  {
    id: "github",
    kind: "built-in",
    name: "GitHub",
    icon: { kind: "svg", svg: CONNECTION_ICONS["github"] },
    validator: "github",
    authShape: "token-only",
  },
  {
    id: "linear",
    kind: "built-in",
    name: "Linear",
    icon: { kind: "svg", svg: CONNECTION_ICONS["linear"] },
    validator: "linear",
    authShape: "token-only",
  },
  {
    id: "google",
    kind: "built-in",
    name: "Google",
    icon: { kind: "svg", svg: CONNECTION_ICONS["google"] },
    validator: "google",
    authShape: "token-only",
  },
  {
    id: "google-drive",
    kind: "built-in",
    name: "Google Drive",
    icon: { kind: "svg", svg: CONNECTION_ICONS["google-drive"] },
    validator: "google-drive",
    authShape: "token-only",
  },
]

export function getBuiltInEntry(id: string): ConnectionEntry | undefined {
  return BUILT_IN_CATALOG.find((e) => e.id === id)
}

export function isCustomConnectionId(id: string): boolean {
  return id.startsWith("custom-")
}

/** Custom connections file — 0600 atomic, ADR 0001 discipline. */
export function customConnectionsFile(): string {
  const env = process.env.AMICO_CUSTOM_CONNECTIONS_FILE
  if (env && env.trim() !== "") return env
  return path.join(homedir(), ".amico", "custom-connections.json")
}

export interface CustomConnectionRecord {
  id: string
  name: string
  url?: string
  token: string
}

export function loadCustomConnections(): CustomConnectionRecord[] {
  try {
    const file = customConnectionsFile()
    if (!existsSync(file)) return []
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"))
    if (!Array.isArray(raw)) return []
    const out: CustomConnectionRecord[] = []
    for (const entry of raw) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue
      const d = entry as Record<string, unknown>
      const id = typeof d.id === "string" ? d.id : ""
      const name = typeof d.name === "string" ? d.name : ""
      const token = typeof d.token === "string" ? d.token : ""
      if (!id.startsWith("custom-") || name === "" || token === "") continue
      const url = typeof d.url === "string" && d.url.trim() !== "" ? d.url.trim() : undefined
      out.push({ id, name, token, ...(url ? { url } : {}) })
    }
    return out
  } catch {
    return []
  }
}

export function saveCustomConnections(records: CustomConnectionRecord[]): void {
  const file = customConnectionsFile()
  // atomic 0600 via shared writer
  atomicWriteFileSync(file, JSON.stringify(records, null, 2) + "\n")
}

export function allConnections(): ConnectionEntry[] {
  const customs = loadCustomConnections().map((c) => ({
    id: c.id,
    kind: "custom" as const,
    name: c.name,
    icon: { kind: "letter" as const, letter: c.name.charAt(0).toUpperCase() },
    validator: "none" as const,
    authShape: "token-only" as const,
    url: c.url,
  }))
  return [...BUILT_IN_CATALOG, ...customs]
}

export function configuredConnectionIds(): string[] {
  const ids: string[] = []
  for (const entry of BUILT_IN_CATALOG) {
    if (readCredential(entry.id) !== undefined) ids.push(entry.id)
  }
  for (const c of loadCustomConnections()) ids.push(c.id)
  // also include session-only and inflight which count as configured
  for (const [id] of inflightOverlay) if (!ids.includes(id)) ids.push(id)
  for (const [id] of sessionOnlyOverlay) if (!ids.includes(id)) ids.push(id)
  // and any persisted status for custom ids
  try {
    const cache = readCacheFile(connectionsFile())
    for (const key of Object.keys(cache)) {
      if (key.startsWith("custom-") && !ids.includes(key)) ids.push(key)
    }
  } catch {}
  return ids
}

/** A connected claim older than this renders stale:true — the UI's cue to
 *  offer revalidation. Freshness metadata only; never blocks anything. */
export const STALE_MS = 24 * 60 * 60 * 1000

/** Mtime staleness slack (170 AC1): a credential file counts as hand-edited
 *  only when its mtime lands more than this AFTER validated_at. The connect
 *  path writes the file within moments of stamping validated_at (either
 *  order), so the slack keeps a fresh connect from reading as an edit while
 *  any real out-of-band edit — minutes or hours later — still trips it. */
export const MTIME_STALE_SLACK_MS = 5_000

/** Non-secret status cache — the ops-dir env-override idiom the siblings use
 *  (problems.ts / profile.ts / credentials.ts): $AMICODE_CONNECTIONS_FILE
 *  overrides, default lives beside cloud.json under ~/.amico. Holds ONLY
 *  whitelisted status fields; credentials live in the #162 store. */
export function connectionsFile(): string {
  const env = process.env.AMICODE_CONNECTIONS_FILE
  if (env && env.trim() !== "") return env
  return path.join(homedir(), ".amico", "connections.json")
}

/** In-memory in-flight state: while a submit/revalidate probe runs, its id
 *  maps to an entry here and concurrent GETs render "validating". Exported as
 *  the in-memory seam the poison test seeds — whatever lands in an entry, only
 *  the whitelist below can reach a response. */
export const inflightOverlay = new Map<string, Record<string, unknown>>()

/** In-memory session-only claims (169 AC4): a Pasqal validation that minted
 *  NO persistable token parks its connected status — identity, devices,
 *  validated_at — here and ONLY here. Nothing reaches disk, so a fresh status
 *  build after a restart renders needs-key and the card re-prompts. Same
 *  redaction discipline as the in-flight overlay: entries pass the whitelist
 *  before any response. */
export const sessionOnlyOverlay = new Map<string, Record<string, unknown>>()

/** In-memory pending project selection (#194 choose-project): after a
 *  username+password validation lists projects but before one is chosen, the
 *  projects + the still-unpersisted credential live HERE (process memory only,
 *  never disk) until chooseProjectResponse finalizes or a cancel/disconnect
 *  clears it. Holding the password briefly in memory (session-memory class) is
 *  the two-step cost; it is written to the keychain only once a project is
 *  chosen and the connection lands. */
interface PendingProject {
  projects: ConnectionProject[]
  username: string
  password: string
}
const pendingProjectOverlay = new Map<string, PendingProject>()

/** Test seam: drop all pending project selections. They are process-memory only
 *  (production clears per-connection on choose/disconnect); this exists so suites
 *  start clean without exposing the password-bearing map. */
export function clearPendingProjectSelections(): void {
  pendingProjectOverlay.clear()
}

// --- the redacting whitelist parser: the ONLY way status inputs become a
// response. It builds a FRESH object from declared fields with type checks —
// unknown keys (token, password, anything) have no path into the output.

const KNOWN_STATES: ReadonlySet<string> = new Set([
  "connected",
  "needs-key",
  "invalid",
  "expired",
  "unreachable",
  "unentitled",
  "validating",
])

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined
}

function isKnownState(v: string): v is ConnectionState {
  return KNOWN_STATES.has(v)
}

function whitelistDevices(v: unknown): ConnectionDevice[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: ConnectionDevice[] = []
  for (const raw of v) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue
    const d = raw as Record<string, unknown>
    const device: ConnectionDevice = {}
    const id = str(d.id)
    const name = str(d.name)
    const state = str(d.state)
    if (id) device.id = id
    if (name) device.name = name
    if (state) device.state = state
    if (Object.keys(device).length > 0) out.push(device)
  }
  return out.length > 0 ? out : undefined
}

/** Whitelist one persisted cache entry: only known-safe fields survive, each
 *  type-checked and rebuilt. Everything else — poisoned or not — is dropped. */
function whitelistPersisted(raw: unknown): Partial<ConnectionStatus> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {}
  const d = raw as Record<string, unknown>
  const out: Partial<ConnectionStatus> = {}
  const state = str(d.state)
  if (state && isKnownState(state)) out.state = state
  const identity = str(d.identity)
  if (identity) out.identity = identity
  const drift = str(d.identity_drift)
  if (drift) out.identity_drift = drift
  if (Array.isArray(d.entitlements)) {
    const entitlements = d.entitlements.filter((e): e is string => typeof e === "string" && e !== "")
    if (entitlements.length > 0) out.entitlements = entitlements
  }
  const expires = str(d.expires_at)
  if (expires) out.expires_at = expires
  const devices = whitelistDevices(d.devices)
  if (devices) out.devices = devices
  const validated = str(d.validated_at)
  if (validated) out.validated_at = validated
  if (d.offline === true) out.offline = true // only the literal true — anything else is noise
  return out
}

/** 170 AC5: expires_at at or behind now. Absent/unparseable expiry never
 *  expires anything — the honest minimum. */
function isPastExpiry(expires_at: string | undefined, now: number): boolean {
  if (!expires_at) return false
  const at = Date.parse(expires_at)
  return Number.isFinite(at) && at <= now
}

function computeStale(state: ConnectionState, validated_at: string | null, now: number, mtime?: number): boolean {
  if (state !== "connected") return false
  if (!validated_at) return true
  const at = Date.parse(validated_at)
  if (!Number.isFinite(at)) return true
  if (now - at > STALE_MS) return true
  // 170 AC1: a credential file hand-edited AFTER its last validation is a
  // desync the 24h clock cannot see — the file itself marks the claim stale
  return mtime !== undefined && mtime - at > MTIME_STALE_SLACK_MS
}

function iconForId(id: string): string | undefined {
  const builtIn = getBuiltInEntry(id)
  if (builtIn && builtIn.icon.kind === "svg") return builtIn.icon.svg
  if (id.startsWith("custom-")) {
    const custom = loadCustomConnections().find((c) => c.id === id)
    if (custom) return custom.name.charAt(0).toUpperCase()
  }
  return undefined
}

function nameForId(id: string): string | undefined {
  const builtIn = getBuiltInEntry(id)
  if (builtIn) return builtIn.name
  if (id.startsWith("custom-")) {
    const custom = loadCustomConnections().find((c) => c.id === id)
    if (custom) return custom.name
  }
  return undefined
}

/** Derive the rendered status for one connection from its whitelisted cache
 *  entry, the in-flight overlay, the session-only store, and credential
 *  presence (the truth for durable "connected"). Output carries ONLY
 *  whitelisted fields. */
function renderStatus(
  id: ConnectionType,
  persisted: Partial<ConnectionStatus>,
  input: { inflight: boolean; credential: boolean; now: number; mtime?: number; session?: Partial<ConnectionStatus> },
): ConnectionStatus {
  if (!input.inflight && input.session?.state === "connected") {
    // session-only claim (169 AC4): connected without a credential at rest —
    // rendered from memory alone, marked so the card can say so
    const validated_at = input.session.validated_at ?? null
    const out: ConnectionStatus = {
      id,
      state: "connected",
      validated_at,
      stale: computeStale("connected", validated_at, input.now),
      session_only: true,
    }
    if (input.session.identity) out.identity = input.session.identity
    if (input.session.entitlements) out.entitlements = input.session.entitlements
    if (input.session.expires_at) out.expires_at = input.session.expires_at
    if (input.session.devices) out.devices = input.session.devices
    const icon = iconForId(id)
    if (icon) out.icon = icon
    const name = nameForId(id)
    if (name) out.name = name
    if (id === "google" || id === "google-drive") out.auth_methods = ["token", "browser"]
    return out
  }
  let state: ConnectionState
  if (input.inflight) state = "validating"
  else if (persisted.state === "connected") state = input.credential ? "connected" : "needs-key"
  else if (persisted.state) state = persisted.state
  else state = input.credential ? "connected" : "needs-key"

  // 170 AC5: a past expiry outranks a connected claim AT READ TIME — the
  // reconnect prompt renders without waiting for a revalidation to notice,
  // identically for company-compute and pasqal.
  if (state === "connected" && isPastExpiry(persisted.expires_at, input.now)) state = "expired"

  const validated_at = state === "needs-key" ? null : (persisted.validated_at ?? null)
  const out: ConnectionStatus = {
    id,
    state,
    validated_at,
    stale: computeStale(state, validated_at, input.now, input.mtime),
  }
  if (state !== "needs-key") {
    if (persisted.identity) out.identity = persisted.identity
    if (persisted.identity_drift) out.identity_drift = persisted.identity_drift
    if (persisted.entitlements) out.entitlements = persisted.entitlements
    if (persisted.expires_at) out.expires_at = persisted.expires_at
    if (persisted.devices) out.devices = persisted.devices
  }
  // 170 AC3: offline is a connected-only presentation flag — "showing the
  // last verified status" makes no sense on any other state
  if (state === "connected" && persisted.offline) out.offline = true
  const icon = iconForId(id)
  if (icon) out.icon = icon
  const name = nameForId(id)
  if (name) out.name = name
  if (id === "google" || id === "google-drive") out.auth_methods = ["token", "browser"]
  return out
}

function readCacheFile(file: string): Record<string, unknown> {
  try {
    if (!existsSync(file)) return {}
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"))
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {}
    return raw as Record<string, unknown>
  } catch {
    return {} // missing/unreadable/unparseable → empty, never a throw
  }
}

export function synthesizeConnections(code: string, detail: string): string {
  return JSON.stringify({ ok: false, connections: [], error: `${code}: ${detail}` })
}

export interface StatusInput {
  file: string
  overlay: ReadonlyMap<string, Record<string, unknown>>
  hasCredential: (id: ConnectionType) => boolean
  /** credential-file mtime per id (ms) — the hand-edit detector (170 AC1).
   *  Absent seam (pure tests) or absent file → undefined, mtime rule off. */
  credentialMtime?: (id: ConnectionType) => number | undefined
  /** in-memory session-only claims; ABSENT by default so a fresh build from
   *  disk (= a restarted server) cannot see them (169 AC4) */
  session?: ReadonlyMap<string, Record<string, unknown>>
  now?: number
}

/** Pure body-builder over injectable inputs (profile.ts idiom); the route
 *  entrypoint below binds the real file/overlay/credential store. */
export function statusBody(input: StatusInput): string {
  const cache = readCacheFile(input.file)
  const now = input.now ?? Date.now()
  const builtIns = CONNECTION_IDS.map((id) => {
    const session = input.session?.get(id)
    const mtime = input.credentialMtime?.(id)
    return renderStatus(id, whitelistPersisted(cache[id]), {
      inflight: input.overlay.has(id),
      credential: input.hasCredential(id),
      now,
      ...(mtime !== undefined ? { mtime } : {}),
      ...(session !== undefined ? { session: whitelistPersisted(session) } : {}),
    })
  })
  // #327: custom connections that have been configured (optimistic connected)
  const customs: ConnectionStatus[] = []
  try {
    const customRecords = loadCustomConnections()
    for (const rec of customRecords) {
      const id = rec.id
      // only surface customs that have a cache entry or are considered configured
      // loadCustomConnections already implies configured, so always surface
      const session = input.session?.get(id)
      const mtime = input.credentialMtime?.(id)
      customs.push(
        renderStatus(id, whitelistPersisted(cache[id]), {
          inflight: input.overlay.has(id),
          credential: true, // optimistic — presence in file means connected
          now,
          ...(mtime !== undefined ? { mtime } : {}),
          ...(session !== undefined ? { session: whitelistPersisted(session) } : {}),
        }),
      )
    }
    // also surface any custom ids that are in cache but not in file (defensive)
    for (const key of Object.keys(cache)) {
      if (key.startsWith("custom-") && !customRecords.some((r) => r.id === key)) {
        const session = input.session?.get(key)
        const mtime = input.credentialMtime?.(key)
        customs.push(
          renderStatus(key, whitelistPersisted(cache[key]), {
            inflight: input.overlay.has(key),
            credential: input.hasCredential(key),
            now,
            ...(mtime !== undefined ? { mtime } : {}),
            ...(session !== undefined ? { session: whitelistPersisted(session) } : {}),
          }),
        )
      }
    }
  } catch {}
  return JSON.stringify({ ok: true, connections: [...builtIns, ...customs], error: null })
}

/** GET /amicode/connections — never rejects; failures collapse into the one
 *  success shape like every other amicode route. Stale connected claims render
 *  IMMEDIATELY from cache and kick a background revalidation (170 AC1) whose
 *  result lands in the cache for the NEXT read — the GET never waits. */
export function statusResponse(deps: { fetchImpl?: FetchImpl; pasqalSpawn?: PasqalSpawn } = {}): string {
  try {
    const body = statusBody({
      file: connectionsFile(),
      overlay: inflightOverlay,
      hasCredential: (id) => {
        if (isCustomConnectionId(id)) return loadCustomConnections().some((c) => c.id === id)
        return readCredential(id) !== undefined
      },
      credentialMtime: credentialFileMtime,
      session: sessionOnlyOverlay,
    })
    kickStaleRevalidations(body, deps)
    return body
  } catch (err) {
    return synthesizeConnections("bad_output", String(err))
  }
}

// --- background revalidation (170 AC1/AC3): stale claims refresh WITHOUT
// blocking the GET that noticed them. Deduped per id; never renders
// "validating" (the card keeps showing the cached claim); every failure is
// swallowed — the next GET simply retries.

const backgroundInflight = new Map<ConnectionType, Promise<void>>()

/** Test seam: a joinable handle over every background revalidation currently
 *  in flight — await this instead of sleeping. Production never calls it. */
export function backgroundRevalidationsSettled(): Promise<void> {
  return Promise.all([...backgroundInflight.values()]).then(() => undefined)
}

/** Kick background revalidations for stale connected claims in a just-built
 *  status body. Skips ids already refreshing, ids with a submit/revalidate in
 *  flight, session-only claims (nothing at rest to re-check), and ids without
 *  a stored credential. */
function kickStaleRevalidations(body: string, deps: { fetchImpl?: FetchImpl; pasqalSpawn?: PasqalSpawn }): void {
  let entries: unknown
  try {
    entries = (JSON.parse(body) as { connections?: unknown }).connections
  } catch {
    return
  }
  if (!Array.isArray(entries)) return
  for (const raw of entries) {
    if (typeof raw !== "object" || raw === null) continue
    const entry = raw as { id?: unknown; state?: unknown; stale?: unknown; session_only?: unknown }
    if (entry.state !== "connected" || entry.stale !== true || entry.session_only === true) continue
    const id = CONNECTION_IDS.find((known) => known === entry.id)
    if (!id || backgroundInflight.has(id) || inflightOverlay.has(id)) continue
    // custom connections are optimistic, never background revalidated
    if (isCustomConnectionId(id)) continue
    if (readCredential(id) === undefined) continue
    const task = (async () => {
      try {
        if (id === "company-compute") await backgroundRevalidateCompanyCompute(deps)
        else if (id === "pasqal-cloud") await backgroundRevalidatePasqal(deps)
        else if (id === "slack" || id === "github" || id === "linear" || id === "google" || id === "google-drive")
          await backgroundRevalidateToken(id, deps)
      } catch {
        // background refresh must never surface trouble; the next GET retries
      }
    })().finally(() => backgroundInflight.delete(id))
    backgroundInflight.set(id, task)
  }
}

/** The metadata a background/manual refresh carries forward from the existing
 *  cache entry — status facts the probe outcome does not speak to. */
function keptMetadata(existing: Partial<ConnectionStatus>): Partial<ConnectionStatus> {
  return {
    ...(existing.identity ? { identity: existing.identity } : {}),
    ...(existing.entitlements ? { entitlements: existing.entitlements } : {}),
    ...(existing.expires_at ? { expires_at: existing.expires_at } : {}),
    ...(existing.devices ? { devices: existing.devices } : {}),
  }
}

/** Reconcile a revalidation's identity echo against the stored record (170
 *  AC4, the 2026-07-19 incident canary). The stored identity is IMMUTABLE
 *  here: a disagreeing echo lands as identity_drift beside it — never over
 *  it. No echo → record and any prior drift stand; a matching echo clears
 *  the drift; a first-ever echo establishes the record. */
function identityRecord(existing: Partial<ConnectionStatus>, submitter: string | undefined): Partial<ConnectionStatus> {
  if (!submitter) {
    return {
      ...(existing.identity ? { identity: existing.identity } : {}),
      ...(existing.identity_drift ? { identity_drift: existing.identity_drift } : {}),
    }
  }
  if (!existing.identity) return { identity: submitter }
  if (existing.identity === submitter) return { identity: existing.identity }
  return { identity: existing.identity, identity_drift: submitter }
}

/** Company-compute background refresh: probe from the STORED credential.
 *  valid → connected with a fresh validated_at (identity echo reconciled per
 *  identityRecord); invalid → the authorizer truly rejected the key, render
 *  it; unreachable → the connected claim and its validated_at STAND (170
 *  AC3) — offline trouble is never a verdict on the credential, and the
 *  credential is never touched. */
async function backgroundRevalidateCompanyCompute(deps: { fetchImpl?: FetchImpl }): Promise<void> {
  const id: ConnectionType = "company-compute"
  const credential = readCredential(id) as unknown as { base_url: string; token: string } | undefined
  if (!credential) return
  const probe = await probeCompanyCompute(credential.base_url, credential.token, deps.fetchImpl)
  const existing = whitelistPersisted(readCacheFile(connectionsFile())[id])
  if (probe.outcome === "unreachable") {
    // offline (170 AC3): the connected claim and its last-verified timestamp
    // STAND — only the presentation marker lands, and a later successful
    // refresh (whose write carries no offline key) clears it
    persistStatus(id, { ...existing, offline: true })
    return
  }
  persistStatus(id, {
    ...keptMetadata(existing),
    ...(probe.outcome === "valid"
      ? identityRecord(existing, probe.submitter)
      : existing.identity_drift // a rejection is no reconciliation: a recorded drift stands
        ? { identity_drift: existing.identity_drift }
        : {}),
    state: probe.outcome === "valid" ? "connected" : "invalid",
    validated_at: new Date().toISOString(),
  })
}

/** Pasqal background refresh: local expiry math (169), now with the #194
 *  silent re-mint — an expired token with a stored keychain password renews
 *  itself without blocking the GET that noticed the staleness. */
async function backgroundRevalidatePasqal(deps: MutationDeps): Promise<void> {
  const credential = readCredential("pasqal-cloud") as unknown as PasqalCredential | undefined
  if (!credential) return
  if (pasqalExpired(credential) && (await attemptPasqalSilentReauth(deps))) return
  refreshPasqalFreshness(credential)
}

async function backgroundRevalidateToken(id: ConnectionType, deps: { fetchImpl?: FetchImpl }): Promise<void> {
  const cred = readCredential(id) as { token?: string } | undefined
  if (!cred || typeof cred.token !== "string") return
  let probe: ProbeResult
  if (id === "slack") probe = await probeSlack(cred.token, deps.fetchImpl)
  else if (id === "github") probe = await probeGithub(cred.token, deps.fetchImpl)
  else if (id === "google") probe = await probeGoogle(cred.token, deps.fetchImpl)
  else if (id === "google-drive") probe = await probeGoogleDrive(cred.token, deps.fetchImpl)
  else probe = await probeLinear(cred.token, deps.fetchImpl)
  const existing = whitelistPersisted(readCacheFile(connectionsFile())[id])
  if (probe.outcome === "unreachable") {
    persistStatus(id, { ...existing, offline: true })
    return
  }
  persistStatus(id, {
    ...keptMetadata(existing),
    state: probe.outcome === "valid" ? "connected" : "invalid",
    validated_at: new Date().toISOString(),
  })
}

// --- probe validation ---

export type ProbeOutcome = "valid" | "invalid" | "unreachable"

export interface ProbeResult {
  outcome: ProbeOutcome
  /** identity echo (170 AC4, live endpoint aws-infra#185): present when a
   *  VALID probe's response body carries a string `submitter` — absent for
   *  services predating the echo, non-JSON bodies, or rejected keys. */
  submitter?: string
}

/** Injectable fetch seam — tests stub this; production uses global fetch.
 *  The status code drives classification; `json` (optional, tolerated
 *  missing) is the identity-echo seam. */
export type FetchImpl = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; json?: () => Promise<unknown> }>

const PROBE_PATH = "/solves/whoami"

/** The identity echo: a VALID probe response MAY carry {submitter: string}
 *  (aws-infra#185). Anything else — no json seam, unparseable body, off-shape
 *  value — is simply no echo; never a throw, and nothing but the one string
 *  field is ever read. */
async function readSubmitterEcho(response: { json?: () => Promise<unknown> }): Promise<string | undefined> {
  try {
    const raw = await response.json?.()
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined
    return str((raw as Record<string, unknown>).submitter)
  } catch {
    return undefined
  }
}

/** Classify a Company Compute credential against GET /solves/whoami
 *  (aws-infra#185/#188 — the credential-scoped identity endpoint).
 *    2xx                → valid        (identity captured when echoed)
 *    401 / 403          → invalid      (HTTP API authorizer denials emit 403,
 *                                       not the once-assumed 401 — live-verified)
 *    anything else      → unreachable  (incl. 400/404: a deploy without the
 *                                       endpoint — refuse to save, never guess)
 *  Replaces the fake-task probe, which inverted against the live service
 *  (amicode#178: aws-infra#186's task-id guard 400'd valid keys while
 *  authorizer-denial 403s classified garbage as valid).
 *  The token rides the Authorization header ONLY — never the URL. */
export async function probeCompanyCompute(
  baseUrl: string,
  token: string,
  fetchImpl: FetchImpl = fetch,
): Promise<ProbeResult> {
  const url = baseUrl.replace(/\/+$/, "") + PROBE_PATH
  let response: { status: number; json?: () => Promise<unknown> }
  try {
    response = await fetchImpl(url, { method: "GET", headers: { authorization: `Bearer ${token}` } })
  } catch {
    return { outcome: "unreachable" }
  }
  if (response.status === 401 || response.status === 403) return { outcome: "invalid" }
  if (response.status >= 200 && response.status < 300) {
    const submitter = await readSubmitterEcho(response)
    return { outcome: "valid", ...(submitter ? { submitter } : {}) }
  }
  return { outcome: "unreachable" }
}

// --- New validators (issue #327): Slack, GitHub, Linear ---

export async function probeSlack(token: string, fetchImpl: FetchImpl = fetch): Promise<ProbeResult> {
  let response: { status: number; json?: () => Promise<unknown> }
  try {
    response = await fetchImpl("https://slack.com/api/auth.test", {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
    })
  } catch {
    return { outcome: "unreachable" }
  }
  if (response.json) {
    try {
      const body = (await response.json()) as Record<string, unknown>
      if (body && body.ok === true) return { outcome: "valid" }
      if (body && body.ok === false) return { outcome: "invalid" }
    } catch {
      return { outcome: "unreachable" }
    }
  }
  return { outcome: "unreachable" }
}

export async function probeGithub(token: string, fetchImpl: FetchImpl = fetch): Promise<ProbeResult> {
  let response: { status: number; json?: () => Promise<unknown> }
  try {
    response = await fetchImpl("https://api.github.com/user", {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
    })
  } catch {
    return { outcome: "unreachable" }
  }
  if (response.status === 200) return { outcome: "valid" }
  if (response.status === 401 || response.status === 403) return { outcome: "invalid" }
  return { outcome: "unreachable" }
}

export async function probeLinear(token: string, fetchImpl: FetchImpl = fetch): Promise<ProbeResult> {
  let response: { status: number; json?: () => Promise<unknown> }
  try {
    response = await (fetchImpl as unknown as (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; json?: () => Promise<unknown> }>)(
      "https://api.linear.app/graphql",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ query: "{ viewer { id } }" }),
      },
    )
  } catch {
    return { outcome: "unreachable" }
  }
  if (response.status === 401 || response.status === 403) return { outcome: "invalid" }
  if (response.status === 200) {
    if (response.json) {
      try {
        const body = (await response.json()) as Record<string, unknown>
        if (body && typeof body === "object" && body.data) return { outcome: "valid" }
        // 200 without data is treat as unreachable per spec
        return { outcome: "unreachable" }
      } catch {
        return { outcome: "unreachable" }
      }
    }
    return { outcome: "valid" }
  }
  return { outcome: "unreachable" }
}

export async function probeGoogle(token: string, fetchImpl: FetchImpl = fetch): Promise<ProbeResult> {
  let response: { status: number; json?: () => Promise<unknown> }
  try {
    response = await fetchImpl("https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=" + encodeURIComponent(token), {
      method: "GET",
      headers: {},
    })
  } catch {
    return { outcome: "unreachable" }
  }
  if (response.status === 200) return { outcome: "valid" }
  if (response.status === 400 || response.status === 401 || response.status === 403) return { outcome: "invalid" }
  return { outcome: "unreachable" }
}

export async function probeGoogleDrive(token: string, fetchImpl: FetchImpl = fetch): Promise<ProbeResult> {
  let response: { status: number; json?: () => Promise<unknown> }
  try {
    response = await fetchImpl("https://www.googleapis.com/drive/v3/about?fields=user", {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
    })
  } catch {
    return { outcome: "unreachable" }
  }
  if (response.status === 200) return { outcome: "valid" }
  if (response.status === 400 || response.status === 401 || response.status === 403) return { outcome: "invalid" }
  return { outcome: "unreachable" }
}

// --- Pasqal validator spawn (amicode#169 / parent #159; #164 contract) ---
// The fork never sees SDK internals: the validator's one-line JSON + exit-code
// contract is the ENTIRE interface. Inputs ride env variables ONLY — never
// argv (visible in `ps`), never files.

/** Interpreter: $AMICO_PYTHON override → `python3` resolved on PATH. */
export function pasqalPython(): string {
  const env = process.env.AMICO_PYTHON
  if (env && env.trim() !== "") return env
  return "python3"
}

/** Script: $AMICO_PASQAL_VALIDATOR override → the amicode-staged copy under
 *  the SHARED ops-dir resolution (amicodeOpsDir(): $AMICODE_OPS_DIR →
 *  ~/.amico/amicode). The amicode packaging side stages
 *  scripts/pasqal-connector/pasqal_validate.py there. */
export function pasqalValidatorScript(): string {
  const env = process.env.AMICO_PASQAL_VALIDATOR
  if (env && env.trim() !== "") return env
  return path.join(amicodeOpsDir(), "scripts", "pasqal-connector", "pasqal_validate.py")
}

export interface PasqalValidatorRun {
  exitCode: number
  stdout: string
}

/** Injectable spawn seam (AC1): tests record argv + the EXACT child env. The
 *  default implementation passes both through verbatim — the child env is
 *  always the minimal declared set built in submitPasqalCredential, NEVER a
 *  process.env spread. */
export type PasqalSpawn = (argv: string[], env: Record<string, string>) => Promise<PasqalValidatorRun>

const spawnPasqalValidator: PasqalSpawn = async (argv, env) => {
  // PORT SEAM (#451): the fork spawns via Bun.spawn; Node equivalent below —
  // same minimal-env contract, same stdout capture, exit code on resolve.
  return await new Promise((resolve, reject) => {
    const proc = spawn(argv[0], argv.slice(1), {
      env,
      stdio: ["ignore", "pipe", "ignore"], // fixed value-free messages by the #164 contract; stderr not consumed
    })
    let out = ""
    proc.stdout?.on("data", (b: Buffer) => (out += b.toString()))
    proc.once("error", reject)
    proc.once("exit", (code) => resolve({ exitCode: code ?? 0, stdout: out }))
  })
}

/** A pickable project from LIST mode (#194 choose-project). */
export interface ConnectionProject {
  id: string
  name: string
}

type PasqalOutcome =
  | { kind: "valid"; project_id: string; devices: ConnectionDevice[]; token: string | null; expires_at?: string }
  // LIST mode (#194): authenticated, no project chosen yet — the caller's
  // projects for the picker. Token is held only to finalize a choice.
  | { kind: "list"; projects: ConnectionProject[]; token: string | null; expires_at?: string }
  | { kind: "invalid" }
  | { kind: "unreachable" }
  | { kind: "unentitled" }
  | { kind: "config" }

function whitelistProjects(v: unknown): ConnectionProject[] {
  if (!Array.isArray(v)) return []
  const out: ConnectionProject[] = []
  for (const raw of v) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue
    const d = raw as Record<string, unknown>
    const id = str(d.id)
    if (!id) continue
    out.push({ id, name: str(d.name) ?? id })
  }
  return out
}

/** #164 exit-code contract → outcome: 0 valid (stdout must carry ONE
 *  parseable ok:true JSON line; mode:"list" → a project list, else a bound
 *  project) · 2 invalid-credentials · 3 unreachable · 4 project-unauthorized ·
 *  1/anything-else config-class (missing env / missing SDK / broken interpreter). */
function classifyValidatorRun(run: PasqalValidatorRun): PasqalOutcome {
  if (run.exitCode === 2) return { kind: "invalid" }
  if (run.exitCode === 3) return { kind: "unreachable" }
  if (run.exitCode === 4) return { kind: "unentitled" }
  if (run.exitCode !== 0) return { kind: "config" }
  let raw: unknown
  try {
    raw = JSON.parse(run.stdout.trim())
  } catch {
    return { kind: "config" } // exit 0 without the contract line is a config-class lie
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { kind: "config" }
  const d = raw as Record<string, unknown>
  if (d.ok !== true) return { kind: "config" }
  if (d.mode === "list") {
    // LIST mode: projects[] + a token; no project_id / devices in this shape.
    const token = typeof d.token === "string" && d.token !== "" ? d.token : null
    const expires = str(d.expires_at)
    return { kind: "list", projects: whitelistProjects(d.projects), token, ...(expires ? { expires_at: expires } : {}) }
  }
  const project = str(d.project_id)
  if (!project) return { kind: "config" }
  const devices: ConnectionDevice[] = []
  if (Array.isArray(d.devices)) {
    for (const device of d.devices) {
      if (typeof device === "string" && device !== "") devices.push({ name: device })
      else {
        const picked = whitelistDevices([device]) // tolerate future object-shaped devices
        if (picked) devices.push(...picked)
      }
    }
  }
  const token = typeof d.token === "string" && d.token !== "" ? d.token : null
  const expires = str(d.expires_at)
  return { kind: "valid", project_id: project, devices, token, ...(expires ? { expires_at: expires } : {}) }
}

// --- status cache writes: everything lands through the same whitelist, so a
// poisoned in-memory object can never serialize, and a poisoned file gets
// scrubbed on the next write. Atomic replace via the #162 writer.

function persistStatus(id: ConnectionType, entry: Partial<ConnectionStatus>): void {
  const file = connectionsFile()
  const cache = readCacheFile(file)
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(cache)) out[key] = whitelistPersisted(cache[key])
  out[id] = whitelistPersisted(entry)
  atomicWriteFileSync(file, JSON.stringify(out, null, 2) + "\n")
}

function clearStatus(id: ConnectionType): void {
  const file = connectionsFile()
  const cache = readCacheFile(file)
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(cache)) if (key !== id) out[key] = whitelistPersisted(cache[key])
  atomicWriteFileSync(file, JSON.stringify(out, null, 2) + "\n")
}

// --- HP flip on connect (amicode#167 / parent #159, pushed hp-cloud-key
// contract): a VALID Company Compute save grants the `issimo` entitlement and
// writes the durable {mode:"hp",status:"switching"} request. The amicode
// extension's EXISTING watcher (packages/extension/src/solver_mode.ts,
// watchSolverMode) consumes the request and performs the full re-prep exactly
// once — this slice only WRITES the shared file contract, never a second
// switch mechanism. One-way on connect: disconnect never reverts solver mode
// (the user's toggle owns reverting).

/** $AMICODE_OPS_DIR override → ~/.amico/amicode — the SAME resolution the
 *  extension's amicodeOpsDir() uses (substrate/vault_store.ts), so the watcher
 *  reads exactly where we write and tests stay hermetic. */
export function amicodeOpsDir(): string {
  const env = process.env.AMICODE_OPS_DIR
  if (env && env.trim() !== "") return env
  return path.join(homedir(), ".amico", "amicode")
}

export function entitlementsFile(): string {
  return path.join(amicodeOpsDir(), "entitlements.toml")
}

export function solverModeFile(): string {
  return path.join(amicodeOpsDir(), "solver-mode.json")
}

/** Grant `issimo` PRESERVING every other code (read-modify-write). The write
 *  is byte-compatible with the extension's applyEntitlementForMode writer —
 *  `codes = [...]` (+ optional `expired = [...]`), double-quoted strings — and
 *  its smol-toml reader parses it unchanged. Absent/corrupt file starts empty
 *  (the extension's own fallback); an already-granted file is left untouched
 *  byte-for-byte. Returns whether the grant was already in place. */
function grantIssimo(file: string): { alreadyGranted: boolean } {
  let codes: string[] = []
  let expired: string[] = []
  try {
    const parsed = parseTomlLite(readFileSync(file, "utf8"))
    if (parsed.ok) {
      const value = parsed.value as { codes?: unknown; expired?: unknown }
      if (Array.isArray(value.codes)) codes = value.codes.filter((c): c is string => typeof c === "string")
      if (Array.isArray(value.expired)) expired = value.expired.filter((c): c is string => typeof c === "string")
    }
  } catch {
    // absent/unreadable → start empty, matching the extension reader
  }
  if (codes.includes("issimo")) return { alreadyGranted: true }
  codes.push("issimo")
  const lines = [`codes = [${codes.map((c) => JSON.stringify(c)).join(", ")}]`]
  if (expired.length > 0) lines.push(`expired = [${expired.map((c) => JSON.stringify(c)).join(", ")}]`)
  atomicWriteFileSync(file, lines.join("\n") + "\n")
  return { alreadyGranted: false }
}

/** Tolerant {mode,status} read — the extension's readSolverModeState
 *  semantics: anything absent/off-shape collapses to piccolo/ready. */
function readSolverMode(file: string): { mode: "piccolo" | "hp"; status: "ready" | "switching" } {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { mode?: unknown; status?: unknown }
    return {
      mode: parsed.mode === "hp" ? "hp" : "piccolo",
      status: parsed.status === "switching" ? "switching" : "ready",
    }
  } catch {
    return { mode: "piccolo", status: "ready" }
  }
}

/** The FIXED partial-failure warning (sibling "code: detail" shape): the
 *  credential save stands; only the flip write went wrong. Value-free by the
 *  module contract — never a token, path, or errno. */
export const HP_FLIP_WARNING = "hp_flip_failed: connected, but the HP solver switch could not be requested"

/** After a VALID save: grant the entitlement, then request the hp switch the
 *  watcher re-preps from — but ONLY when a re-prep would change anything (the
 *  mode isn't hp yet, or the last prep ran without the grant). A repeat save
 *  on an already-flipped setup writes nothing, so the watcher — whose one
 *  re-prep includes restarting THIS server — is never poked for a no-op.
 *  NEVER throws: flip trouble must not corrupt the credential-save response;
 *  the caller passes the returned warning (if any) into the response's error
 *  field beside the connected status. */
function requestHpFlip(): string | undefined {
  try {
    const { alreadyGranted } = grantIssimo(entitlementsFile())
    const modeFile = solverModeFile()
    if (alreadyGranted && readSolverMode(modeFile).mode === "hp") return undefined
    atomicWriteFileSync(modeFile, JSON.stringify({ mode: "hp", status: "switching" }))
    return undefined
  } catch {
    return HP_FLIP_WARNING
  }
}

// --- mutation bodies (POST routes). One shape per route family, sibling
// discipline: never reject, ok:false + "code: detail" on failure. SECURITY:
// every failure message is a FIXED string — nothing the caller sent (token,
// base_url, anything an encoder rejects) is ever echoed.

export function synthesizeConnection(code: string, detail: string): string {
  return JSON.stringify({ ok: false, connection: null, error: `${code}: ${detail}` })
}

// --- loopback guard: credential mutations serve LOCAL callers only. The bind
// hostname is recorded by Server.listen (server.ts) at listen time; the
// in-process webHandler never binds a socket, so "never recorded" counts as
// loopback. setBindHostname doubles as the injectable test seam.

let bindHostname: string | undefined

/** Returns the previous value so a listener can RESTORE it when it stops — a
 *  dead 0.0.0.0 listener must not keep refusing mutations for a later
 *  loopback/in-process handler (see server.ts). */
export function setBindHostname(hostname: string | undefined): string | undefined {
  const previous = bindHostname
  bindHostname = hostname
  return previous
}

/** The current bind hostname — shared with the vault-browser routes, whose
 *  loopback gate rides the same signal as the credential-mutation guard. */
export function getBindHostname(): string | undefined {
  return bindHostname
}

/** Same loopback family the mdns gate recognizes (server.ts), widened to the
 *  whole 127/8 block and the v4-mapped form. undefined = in-process handler. */
export function isLoopbackHostname(hostname: string | undefined): boolean {
  if (hostname === undefined) return true
  const host = hostname.toLowerCase()
  if (host === "localhost" || host === "::1") return true
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  if (host.startsWith("::ffff:127.")) return true
  return false
}

/** The distinct refusal every mutation route answers on a non-loopback bind
 *  (AC5); undefined when the bind is fine. */
function loopbackRefusal(bind: string | undefined): string | undefined {
  if (isLoopbackHostname(bind)) return undefined
  return synthesizeConnection("non_loopback", "credential mutations serve loopback binds only")
}

const MAX_BODY_BYTES = 16 * 1024 // credentials are small; bigger is a mistake

export interface MutationDeps {
  fetchImpl?: FetchImpl
  /** injectable/recordable validator spawn for pasqal-cloud (169 AC1) */
  pasqalSpawn?: PasqalSpawn
  /** override the recorded bind hostname (pure-injection alternative to
   *  setBindHostname) */
  bindHostname?: string
}

/** `warning` is the partial-failure channel: ok:true (the mutation stood) with
 *  a non-null error field carrying a FIXED "code: detail" string (#167). */
function renderCurrent(id: ConnectionType, warning?: string): string {
  const cache = readCacheFile(connectionsFile())
  const session = sessionOnlyOverlay.get(id)
  const mtime = credentialFileMtime(id)
  const isCustom = isCustomConnectionId(id)
  const hasCred = isCustom
    ? loadCustomConnections().some((c) => c.id === id)
    : readCredential(id) !== undefined
  const connection = renderStatus(id, whitelistPersisted(cache[id]), {
    inflight: inflightOverlay.has(id),
    credential: hasCred,
    now: Date.now(),
    ...(mtime !== undefined ? { mtime } : {}),
    ...(session !== undefined ? { session: whitelistPersisted(session) } : {}),
  })
  return JSON.stringify({ ok: true, connection, error: warning ?? null })
}

interface MutationBody {
  id?: unknown
  base_url?: unknown
  token?: unknown
  username?: unknown
  password?: unknown
  project_id?: unknown
  name?: unknown
  url?: unknown
}

function parseMutationBody(rawBody: string): MutationBody | undefined {
  if (rawBody.length > MAX_BODY_BYTES) return undefined
  try {
    const parsed: unknown = JSON.parse(rawBody)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined
    return parsed as MutationBody
  } catch {
    return undefined
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

/** POST /amicode/connections/credential — body {id:"company-compute",
 *  base_url, token}. Probe FIRST; only the auth-passed class writes through
 *  the #162 seam. The terminal status rides back in the SAME response; while
 *  the probe runs, the overlay renders "validating" for concurrent GETs. */
export async function submitCredentialResponse(rawBody: string, deps: MutationDeps = {}): Promise<string> {
  const refusal = loopbackRefusal(deps.bindHostname ?? bindHostname)
  if (refusal) return refusal
  const body = parseMutationBody(rawBody)
  if (!body) return synthesizeConnection("bad_request", "body must be JSON with an id and that id's credential fields")
  if (body.id === "pasqal-cloud") return submitPasqalCredential(body, deps)
  if (body.id === "slack" || body.id === "github" || body.id === "linear" || body.id === "google" || body.id === "google-drive") {
    return submitTokenCredential(body.id as ConnectionType, body, deps)
  }
  if (body.id !== "company-compute") {
    return synthesizeConnection("unknown_connection", "id must be a known connection id")
  }
  const base = typeof body.base_url === "string" ? body.base_url.trim().replace(/\/+$/, "") : ""
  const token = typeof body.token === "string" ? body.token.trim() : ""
  if (base === "" || token === "")
    return synthesizeConnection("bad_request", "non-empty base_url and token are required")
  if (!isHttpUrl(base)) return synthesizeConnection("bad_request", "base_url must be an http(s) URL")

  const id: ConnectionType = "company-compute"
  inflightOverlay.set(id, { state: "validating" })
  let probe: ProbeResult
  try {
    probe = await probeCompanyCompute(base, token, deps.fetchImpl)
  } finally {
    inflightOverlay.delete(id)
  }
  const validated_at = new Date().toISOString()
  let warning: string | undefined
  if (probe.outcome === "valid") {
    try {
      writeCredential(id, { base_url: base, token })
    } catch {
      // value-free by contract: never echo what the encoder rejected
      return synthesizeConnection("write_failed", "credential could not be saved")
    }
    // submitting a credential is the human act that OWNS the identity record
    // (170 AC4): the echo (if any) becomes the fresh record, any prior drift
    // is reconciled away with the old entry
    persistStatus(id, { state: "connected", validated_at, ...(probe.submitter ? { identity: probe.submitter } : {}) })
    warning = requestHpFlip() // #167: AFTER the save and ONLY on the valid outcome
  } else {
    // nothing written — an existing credential (if any) stays untouched
    persistStatus(id, { state: probe.outcome, validated_at })
  }
  return renderCurrent(id, warning)
}

async function submitTokenCredential(id: ConnectionType, body: MutationBody, deps: MutationDeps): Promise<string> {
  const token = typeof body.token === "string" ? body.token.trim() : ""
  if (token === "") return synthesizeConnection("bad_request", "non-empty token is required")
  inflightOverlay.set(id, { state: "validating" })
  let probe: ProbeResult
  try {
    if (id === "slack") probe = await probeSlack(token, deps.fetchImpl)
    else if (id === "github") probe = await probeGithub(token, deps.fetchImpl)
    else if (id === "google") probe = await probeGoogle(token, deps.fetchImpl)
    else if (id === "google-drive") probe = await probeGoogleDrive(token, deps.fetchImpl)
    else probe = await probeLinear(token, deps.fetchImpl)
  } finally {
    inflightOverlay.delete(id)
  }
  const validated_at = new Date().toISOString()
  if (probe.outcome === "valid") {
    try {
      writeCredential(id, { token })
    } catch {
      return synthesizeConnection("write_failed", "credential could not be saved")
    }
    persistStatus(id, { state: "connected", validated_at })
  } else {
    persistStatus(id, { state: probe.outcome, validated_at })
  }
  return renderCurrent(id)
}

/** POST body {id:"pasqal-cloud", username, password, project_id} → spawn the
 *  #164 validator (env-only inputs; MINIMAL child env: PATH for interpreter
 *  resolution plus the three PASQAL_* inputs — never a process.env spread) and
 *  classify its one-line JSON / exit-code contract. SECURITY: the username and
 *  password live ONLY in this request scope and the child env — never the
 *  status cache, never any file, never a log or error message. Pasqal never
 *  touches solver mode: the HP flip (#167) is company-compute-only. */
/** The FIXED config-class warning (169 AC5, sibling "code: detail" shape):
 *  exit 1 / unknown exits / off-contract stdout / spawn failure all mean the
 *  validator itself could not run properly — distinct from the service being
 *  unreachable. Value-free by the module contract. */
export const PASQAL_CONFIG_WARNING =
  "pasqal_validator_config: the Pasqal validator could not run — check the Python interpreter and the pasqal-cloud SDK"

/** Build a one-shot choose-project mutation response (#194): the panel holds
 *  this and renders the project picker; it is NOT persisted into the GET
 *  status pipeline (the selection is transient, in pendingProjectOverlay). */
function chooseProjectResponseBody(id: ConnectionType, pending: PendingProject, warning?: string): string {
  return JSON.stringify({
    ok: true,
    connection: {
      id,
      state: "choose-project",
      identity: pending.username,
      projects: pending.projects, // [{id,name}] — validator-sourced, whitelisted
      validated_at: null,
      stale: false,
    },
    error: warning ?? null,
  })
}

/** Run the #164 validator for pasqal-cloud. project_id "" → LIST mode
 *  (authenticate, list projects); non-empty → CONNECT mode (bind + mint). The
 *  password rides the child env only. */
async function runPasqalValidator(
  username: string,
  password: string,
  projectId: string,
  deps: MutationDeps,
): Promise<PasqalOutcome> {
  const spawn = deps.pasqalSpawn ?? spawnPasqalValidator
  const argv = [pasqalPython(), pasqalValidatorScript()] // no secret ever rides argv
  const env = {
    PATH: process.env.PATH ?? "", // interpreter resolution only
    PASQAL_USERNAME: username,
    PASQAL_PASSWORD: password,
    PASQAL_PROJECT_ID: projectId, // "" → the validator's LIST mode
  }
  inflightOverlay.set("pasqal-cloud", { state: "validating" })
  try {
    return classifyValidatorRun(await spawn(argv, env))
  } catch {
    return { kind: "config" } // spawn trouble (missing interpreter/script) is config-class
  } finally {
    inflightOverlay.delete("pasqal-cloud")
  }
}

async function submitPasqalCredential(body: MutationBody, deps: MutationDeps): Promise<string> {
  const username = typeof body.username === "string" ? body.username.trim() : ""
  const password = typeof body.password === "string" ? body.password : ""
  // project_id is OPTIONAL now (#194): absent → authenticate + list projects
  // for the picker; present → connect straight to that project (token paste /
  // back-compat).
  const projectId = typeof body.project_id === "string" ? body.project_id.trim() : ""
  if (username === "" || password.trim() === "")
    return synthesizeConnection("bad_request", "non-empty username and password are required")

  const id: ConnectionType = "pasqal-cloud"
  const outcome = await runPasqalValidator(username, password, projectId, deps)

  // LIST mode result (project_id was absent): park the selection in memory and
  // hand the panel the picker. Nothing at rest, no keychain write yet.
  if (outcome.kind === "list") {
    if (outcome.projects.length === 0) {
      pendingProjectOverlay.delete(id)
      return synthesizeConnection("no_projects", "no Pasqal projects are available for this account")
    }
    const pending: PendingProject = { projects: outcome.projects, username, password }
    pendingProjectOverlay.set(id, pending)
    return chooseProjectResponseBody(id, pending)
  }
  // Any non-list outcome supersedes a stale pending selection.
  pendingProjectOverlay.delete(id)

  const validated_at = new Date().toISOString()
  sessionOnlyOverlay.delete(id) // every terminal outcome supersedes a session-only claim
  let warning: string | undefined
  if (outcome.kind === "valid" && outcome.token !== null) {
    try {
      // token-only at rest (#162 seam): project_id + token + expiry — the
      // password has no field to land in, and the store rejects poison keys.
      writeCredential(id, {
        project_id: outcome.project_id,
        token: outcome.token,
        ...(outcome.expires_at ? { expires_at: outcome.expires_at } : {}),
      })
    } catch {
      return synthesizeConnection("write_failed", "credential could not be saved")
    }
    // ADR 0001 addendum (#194): the ~24h token cannot be renewed without the
    // password (refresh tokens 403; no browser/device grant), so the password
    // goes to the OS keychain — NOT the credential file — to enable silent
    // re-mint on expiry. write() reporting false means the keychain was
    // unreachable and the password is session-memory only: the connection
    // still stands on the persisted token; only cross-restart silent re-auth
    // is lost. The secret never touches the status cache or any response.
    pasqalSecretStore().write(PASQAL_SECRET_ACCOUNT, { username, password })
    persistStatus(id, {
      state: "connected",
      validated_at,
      identity: outcome.project_id,
      devices: outcome.devices, // non-secret metadata, refreshed on every submit
      ...(outcome.expires_at ? { expires_at: outcome.expires_at } : {}),
    })
  } else if (outcome.kind === "valid") {
    // null token (mint unsupported) → SESSION-ONLY connected (AC4): nothing
    // reaches disk; the claim lives in memory and dies with the process, so
    // a restarted server re-prompts (needs-key).
    clearStatus(id)
    sessionOnlyOverlay.set(id, {
      state: "connected",
      validated_at,
      identity: outcome.project_id,
      devices: outcome.devices,
    })
  } else if (outcome.kind === "config") {
    // validator trouble is not a service verdict: render unreachable-class
    // with the DISTINCT fixed warning on the #167 partial-trouble channel
    persistStatus(id, { state: "unreachable", validated_at })
    warning = PASQAL_CONFIG_WARNING
  } else {
    // invalid / unreachable / unentitled — nothing written, an existing
    // credential (if any) stays untouched
    persistStatus(id, { state: outcome.kind, validated_at })
  }
  return renderCurrent(id, warning)
}

/** POST /amicode/connections/choose-project — body {id, project_id}. Step 2 of
 *  the #194 picker flow: finalize the pending username+password against the
 *  CHOSEN project. The secret is the one held in pendingProjectOverlay from the
 *  submit that listed the projects — it never rides this request. */
export async function chooseProjectResponse(rawBody: string, deps: MutationDeps = {}): Promise<string> {
  const refusal = loopbackRefusal(deps.bindHostname ?? bindHostname)
  if (refusal) return refusal
  const body = parseMutationBody(rawBody)
  if (!body) return synthesizeConnection("bad_request", "body must be JSON with an id and project_id")
  const id: ConnectionType = "pasqal-cloud"
  if (body.id !== id) return synthesizeConnection("unknown_connection", "choose-project applies to pasqal-cloud only")
  const pending = pendingProjectOverlay.get(id)
  if (!pending)
    return synthesizeConnection("no_pending_selection", "no pending project selection — reconnect and pick a project")
  const projectId = typeof body.project_id === "string" ? body.project_id.trim() : ""
  if (projectId === "" || !pending.projects.some((p) => p.id === projectId))
    return chooseProjectResponseBody(id, pending, "invalid_project: pick one of the listed projects")

  // Connect to the chosen project with the held credential.
  const outcome = await runPasqalValidator(pending.username, pending.password, projectId, deps)
  const validated_at = new Date().toISOString()
  if (outcome.kind === "valid" && outcome.token !== null) {
    try {
      writeCredential(id, {
        project_id: projectId,
        token: outcome.token,
        ...(outcome.expires_at ? { expires_at: outcome.expires_at } : {}),
      })
    } catch {
      return synthesizeConnection("write_failed", "credential could not be saved")
    }
    // project chosen and connection landed — NOW the password earns the keychain
    pasqalSecretStore().write(PASQAL_SECRET_ACCOUNT, { username: pending.username, password: pending.password })
    persistStatus(id, {
      state: "connected",
      validated_at,
      identity: projectId,
      devices: outcome.devices,
      ...(outcome.expires_at ? { expires_at: outcome.expires_at } : {}),
    })
    pendingProjectOverlay.delete(id)
    return renderCurrent(id)
  }
  if (outcome.kind === "valid") {
    // null token → session-only connected (mint unsupported); pending consumed
    clearStatus(id)
    sessionOnlyOverlay.set(id, { state: "connected", validated_at, identity: projectId, devices: outcome.devices })
    pendingProjectOverlay.delete(id)
    return renderCurrent(id)
  }
  if (outcome.kind === "invalid") {
    // creds unexpectedly rejected between listing and choosing — abandon it
    pendingProjectOverlay.delete(id)
    persistStatus(id, { state: "invalid", validated_at })
    return renderCurrent(id)
  }
  // unreachable / unentitled / (defensive) list / config — keep the pending
  // selection so the user can retry the pick; surface the trouble on the picker.
  const warn =
    outcome.kind === "unentitled"
      ? "unentitled: that project refused authorization — pick another"
      : outcome.kind === "config"
        ? PASQAL_CONFIG_WARNING
        : "unreachable: Pasqal Cloud is unreachable — try again"
  return chooseProjectResponseBody(id, pending, warn)
}

/** id-only mutation bodies (disconnect/revalidate) — the secret NEVER rides
 *  these requests; revalidation reads the stored credential server-side. */
function parseIdBody(rawBody: string): ConnectionType | undefined {
  const body = parseMutationBody(rawBody)
  if (!body) return undefined
  const id = body.id
  if (typeof id !== "string") return undefined
  return CONNECTION_IDS.find((known) => known === id)
}

function parseAnyIdBody(rawBody: string): string | undefined {
  const body = parseMutationBody(rawBody)
  if (!body) return undefined
  const id = body.id
  if (typeof id !== "string" || id.trim() === "") return undefined
  return id.trim()
}


// --- Browser OAuth start (Google) -------------------------------------------
// POST /amicode/connections/auth  body {id, method:"browser"|"device-code"}
// For google/google-drive the method is always "browser". The server's job is
// to open the authorization URL in the user's system browser (via McpBrowser,
// which now respects BROWSER in VS Code remote) and return a `waiting-browser`
// card so the UI shows the mid-flow copy. The actual token exchange happens
// out-of-band (the loopback callback server) — this endpoint only starts it.
// Google OAuth app credentials are configured via env:
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI (default loopback).
// The handler constructs the real Google authorization URL with PKCE and opens
// the system browser. This is a real Google connector — not a placeholder.
export async function startAuthResponse(rawBody: string, deps: MutationDeps = {}): Promise<string> {
  const refusal = loopbackRefusal(deps.bindHostname ?? bindHostname)
  if (refusal) return refusal
  const body = parseMutationBody(rawBody) as { id?: unknown; method?: unknown } | undefined
  if (!body || typeof body.id !== "string" || typeof body.method !== "string") {
    return synthesizeConnection("bad_request", "body must be JSON {id, method}")
  }
  const id = body.id
  const method = body.method
  if (method !== "browser" && method !== "device-code") {
    return synthesizeConnection("bad_request", "method must be browser or device-code")
  }
  if (id !== "google" && id !== "google-drive") {
    return synthesizeConnection("bad_request", "browser auth is only for google connections")
  }
  // Real Google OAuth URL — scopes differ by connector:
  //   google       → Gmail read + userinfo (read an email)
  //   google-drive → Drive file + Sheets (create/populate a sheet) + userinfo
  const scopes =
    id === "google"
      ? ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/userinfo.email"]
      : [
          "https://www.googleapis.com/auth/drive.file",
          "https://www.googleapis.com/auth/spreadsheets",
          "https://www.googleapis.com/auth/userinfo.email",
        ]
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim()
  const redirectUri = process.env.GOOGLE_REDIRECT_URI?.trim() || "http://127.0.0.1:8085/oauth/callback"
  // If no client is configured, we still open Google's OAuth consent screen with an
  // explanatory error — this proves the browser wiring is end-to-end and gives the
  // operator a clear next step (set GOOGLE_CLIENT_ID) rather than silently doing nothing.
  // When the client is configured, this constructs the real authorization URL.
  const state = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
  const pendingUrl = clientId
    ? `https://accounts.google.com/o/oauth2/v2/auth?` +
      new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: scopes.join(" "),
        state,
        access_type: "offline",
        prompt: "consent",
      }).toString()
    : `https://accounts.google.com/signin/v2/identifier?connector=${id}&error=missing_client_id`
  // Best-effort browser open — failure is soft: the UI fallback (window.open
  // in status-popover-body) will also try, and the BrowserOpenFailed event
  // carries the URL for any listener.
  try {
    // Direct BROWSER-aware open (mirrors mcp/browser.ts logic but without Effect)
    const browserCmd = process.env.BROWSER?.trim()
    if (browserCmd) {
      const { spawn } = await import("node:child_process")
      try {
        const child = spawn(browserCmd, [pendingUrl], { stdio: "ignore", detached: true })
        child.unref()
      } catch {}
    } else {
      // PORT SEAM (#451): the fork uses the `open` npm package; the extension
      // host opens via the platform opener instead — same best-effort contract.
      const opener = process.platform === "darwin" ? "open" : "xdg-open"
      try {
        const child = spawn(opener, [pendingUrl], { stdio: "ignore", detached: true })
        child.unref()
      } catch {}
    }
  } catch {}
  // Return a synthetic waiting-browser response so the card flips immediately.
  // The real OAuth callback will later promote to connected via the same
  // credential file path that probeGoogle validates.
  return JSON.stringify({
    ok: true,
    connection: {
      id,
      state: "waiting-browser",
      validated_at: null,
      stale: false,
      auth_methods: ["browser"],
    },
    error: null,
  })
}

/** POST /amicode/connections/disconnect — body {id}. Clears the credential
 *  through the #162 seam and drops the cache entry; status becomes needs-key.
 *  Idempotent: disconnecting an absent credential is a no-op. */
export function disconnectResponse(rawBody: string, deps: MutationDeps = {}): string {
  const refusal = loopbackRefusal(deps.bindHostname ?? bindHostname)
  if (refusal) return refusal
  const anyId = parseAnyIdBody(rawBody)
  if (!anyId) return synthesizeConnection("bad_request", "body must be JSON {id} with a known connection id")
  // #327: custom connections have their own removal path but disconnect also handles them
  if (isCustomConnectionId(anyId)) {
    try {
      const existing = loadCustomConnections()
      const next = existing.filter((c) => c.id !== anyId)
      if (next.length !== existing.length) saveCustomConnections(next)
      clearStatus(anyId)
    } catch {
      return synthesizeConnection("write_failed", "credential could not be cleared")
    }
    return JSON.stringify({ ok: true, connection: { id: anyId, state: "needs-key", validated_at: null, stale: false }, error: null })
  }
  const id = parseIdBody(rawBody)
  if (!id) return synthesizeConnection("bad_request", "body must be JSON {id} with a known connection id")
  try {
    clearCredential(id)
    clearStatus(id)
    sessionOnlyOverlay.delete(id) // a session-only claim ends with disconnect too
    // #194: disconnect wipes the keychain password AND any pending project
    // selection — the interim's secret never outlives the connection. Harmless
    // for company-compute (no slot, no pending).
    if (id === "pasqal-cloud") {
      pasqalSecretStore().clear(PASQAL_SECRET_ACCOUNT)
      pendingProjectOverlay.delete(id)
    }
  } catch {
    return synthesizeConnection("write_failed", "credential could not be cleared")
  }
  return renderCurrent(id)
}

// --- #327 custom + catalog routes ---

export function catalogResponse(): string {
  const configured = new Set(configuredConnectionIds())
  const available = BUILT_IN_CATALOG.filter((e) => !configured.has(e.id)).map((e) => ({
    id: e.id,
    name: e.name,
    icon: e.icon.kind === "svg" ? e.icon.svg : e.icon.letter,
    authShape: e.authShape,
  }))
  return JSON.stringify({ ok: true, catalog: available, error: null })
}

export async function addCustomConnectionResponse(rawBody: string, deps: MutationDeps = {}): Promise<string> {
  const refusal = loopbackRefusal(deps.bindHostname ?? bindHostname)
  if (refusal) return refusal
  const body = parseMutationBody(rawBody)
  if (!body) return synthesizeConnection("bad_request", "body must be JSON with name and token")
  const name = typeof body.name === "string" ? body.name.trim() : ""
  const token = typeof body.token === "string" ? body.token.trim() : ""
  const url = typeof body.url === "string" ? body.url.trim() : typeof body.base_url === "string" ? body.base_url.trim() : ""
  if (name === "" || token === "") return synthesizeConnection("bad_request", "name and token are required")
  if (url !== "" && !isHttpUrl(url)) return synthesizeConnection("bad_request", "url must be an http(s) URL")
  const id = `custom-${randomBytes(4).toString("hex")}`
  const record: CustomConnectionRecord = { id, name, token, ...(url ? { url } : {}) }
  try {
    const existing = loadCustomConnections()
    existing.push(record)
    saveCustomConnections(existing)
    // optimistic connected — no probe, immediate status
    persistStatus(id, { state: "connected", validated_at: new Date().toISOString() })
  } catch {
    return synthesizeConnection("write_failed", "custom connection could not be saved")
  }
  return renderCurrent(id)
}

export function removeCustomConnectionResponse(rawBody: string, deps: MutationDeps = {}): string {
  const refusal = loopbackRefusal(deps.bindHostname ?? bindHostname)
  if (refusal) return refusal
  const id = parseAnyIdBody(rawBody)
  if (!id || !isCustomConnectionId(id)) return synthesizeConnection("bad_request", "body must be JSON {id} with a custom connection id")
  try {
    const existing = loadCustomConnections()
    const next = existing.filter((c) => c.id !== id)
    if (next.length === existing.length) return synthesizeConnection("bad_request", "custom connection not found")
    saveCustomConnections(next)
    clearStatus(id)
  } catch {
    return synthesizeConnection("write_failed", "custom connection could not be removed")
  }
  return JSON.stringify({ ok: true, error: null })
}

/** POST /amicode/connections/revalidate — body {id}. Re-runs the probe from
 *  the STORED credential and refreshes validated_at; the secret never rides
 *  the request. Absent credential → needs-key, no probe fired. */
export async function revalidateResponse(rawBody: string, deps: MutationDeps = {}): Promise<string> {
  const refusal = loopbackRefusal(deps.bindHostname ?? bindHostname)
  if (refusal) return refusal
  const anyId = parseAnyIdBody(rawBody)
  if (!anyId) return synthesizeConnection("bad_request", "body must be JSON {id} with a known connection id")
  // #327: custom connections are optimistic — no probe
  if (isCustomConnectionId(anyId)) {
    const exists = loadCustomConnections().some((c) => c.id === anyId)
    if (!exists) return synthesizeConnection("bad_request", "custom connection not found")
    const existing = whitelistPersisted(readCacheFile(connectionsFile())[anyId])
    persistStatus(anyId, { ...keptMetadata(existing), state: "connected", validated_at: new Date().toISOString() })
    return renderCurrent(anyId)
  }
  const id = parseIdBody(rawBody)
  if (!id) return synthesizeConnection("bad_request", "body must be JSON {id} with a known connection id")
  if (id === "pasqal-cloud") return revalidatePasqal(deps)
  if (id === "slack" || id === "github" || id === "linear" || id === "google" || id === "google-drive") {
    const cred = readCredential(id) as { token?: string } | undefined
    if (!cred || typeof cred.token !== "string" || cred.token === "") {
      clearStatus(id)
      return renderCurrent(id)
    }
    inflightOverlay.set(id, { state: "validating" })
    let probe: ProbeResult
    try {
      if (id === "slack") probe = await probeSlack(cred.token, deps.fetchImpl)
      else if (id === "github") probe = await probeGithub(cred.token, deps.fetchImpl)
      else if (id === "google") probe = await probeGoogle(cred.token, deps.fetchImpl)
      else if (id === "google-drive") probe = await probeGoogleDrive(cred.token, deps.fetchImpl)
      else probe = await probeLinear(cred.token, deps.fetchImpl)
    } finally {
      inflightOverlay.delete(id)
    }
    const existing = whitelistPersisted(readCacheFile(connectionsFile())[id])
    persistStatus(id, {
      ...keptMetadata(existing),
      state: probe.outcome === "valid" ? "connected" : probe.outcome,
      validated_at: new Date().toISOString(),
    })
    return renderCurrent(id)
  }
  const credential = readCredential("company-compute") as unknown as { base_url: string; token: string } | undefined
  if (!credential) {
    clearStatus(id) // a status claim without a credential behind it is noise
    return renderCurrent(id)
  }
  inflightOverlay.set(id, { state: "validating" })
  let probe: ProbeResult
  try {
    probe = await probeCompanyCompute(credential.base_url, credential.token, deps.fetchImpl)
  } finally {
    inflightOverlay.delete(id)
  }
  // credential is kept on EVERY outcome — invalid signals re-entry, it does
  // not destroy user data; only disconnect removes the file. Metadata and the
  // identity record survive the refresh; a disagreeing echo lands as an
  // explicit drift beside the record, never over it (170 AC4).
  const existing = whitelistPersisted(readCacheFile(connectionsFile())[id])
  persistStatus(id, {
    ...keptMetadata(existing),
    ...(probe.outcome === "valid"
      ? identityRecord(existing, probe.submitter)
      : existing.identity_drift // a failed probe reconciles nothing: a recorded drift stands
        ? { identity_drift: existing.identity_drift }
        : {}),
    state: probe.outcome === "valid" ? "connected" : probe.outcome,
    validated_at: new Date().toISOString(),
  })
  return renderCurrent(id)
}

/** Pasqal revalidation is a TOKEN-mode freshness check: the stored credential
 *  holds only project_id + token — no password — so re-running the validator
 *  is impossible and pretending otherwise would lie. With a credential,
 *  expires_at vs now marks connected or expired (validated_at refreshed,
 *  devices/identity metadata kept); no or unparseable expiry means the claim
 *  stands. A live token-mode probe against the service is #160's device-path
 *  territory. Session-only claims are left standing: there is nothing to
 *  re-check without a password, and revalidate must not destroy them. */
async function revalidatePasqal(deps: MutationDeps): Promise<string> {
  const id: ConnectionType = "pasqal-cloud"
  const credential = readCredential(id)
  if (!credential) {
    if (sessionOnlyOverlay.has(id)) return renderCurrent(id)
    // no token at rest (e.g. a restart dropped an in-memory one) but a keychain
    // password may have survived → silent login rather than a needs-key prompt
    if (await attemptPasqalSilentReauth(deps)) return renderCurrent(id)
    clearStatus(id) // a status claim without a credential behind it is noise
    return renderCurrent(id)
  }
  // ADR 0001 addendum (#194): an expired token silently re-mints from the
  // keychain password when one is stored; otherwise it renders expired as before.
  if (pasqalExpired(credential as unknown as PasqalCredential) && (await attemptPasqalSilentReauth(deps))) return renderCurrent(id)
  refreshPasqalFreshness(credential as unknown as PasqalCredential)
  return renderCurrent(id)
}

/** Keychain account slot for the Pasqal password (ADR 0001 addendum). One
 *  Pasqal connection → one slot; Jack's `UserSession` used the same "default". */
export const PASQAL_SECRET_ACCOUNT = "default"

/** Is this credential's token past (or without) its expiry? */
function pasqalExpired(credential: PasqalCredential): boolean {
  const at = credential.expires_at === undefined ? Number.NaN : Date.parse(credential.expires_at)
  return Number.isFinite(at) && at <= Date.now()
}

/** Silent re-mint (ADR 0001 addendum, #194): the ~24h token lapsed but the
 *  password is in the keychain, so re-run the #164 validator with the stored
 *  credential and rewrite the token file — no user prompt. Returns true when it
 *  produced a terminal status (connected on success; needs-key if the stored
 *  password is now rejected), false when it could not refresh (no stored
 *  secret, no project to mint against, or a transient service/config failure)
 *  so the caller keeps the existing claim and marks expired/offline as before.
 *  SECURITY: the password reaches ONLY the child env here — exactly as submit
 *  does — never argv, never a status field, never a response. */
async function attemptPasqalSilentReauth(deps: MutationDeps): Promise<boolean> {
  const id: ConnectionType = "pasqal-cloud"
  const secret = pasqalSecretStore().read(PASQAL_SECRET_ACCOUNT)
  if (!secret) return false
  const projectId = (readCredential(id) as unknown as PasqalCredential | undefined)?.project_id ?? ""
  if (projectId === "") return false // nothing to re-mint against without a project
  const spawn = deps.pasqalSpawn ?? spawnPasqalValidator
  const argv = [pasqalPython(), pasqalValidatorScript()] // no secret ever rides argv
  const env = {
    PATH: process.env.PATH ?? "",
    PASQAL_USERNAME: secret.username,
    PASQAL_PASSWORD: secret.password,
    PASQAL_PROJECT_ID: projectId,
  }
  inflightOverlay.set(id, { state: "validating" })
  let outcome: PasqalOutcome
  try {
    outcome = classifyValidatorRun(await spawn(argv, env))
  } catch {
    outcome = { kind: "config" }
  } finally {
    inflightOverlay.delete(id)
  }
  const validated_at = new Date().toISOString()
  if (outcome.kind === "valid" && outcome.token !== null) {
    try {
      writeCredential(id, {
        project_id: outcome.project_id,
        token: outcome.token,
        ...(outcome.expires_at ? { expires_at: outcome.expires_at } : {}),
      })
    } catch {
      return false // fresh token could not be persisted — keep the old claim
    }
    persistStatus(id, {
      state: "connected",
      validated_at,
      identity: outcome.project_id,
      devices: outcome.devices,
      ...(outcome.expires_at ? { expires_at: outcome.expires_at } : {}),
    })
    return true
  }
  if (outcome.kind === "invalid") {
    // the stored password no longer authenticates (changed/revoked): wipe the
    // dead secret + token so the card falls to needs-key and a fresh login
    pasqalSecretStore().clear(PASQAL_SECRET_ACCOUNT)
    clearCredential(id)
    clearStatus(id)
    return true
  }
  // valid-but-null-token / unreachable / config: NOT a credential verdict —
  // leave the token + secret + claim untouched; the caller renders expired/offline
  return false
}

/** The persist half of the Pasqal freshness check — shared by the manual
 *  revalidate above and the background revalidation (170 AC1): expires_at vs
 *  now marks connected or expired, validated_at refreshes, devices and other
 *  metadata survive. */
function refreshPasqalFreshness(credential: PasqalCredential): void {
  const id: ConnectionType = "pasqal-cloud"
  const expiresAt = credential.expires_at === undefined ? Number.NaN : Date.parse(credential.expires_at)
  const expired = Number.isFinite(expiresAt) && expiresAt <= Date.now()
  const existing = whitelistPersisted(readCacheFile(connectionsFile())[id])
  persistStatus(id, {
    ...keptMetadata(existing), // devices + any other metadata survive the freshness check
    state: expired ? "expired" : "connected",
    identity: credential.project_id,
    ...(credential.expires_at ? { expires_at: credential.expires_at } : {}),
    validated_at: new Date().toISOString(),
  })
}
