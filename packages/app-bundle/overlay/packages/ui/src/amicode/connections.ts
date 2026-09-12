// AMICODE: pure, tolerant parsing + card logic for the Connections panel tab
// (amicode#166 / parent #159). The wire shape is the #165 status contract
// served by GET /amicode/connections ({ok, connections:[…]}) and the three
// POST mutations ({ok, connection, error}) — packages/opencode
// src/server/amicode/connections.ts is the producer. This module is the
// SINGLE consumer of the wire shape (vaults.ts idiom: one schema, one place
// to update). It must never throw on malformed input; unknown fields are
// dropped and unknown states collapse to a safe "unknown" fallback, so a
// poisoned or future-shaped response can neither crash the card nor carry a
// secret into the DOM.

export const CONNECTION_WIRE_STATES = [
  "connected",
  "needs-key",
  "invalid",
  "expired",
  "unreachable",
  "unentitled",
  "validating",
  // auth-path scaffold (amicode#194 atlas): mid-flow states the server emits
  // once an interactive method is live. Today's producer never sends them —
  // every card renders exactly as before until it does.
  "waiting-browser",
  "waiting-code",
  "choose-project",
] as const
export type ConnectionWireState = (typeof CONNECTION_WIRE_STATES)[number]
/** Everything the wire might say beyond the contract states renders via the
 *  "unknown" fallback. */
export type ConnectionCardState = ConnectionWireState | "unknown"

/** Auth methods a connection MAY advertise (amicode#194): how the token gets
 *  minted. Absent on the wire → legacy behavior (the per-id credential form),
 *  chooser hidden — the mechanism decision stays open server-side. */
export const CONNECTION_AUTH_METHODS = ["credentials", "browser", "device-code", "token"] as const
export type ConnectionAuthMethod = (typeof CONNECTION_AUTH_METHODS)[number]

export type ConnectionProject = { id: string; name: string }

export type ConnectionView = {
  id: string
  state: ConnectionCardState
  /** what the wire actually said — shown verbatim when state is "unknown" */
  rawState: string
  identity?: string
  /** the submitter this key NOW answers as when it differs from the stored
   *  identity record (170 AC4) — presence IS the drift signal */
  identityDrift?: string
  /** server-offered prefill for the key form (forward-compatible) */
  baseUrl?: string
  /** device display names (Pasqal, 169 AC2) — non-secret status metadata */
  devices?: string[]
  /** connected in memory only (Pasqal minted no token, 169 AC4) — the card
   *  notes that a restart will re-prompt */
  sessionOnly?: boolean
  /** the last revalidation could not reach the service (170 AC3) — the card
   *  is showing the last verified status, never a verdict on the key */
  offline?: boolean
  /** display string: locale-formatted timestamp or an em dash */
  validatedAt: string
  stale: boolean
  /** auth methods the server advertises (#194); unknown strings are dropped */
  authMethods?: ConnectionAuthMethod[]
  /** device-code flow: the short human code — non-secret BY DESIGN (it is
   *  typed on another machine) and useless without that signed-in session */
  userCode?: string
  /** device-code flow: where the code gets entered */
  verificationUrl?: string
  /** display string: when the pending code stops working */
  codeExpiresAt?: string
  /** choose-project: the authenticated account's projects (name falls back
   *  to id; entries without an id are dropped) */
  projects?: ConnectionProject[]
  /** #327: optional icon svg or letter for logo rendering */
  icon?: string
  /** #327: display name from registry */
  name?: string
}

export type ConnectionsView = { ok: boolean; connections: ConnectionView[]; error?: string }
export type ConnectionActionView = { ok: boolean; connection?: ConnectionView; error?: string }

export const COMPANY_COMPUTE_ID = "company-compute"
export const PASQAL_ID = "pasqal-cloud"
export const SLACK_ID = "slack"
export const GITHUB_ID = "github"
export const LINEAR_ID = "linear"
export const GOOGLE_ID = "google"
export const GOOGLE_DRIVE_ID = "google-drive"

export const BUILT_IN_IDS = [COMPANY_COMPUTE_ID, PASQAL_ID, SLACK_ID, GITHUB_ID, LINEAR_ID, GOOGLE_ID, GOOGLE_DRIVE_ID] as const

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

export function isCustomConnectionId(id: string): boolean {
  return id.startsWith("custom-")
}

export function catalogForPicker(connections: ConnectionView[]): { id: string; name: string; icon: string; authShape: string }[] {
  const configured = new Set(connections.filter((c) => c.state !== "needs-key").map((c) => c.id))
  return BUILT_IN_IDS.filter((id) => !configured.has(id)).map((id) => ({
    id,
    name: connectionTitle(id),
    icon: CONNECTION_ICONS[id] ?? "",
    authShape: connectionFormKind(id),
  }))
}

/** #327: Only configured connections visible. The panel shows only connections
 *  that have been configured (connected or previously attempted). Unconfigured
 *  built-ins (needs-key) are hidden and surface via the Add picker. */
export function statusTabConnections(connections: ConnectionView[]): ConnectionView[] {
  return connections.filter((c) => c.state !== "needs-key")
}
export function unconfiguredBuiltIns(connections: ConnectionView[]): string[] {
  const configured = new Set(connections.filter((c) => c.state !== "needs-key").map((c) => c.id))
  return BUILT_IN_IDS.filter((id) => !configured.has(id)) as unknown as string[]
}

/** Product names are not translated; ids without one render verbatim. */
export function connectionTitle(id: string): string {
  // Named as the product, alongside Pasqal Cloud. #200 called this "Solver API
  // key" to avoid implying a second product, but in a list whose other entry is
  // "Pasqal Cloud" that reads as a settings field rather than our service — and
  // it is the name every downstream refusal uses (amico-run, the hpc gate).
  // The wire id stays "company-compute": server contract, not presentation.
  if (id === COMPANY_COMPUTE_ID) return "Harmoniqs Cloud"
  if (id === PASQAL_ID) return "Pasqal Cloud"
  if (id === SLACK_ID) return "Slack"
  if (id === GITHUB_ID) return "GitHub"
  if (id === LINEAR_ID) return "Linear"
  if (id === GOOGLE_ID) return "Google"
  if (id === GOOGLE_DRIVE_ID) return "Google Drive"
  if (isCustomConnectionId(id)) return id // caller should use view.name when available
  return id
}

export function connectionDisplayName(view: ConnectionView): string {
  if (view.name) return view.name
  return connectionTitle(view.id)
}

const WIRE_STATES: ReadonlySet<string> = new Set(CONNECTION_WIRE_STATES)

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined
}

export function validatedAtDisplay(value: unknown): string {
  const raw = str(value)
  if (!raw) return "—"
  const at = Date.parse(raw)
  if (!Number.isFinite(at)) return "—"
  return new Date(at).toLocaleString()
}

/** Wire devices ({id?,name?,state?} objects) → display names; anything
 *  off-shape is dropped, an empty result is absent. */
function parseDevices(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const names: string[] = []
  for (const device of raw) {
    if (typeof device !== "object" || device === null || Array.isArray(device)) continue
    const d = device as Record<string, unknown>
    const name = str(d.name) ?? str(d.id)
    if (name) names.push(name)
  }
  return names.length > 0 ? names : undefined
}

const AUTH_METHODS: ReadonlySet<string> = new Set(CONNECTION_AUTH_METHODS)

/** Wire auth_methods → known methods; unknown strings and dupes are dropped,
 *  an empty result is absent (→ legacy per-id form, no chooser). */
function parseAuthMethods(raw: unknown): ConnectionAuthMethod[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const methods = raw.filter(
    (method, index): method is ConnectionAuthMethod =>
      typeof method === "string" && AUTH_METHODS.has(method) && raw.indexOf(method) === index,
  )
  return methods.length > 0 ? methods : undefined
}

/** Wire projects ({id, name?} objects) → picker entries; entries without an
 *  id are dropped, an empty result is absent. */
function parseProjects(raw: unknown): ConnectionProject[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const projects = raw.flatMap((project): ConnectionProject[] => {
    if (typeof project !== "object" || project === null || Array.isArray(project)) return []
    const p = project as Record<string, unknown>
    const id = str(p.id)
    if (!id) return []
    return [{ id, name: str(p.name) ?? id }]
  })
  return projects.length > 0 ? projects : undefined
}

function parseConnectionEntry(raw: unknown): ConnectionView {
  const entry = (typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  const rawState = str(entry.state) ?? "unknown"
  const codeExpires = str(entry.code_expires_at) ? validatedAtDisplay(entry.code_expires_at) : "—"
  return {
    id: str(entry.id) ?? "(unknown)",
    state: WIRE_STATES.has(rawState) ? (rawState as ConnectionWireState) : "unknown",
    rawState,
    identity: str(entry.identity),
    identityDrift: str(entry.identity_drift),
    baseUrl: str(entry.base_url),
    devices: parseDevices(entry.devices),
    sessionOnly: entry.session_only === true ? true : undefined,
    offline: entry.offline === true ? true : undefined,
    validatedAt: validatedAtDisplay(entry.validated_at),
    stale: entry.stale === true,
    authMethods: parseAuthMethods(entry.auth_methods),
    userCode: str(entry.user_code),
    verificationUrl: str(entry.verification_url),
    codeExpiresAt: codeExpires === "—" ? undefined : codeExpires,
    projects: parseProjects(entry.projects),
    icon: str(entry.icon),
    name: str(entry.name),
  }
}

export function parseConnectionsResponse(raw: unknown): ConnectionsView {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { ok: false, connections: [], error: "bad_shape: response is not an object" }
  const data = raw as Record<string, unknown>
  if (data.ok !== true) {
    const error = str(data.error) ?? "connection status reported a failure"
    return { ok: false, connections: [], error }
  }
  if (!Array.isArray(data.connections))
    return { ok: false, connections: [], error: "bad_shape: connections missing or not a list" }
  return { ok: true, connections: data.connections.map(parseConnectionEntry) }
}

// --- card model (AC1): the pure state→props mapping the tab renders from.
// The tsx component is a thin projection of this — with no component harness
// in the repo, this mapping carries the behavioral contract and its tests.

export type ConnectionStateLabels = Record<ConnectionCardState, string>

/** Distinct copy per state; anything unrecognized reads the "unknown" line. */
export function stateCopy(view: ConnectionView, labels: ConnectionStateLabels): string {
  return labels[view.state]
}

export type ConnectionCardModel = {
  state: ConnectionCardState
  tone: "success" | "critical" | "warning" | "pending" | "neutral"
  /** credential-entry form (fields per connectionFormKind) */
  showForm: boolean
  /** true only while validating — the in-flight render keeps the form frozen */
  formDisabled: boolean
  /** disconnect + revalidate */
  showActions: boolean
  showValidatedAt: boolean
  showIdentity: boolean
  showStale: boolean
  /** device names listed on a connected card (Pasqal, 169 AC2) */
  /** session-only note on a connected card (Pasqal, 169 AC4) */
  showSessionOnly: boolean
  /** offline last-verified line on a connected card (170 AC3) */
  showOffline: boolean
  /** submitter-drift diff on a connected card (170 AC4) */
  showDrift: boolean
  /** unknown states show the wire's raw word beside the fallback copy */
  showRawState: boolean
  /** mid-flow waiting row (browser handoff / device code) with a cancel exit */
  showWaiting: boolean
  // NOTE: the connected card intentionally does NOT list devices — the
  // validator's get_device_specs_dict() is Pasqal's device CATALOG, not the
  // project's entitled set, so it can mislead. Device selection happens fresh
  // at submit time (#160). The wire `devices` field is kept for that path.
  /** the short human code block + where to enter it (waiting-code) */
  showUserCode: boolean
  /** the authenticated account's project picker (choose-project) */
  showProjectPicker: boolean
  /** in-flight indicator (validating): a spinner + status copy, no frozen form —
   *  shown for both connect and choose-project round trips */
  showLoading: boolean
}

export function cardModel(view: ConnectionView): ConnectionCardModel {
  const base = {
    state: view.state,
    formDisabled: false,
    showValidatedAt: false,
    showIdentity: false,
    showStale: false,
    showSessionOnly: false,
    showOffline: false,
    showDrift: false,
    showRawState: false,
    showWaiting: false,
    showUserCode: false,
    showProjectPicker: false,
    showLoading: false,
  }
  switch (view.state) {
    case "connected":
      return {
        ...base,
        tone: "success",
        showForm: false,
        showActions: true,
        showValidatedAt: true,
        showIdentity: view.identity !== undefined,
        showStale: view.stale,
        showSessionOnly: view.sessionOnly === true,
        showOffline: view.offline === true,
        showDrift: view.identityDrift !== undefined,
      }
    case "needs-key":
      return { ...base, tone: "neutral", showForm: true, showActions: false }
    case "invalid":
      return { ...base, tone: "critical", showForm: true, showActions: false }
    case "expired":
      // the stored token aged out — re-entering credentials mints a fresh one
      return { ...base, tone: "warning", showForm: true, showActions: false }
    case "unreachable":
      return { ...base, tone: "warning", showForm: true, showActions: false }
    case "unentitled":
      // project-authorization refusal: the fix is a corrected project id
      return { ...base, tone: "critical", showForm: true, showActions: false }
    case "validating":
      // in-flight (connect or choose-project): a spinner + "validating" copy,
      // not a frozen form — clean and identical for both round trips
      return { ...base, tone: "pending", showForm: false, showActions: false, showLoading: true }
    case "waiting-browser":
      // the attempt lives in the user's browser; the card is passive + cancellable
      return { ...base, tone: "pending", showForm: false, showActions: false, showWaiting: true }
    case "waiting-code":
      // code typed on another device; the code itself is non-secret by design
      return {
        ...base,
        tone: "pending",
        showForm: false,
        showActions: false,
        showWaiting: true,
        showUserCode: view.userCode !== undefined,
      }
    case "choose-project":
      // authenticated, one choice left; no wire projects → waiting row keeps
      // the cancel exit open instead of rendering an empty picker. The connect
      // flow isn't done until a project lands, so the status slot keeps the
      // loading spinner (not a static pending dot) all the way through the picker.
      return {
        ...base,
        tone: "pending",
        showForm: false,
        showActions: false,
        showLoading: true,
        showIdentity: view.identity !== undefined,
        showProjectPicker: (view.projects?.length ?? 0) > 0,
        showWaiting: (view.projects?.length ?? 0) === 0,
      }
    default:
      // safe fallback (AC4): keep every exit open — re-key, disconnect, or
      // revalidate — and surface whatever the wire said as a raw badge.
      return {
        ...base,
        tone: "neutral",
        showForm: true,
        showActions: true,
        showRawState: true,
        showValidatedAt: view.validatedAt !== "—",
        showIdentity: view.identity !== undefined,
      }
  }
}

// --- label templates (170 AC3/AC4): copy whose values (identities,
// timestamps) only exist at render time. The app passes the raw {{slot}}
// template from its i18n dict; the card fills it with DISPLAY values already
// scrubbed by the parser above — never wire-raw objects, never secrets.

/** Fill {{name}} slots in a label template; unknown slots stay verbatim so
 *  future copy keeps rendering something honest. */
export function fillLabelTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (slot, key: string) => values[key] ?? slot)
}

/** 170 AC3: the offline last-verified line — "last verified <at> as
 *  <identity>" semantics; a missing identity renders an em dash. */
export function offlineCopy(view: ConnectionView, template: string): string {
  return fillLabelTemplate(template, { at: view.validatedAt, identity: view.identity ?? "—" })
}

/** 170 AC4: the drift diff — "answered as <identityDrift>, was <identity>";
 *  the stored record renders unaltered beside what the key answers as now. */
export function driftCopy(view: ConnectionView, template: string): string {
  return fillLabelTemplate(template, { answered: view.identityDrift ?? "—", stored: view.identity ?? "—" })
}

export function parseConnectionActionResponse(raw: unknown): ConnectionActionView {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { ok: false, error: "bad_shape: response is not an object" }
  const data = raw as Record<string, unknown>
  if (data.ok !== true) {
    const error = str(data.error) ?? "connection update failed"
    return { ok: false, error }
  }
  if (typeof data.connection !== "object" || data.connection === null || Array.isArray(data.connection))
    return { ok: false, error: "bad_shape: connection missing" }
  return { ok: true, connection: parseConnectionEntry(data.connection) }
}

// --- submit gate (AC3): an empty submission yields NO payload — the card
// fires no request and changes no state when this returns undefined.

export type BaseUrlTokenPayload = { id: string; base_url: string; token: string }
/** #194 two-step: the credentials form collects ONLY username+password — the
 *  project is chosen from the picker the server returns, not typed here. */
export type PasqalCredentialsPayload = { id: string; username: string; password: string }
/** paste-a-token method (#194): a portal-minted token + explicit project —
 *  the only path where project id stays a typed field (no authenticated
 *  listing exists before connect) */
export type PasqalTokenPayload = { id: string; token: string; project_id: string }
export type TokenOnlyPayload = { id: string; token: string }
export type CustomConnectionPayload = { id?: string; name: string; token: string; url?: string }
export type CredentialSubmitPayload = BaseUrlTokenPayload | PasqalCredentialsPayload | PasqalTokenPayload | TokenOnlyPayload

/** Which credential fields a card's form collects (169): pasqal-cloud takes
 *  username/password/project_id; every other id keeps base_url + token.
 *  #327: slack/github/linear take token-only; custom takes name+token+url. */
export type ConnectionFormKind = "base-url-token" | "pasqal-credentials" | "token-only" | "custom" | "browser"

export function connectionFormKind(id: string): ConnectionFormKind {
  if (id === PASQAL_ID) return "pasqal-credentials"
  if (id === GOOGLE_ID || id === GOOGLE_DRIVE_ID) return "token-only"
  if (id === SLACK_ID || id === GITHUB_ID || id === LINEAR_ID) return "token-only"
  if (isCustomConnectionId(id)) return "custom"
  return "base-url-token"
}

export function tokenOnlySubmitPayload(id: string, token: string): TokenOnlyPayload | undefined {
  const key = token.trim()
  if (key === "") return undefined
  return { id, token: key }
}

export function customConnectionPayload(name: string, token: string, url?: string): CustomConnectionPayload | undefined {
  const n = name.trim()
  const key = token.trim()
  if (n === "" || key === "") return undefined
  const trimmedUrl = url?.trim()
  return { name: n, token: key, ...(trimmedUrl ? { url: trimmedUrl } : {}) }
}

// --- auth-path scaffold (#194): method model + start/choose payload gates.
// The chooser exists only when the wire advertises ≥2 methods; an un-advertised
// method can never produce a payload, so a stale UI cannot start a flow the
// server no longer offers.

/** Methods this card offers. Wire-advertised when present; otherwise the
 *  legacy single method implied by the card's form kind. */
export function connectionAuthMethods(view: ConnectionView): ConnectionAuthMethod[] {
  if (view.authMethods && view.authMethods.length > 0) return view.authMethods
  if (view.id === GOOGLE_ID || view.id === GOOGLE_DRIVE_ID) return ["token", "browser"]
  return connectionFormKind(view.id) === "pasqal-credentials" ? ["credentials"] : ["token"]
}

/** What the entry area renders for a chosen method: a field set or a start
 *  button ("none" — browser/device-code hand the work elsewhere). */
export type MethodEntryKind = ConnectionFormKind | "pasqal-token" | "none"

export function methodEntryKind(id: string, method: ConnectionAuthMethod): MethodEntryKind {
  if (method === "browser" || method === "device-code") return "none"
  if (method === "credentials") return connectionFormKind(id)
  if (method === "token") {
    // Google now supports token like Slack/GitHub — return token-only even though
    // connectionFormKind previously returned browser for backwards compat
    if (id === GOOGLE_ID || id === GOOGLE_DRIVE_ID) return "token-only"
    const kind = connectionFormKind(id)
    if (kind === "token-only" || kind === "custom" || kind === "browser") return kind
    return id === PASQAL_ID ? "pasqal-token" : "base-url-token"
  }
  return connectionFormKind(id)
}

export type StartAuthPayload = { id: string; method: ConnectionAuthMethod }

/** Start gate: only wire-advertised interactive methods may start a flow. */
export function startAuthPayload(view: ConnectionView, method: ConnectionAuthMethod): StartAuthPayload | undefined {
  if (method !== "browser" && method !== "device-code") return undefined
  if (!connectionAuthMethods(view).includes(method)) return undefined
  return { id: view.id, method }
}

export type ChooseProjectPayload = { id: string; project_id: string }

/** Choose-project gate: the id must be one of the wire-offered projects. */
export function chooseProjectPayload(view: ConnectionView, projectId: string): ChooseProjectPayload | undefined {
  const project = projectId.trim()
  if (project === "" || !view.projects?.some((entry) => entry.id === project)) return undefined
  return { id: view.id, project_id: project }
}

/** Pasqal paste-a-token gate (#194): both fields required, both trimmed —
 *  tokens and project ids have no legitimate edge whitespace. */
export function pasqalTokenSubmitPayload(id: string, token: string, projectId: string): PasqalTokenPayload | undefined {
  const key = token.trim()
  const project = projectId.trim()
  if (key === "" || project === "") return undefined
  return { id, token: key, project_id: project }
}

export function submitPayload(id: string, baseUrl: string, token: string): BaseUrlTokenPayload | undefined {
  const base = baseUrl.trim()
  const key = token.trim()
  if (base === "" || key === "") return undefined
  return { id, base_url: base, token: key }
}

/** Pasqal submit gate (#194 two-step): username+password required; the
 *  username is trimmed, the password rides VERBATIM (spaces can be legitimate).
 *  No project_id — an empty project_id tells the server to list projects for
 *  the picker. The secret lives only in this payload and the POST body. */
export function pasqalSubmitPayload(
  id: string,
  username: string,
  password: string,
): PasqalCredentialsPayload | undefined {
  const user = username.trim()
  if (user === "" || password.trim() === "") return undefined
  return { id, username: user, password }
}

// --- action overlay (AC2): the app layer wraps ONE round trip with this —
// {validating: id} while the POST is in flight, then {terminal: connection}
// parsed from the SAME response. Pure and non-mutating; no polling loop.

export type ConnectionOverlay = {
  /** connection id whose card renders "validating" while a request runs */
  validating?: string
  /** terminal connection from the mutation response; replaces the card */
  terminal?: ConnectionView
}

function replaceConnection(base: ConnectionsView | undefined, entry: ConnectionView): ConnectionsView {
  if (!base || !base.ok) return { ok: true, connections: [entry] }
  const found = base.connections.some((conn) => conn.id === entry.id)
  return {
    ok: true,
    connections: found
      ? base.connections.map((conn) => (conn.id === entry.id ? entry : conn))
      : [...base.connections, entry],
  }
}

function validatingEntry(base: ConnectionsView | undefined, id: string): ConnectionView {
  const existing = base?.ok ? base.connections.find((conn) => conn.id === id) : undefined
  if (existing) return { ...existing, state: "validating", rawState: "validating" }
  return { id, state: "validating", rawState: "validating", validatedAt: "—", stale: false }
}

export function applyConnectionOverlay(
  base: ConnectionsView | undefined,
  overlay: ConnectionOverlay,
): ConnectionsView | undefined {
  let view = base
  if (overlay.terminal) view = replaceConnection(view, overlay.terminal)
  // applied last: a request in flight outranks any previously stored terminal
  if (overlay.validating !== undefined) view = replaceConnection(view, validatingEntry(view, overlay.validating))
  return view
}
