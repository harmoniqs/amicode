/**
 * session-fleet-peers.ts — #1525 B1 (read-only)
 *
 * Pure logic for merging PEER sessions from the fleet-wide projection
 * (GET /amicode/fleet/sessions, W2 #1447) into the titlebar Sessions dropdown.
 *
 * B1 scope is READ-ONLY: a peer's sessions APPEAR in the dropdown, badged with
 * the owner machine name, searchable, and de-duped against the local list.
 * Owner-routed OPEN and remote control (prompt / archive / delete) are B2 —
 * this module deliberately carries no control surface. `isRemotePeerSession`
 * is the predicate the component uses to keep destructive/local-only actions
 * off a remote row.
 *
 * The projection's session entries carry the FULL raw session fields (id,
 * title, time, directory) PLUS the `amicode_owner` overlay
 * (merged_projection.ts `tagSessionsWithOwner`), so a remote entry is directly
 * renderable as a dropdown row. Every reader here is TOLERANT: a malformed /
 * absent / errored response yields [] and never throws (the dropdown must
 * degrade to the local list, never blank out).
 */

import type { Session } from "@opencode-ai/sdk/v2/client"

/** The per-session owner overlay the projection tags each entry with
 *  (mirrors merged_projection.ts `SessionOwnerTag`). */
export interface SessionOwnerTag {
  owner_machine_id: string
  owner_name: string
  device_type?: string
  directory?: string
  is_local: boolean
}

/** A dropdown session row — the SDK session shape plus the optional owner
 *  overlay a peer entry carries. */
export type DropdownSession = Session & {
  amicode_owner?: SessionOwnerTag
  /** #1544 (slice 4): the state channel — the app-visible control shape the
   *  fleet projection stamps beside `amicode_owner` (see SessionControlProjection). */
  amicode_control?: SessionControlProjection
}

// ── #1544 (slice 4): the CONTROL STATE CHANNEL (mirror of the extension's
// remote_session_state.SessionControlProjection, carried on GET
// /amicode/fleet/sessions as the `amicode_control` sibling of `amicode_owner`).
//
// This module is the SINGLE consumer of that channel on the session surface:
// the fail-closed chip, the enable/request affordance, the persistent driving
// banner, and the owner-routed remote-delete gate all derive from it. The chip
// reason is the SoT reason (the extension's write gate collapses
// revocation-pending→grant-revoked; this channel keeps them distinct — ADR 0034
// D4/D5), so the UI never reads the raw gate reason.

/** EXACTLY the five reasons the SoT emits — mirrors the extension's
 *  CONTROL_CHIP_REASONS (kept in sync as a literal, the same seam-crossing
 *  precedent SessionOwnerTag sets). */
export const CONTROL_CHIP_REASONS = [
  "no-control-grant",
  "grant-revoked",
  "revocation-pending",
  "insufficient-scope",
  "transport-down",
] as const

export type ControlChipReason = (typeof CONTROL_CHIP_REASONS)[number]

/** Which control affordance should appear. */
export type ControlEligibility = "enable-control" | "request-control" | "none"

/** The app-visible control shape (mirror of the extension's projection). */
export interface SessionControlProjection {
  controlState: "local" | "interactive" | "read-only" | "suspended"
  reason: ControlChipReason | null
  eligibility: ControlEligibility
}

const CONTROL_STATES = new Set(["local", "interactive", "read-only", "suspended"])
const CONTROL_REASONS = new Set<string>(CONTROL_CHIP_REASONS)

/** The default (control-held, no-affordance) projection — a local/unowned or
 *  malformed session degrades to this, never to a live erroring affordance. */
const CONTROL_LOCAL_DEFAULT: SessionControlProjection = { controlState: "local", reason: null, eligibility: "none" }

/** Human, DISTINCT chip labels — one per SoT reason. revocation-pending and
 *  grant-revoked are deliberately different (the write gate collapses them; the
 *  chip must not). */
const CONTROL_CHIP_LABELS: Record<ControlChipReason, string> = {
  "no-control-grant": "Control not enabled",
  "grant-revoked": "Control revoked",
  "revocation-pending": "Revoking…",
  "insufficient-scope": "Observe only",
  "transport-down": "Peer unreachable",
}

/** Tolerant read of the control channel off a session. Absent / malformed →
 *  the local no-affordance default (never throws). */
export function readSessionControl(
  session: { amicode_control?: unknown } | undefined,
): SessionControlProjection {
  const raw = session?.amicode_control
  if (!raw || typeof raw !== "object") return CONTROL_LOCAL_DEFAULT
  const o = raw as Record<string, unknown>
  if (typeof o.controlState !== "string" || !CONTROL_STATES.has(o.controlState)) return CONTROL_LOCAL_DEFAULT
  const reason = typeof o.reason === "string" && CONTROL_REASONS.has(o.reason) ? (o.reason as ControlChipReason) : null
  const eligibility =
    o.eligibility === "enable-control" || o.eligibility === "request-control" ? o.eligibility : "none"
  return { controlState: o.controlState as SessionControlProjection["controlState"], reason, eligibility }
}

/** Control is HELD when the session is local or interactively controlled. */
export function isControlHeld(control: SessionControlProjection): boolean {
  return control.controlState === "local" || control.controlState === "interactive"
}

/** Write affordances (composer→peer, archive, delete) are enabled ONLY under
 *  held control — otherwise disabled with a reason chip (never a live 500). */
export function writeAffordanceEnabled(control: SessionControlProjection): boolean {
  return isControlHeld(control)
}

/** The fail-closed chip: disabled-with-reason when control is not held. Null
 *  when control is held (no chip). The label is derived from the SoT reason. */
export function failClosedChip(control: SessionControlProjection): { reason: ControlChipReason; label: string } | null {
  if (isControlHeld(control) || control.reason === null) return null
  return { reason: control.reason, label: CONTROL_CHIP_LABELS[control.reason] }
}

/** The enable/request affordance derived from eligibility. `request-control` is
 *  present-but-INERT here — its backend (the request→approve handshake) is
 *  #1545; `enable-control` is live (the self-owned one-act enable). */
export function controlAffordance(control: SessionControlProjection): {
  kind: ControlEligibility
  label: string
  inert: boolean
} {
  if (control.eligibility === "enable-control") return { kind: "enable-control", label: "Enable control", inert: false }
  if (control.eligibility === "request-control") return { kind: "request-control", label: "Request control", inert: true }
  return { kind: "none", label: "", inert: true }
}

/** The persistent driving banner's target: the peer machineId being driven,
 *  or null when not interactively driving a peer. Read from the owner overlay
 *  (the state channel carries no machineId — the owner tag does). */
export function drivingBanner(
  session: { amicode_owner?: SessionOwnerTag; amicode_control?: unknown } | undefined,
): { machineId: string } | null {
  const control = readSessionControl(session)
  if (control.controlState !== "interactive") return null
  const machineId = session?.amicode_owner?.owner_machine_id
  if (!machineId) return null
  return { machineId }
}

/** The owner-routed remote-delete action, GATED on held control. When allowed,
 *  the request carries the owner machineId so the caller (and a reviewer) can
 *  see it is owner-routed — the #1542 write plane resolves the non-GET to the
 *  peer-owned session by pathname; this descriptor names the owner it targets.
 *  When control is not held, it is disallowed and carries the fail-closed reason
 *  (never a live erroring button). */
export function remoteDeleteAction(
  session: { id: string; directory?: string; amicode_owner?: SessionOwnerTag; amicode_control?: unknown } | undefined,
): { allowed: boolean; request?: { sessionID: string; directory: string; ownerMachineId: string }; reason?: ControlChipReason } {
  const control = readSessionControl(session)
  if (!writeAffordanceEnabled(control) || !session) {
    return { allowed: false, ...(control.reason ? { reason: control.reason } : {}) }
  }
  const ownerMachineId = session.amicode_owner?.owner_machine_id ?? ""
  return {
    allowed: true,
    request: { sessionID: session.id, directory: session.directory ?? "", ownerMachineId },
  }
}

/** Find a session's control off a raw GET /amicode/fleet/sessions response by
 *  id — the session surface's read for the CURRENT session's banner/affordance.
 *  Unknown id / garbage → the local default (never throws). */
export function findSessionControlInProjection(raw: unknown, sessionId: string): SessionControlProjection {
  return readSessionControl(findSessionEntryInProjection(raw, sessionId))
}

/** Find a raw projection entry by id (owner + control overlays intact), or
 *  undefined. Tolerant. */
function findSessionEntryInProjection(
  raw: unknown,
  sessionId: string,
): { amicode_owner?: SessionOwnerTag; amicode_control?: unknown } | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const sessions = (raw as { sessions?: unknown }).sessions
  if (!Array.isArray(sessions)) return undefined
  const hit = sessions.find((s) => s && typeof s === "object" && (s as { id?: unknown }).id === sessionId)
  return hit as { amicode_owner?: SessionOwnerTag; amicode_control?: unknown } | undefined
}

/** The driving banner for the CURRENT session id, read off the fleet projection.
 *  Non-null only when that session is interactively driving a remote peer — the
 *  persistent "driving <peer>" banner's data source. Unknown id / not-driving /
 *  garbage → null (no banner). */
export function drivingBannerFromProjection(raw: unknown, sessionId: string): { machineId: string } | null {
  return drivingBanner(findSessionEntryInProjection(raw, sessionId))
}

/** True when a session is a REMOTE peer session (has an owner overlay whose
 *  `is_local` is explicitly false). Local / unowned sessions are false —
 *  absence of an overlay means local (ADR 0031 §D6). B1 uses this to keep
 *  local-only actions (archive) and the local open OFF a remote row. */
export function isRemotePeerSession(session: { amicode_owner?: SessionOwnerTag } | undefined): boolean {
  return !!session?.amicode_owner && session.amicode_owner.is_local === false
}

/** The machine badge for a dropdown row: the owner machine name for a remote
 *  session, `undefined` for a local/unowned one (absence = local, unbadged). */
export function deriveSessionBadge(session: { amicode_owner?: SessionOwnerTag } | undefined): string | undefined {
  if (!isRemotePeerSession(session)) return undefined
  return session!.amicode_owner!.owner_name
}

/** Filter dropdown rows to a specific owner machine (#1439, promoted here in
 *  #1537 B2a AC6 as the single real home for the dropdown's machine helpers).
 *  `null`/`undefined` machineId = all machines (the "clear filter" state). */
export function filterSessionsByMachine<T extends { amicode_owner?: SessionOwnerTag }>(
  sessions: T[],
  machineId: string | null | undefined,
): T[] {
  if (machineId == null) return sessions
  return sessions.filter((s) => s.amicode_owner?.owner_machine_id === machineId)
}

/** Tolerant reader for one raw owner overlay — returns the tag only when its
 *  load-bearing fields are well-typed, else undefined. */
function readOwnerTag(raw: unknown): SessionOwnerTag | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const o = raw as Record<string, unknown>
  if (typeof o.owner_machine_id !== "string") return undefined
  if (typeof o.owner_name !== "string") return undefined
  if (typeof o.is_local !== "boolean") return undefined
  return {
    owner_machine_id: o.owner_machine_id,
    owner_name: o.owner_name,
    ...(typeof o.device_type === "string" ? { device_type: o.device_type } : {}),
    ...(typeof o.directory === "string" ? { directory: o.directory } : {}),
    is_local: o.is_local,
  }
}

/** Coerce one raw projection entry into a renderable DropdownSession, keeping
 *  only the fields the dropdown needs. Returns undefined when the entry has no
 *  usable id (never a fabricated row). */
function readProjectionSession(raw: unknown): DropdownSession | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const o = raw as Record<string, unknown>
  if (typeof o.id !== "string" || o.id === "") return undefined
  const owner = readOwnerTag(o.amicode_owner)
  const timeRaw = (o.time && typeof o.time === "object" ? o.time : {}) as Record<string, unknown>
  const created = typeof timeRaw.created === "number" ? timeRaw.created : 0
  const updated = typeof timeRaw.updated === "number" ? timeRaw.updated : created
  const time: DropdownSession["time"] = {
    created,
    updated,
    ...(typeof timeRaw.archived === "number" ? { archived: timeRaw.archived } : {}),
  }
  return {
    id: o.id,
    ...(typeof o.title === "string" ? { title: o.title } : {}),
    directory: typeof o.directory === "string" ? o.directory : "",
    ...(typeof o.parentID === "string" ? { parentID: o.parentID } : {}),
    time,
    ...(owner ? { amicode_owner: owner } : {}),
  } as DropdownSession
}

/** From the raw GET /amicode/fleet/sessions response, extract the REMOTE peer
 *  sessions (owner overlay present, `is_local === false`) as renderable rows.
 *  A malformed / error / not-yet-resolved response → []. Local-owned and
 *  unowned entries are dropped (the local list already carries those). */
export function peerSessionsFromProjection(raw: unknown): DropdownSession[] {
  if (!raw || typeof raw !== "object") return []
  const sessions = (raw as { sessions?: unknown }).sessions
  if (!Array.isArray(sessions)) return []
  return sessions.flatMap((s) => {
    const row = readProjectionSession(s)
    if (!row || !isRemotePeerSession(row)) return []
    return [row]
  })
}

/** Merge peer sessions into the local active list: local wins on an id
 *  collision (a session that is somehow in both stays local), and the result
 *  is sorted by last activity (updated ?? created) descending — the same order
 *  the dropdown already uses for the local list. */
export function mergePeerSessions(local: DropdownSession[], peers: DropdownSession[]): DropdownSession[] {
  const seen = new Set(local.map((s) => s.id))
  const merged = [...local]
  for (const p of peers) {
    if (seen.has(p.id)) continue
    seen.add(p.id)
    merged.push(p)
  }
  return merged.sort((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created))
}

/** The action the dropdown's openSession() dispatches on when a row is clicked.
 *  A READ-ONLY union — there is no delete/archive/prompt variant, so a reviewer
 *  can confirm this open path carries no remote-write surface (#1537 B2a). */
export type DropdownOpenAction =
  | { type: "select-tab"; sessionId: string }
  | { type: "navigate"; path: string }

/** Resolve how to open a dropdown row — the seam #1537 B2a wires for BOTH local
 *  and REMOTE peer rows.
 *
 *  Before B2a, a remote (peer-owned) row short-circuited to a "lives on
 *  <machine>" guard toast because opening a remote session was never wired.
 *  B2a removes that dead end: a remote row resolves to the SAME owner-routed
 *  navigate as a local one — the session store lives on the owner, and the
 *  multiplex routes reads by owner at the API boundary, so navigating to the
 *  row's raw `directory`/`id` IS the owner-routed open. This is a read: no
 *  branch mutates a remote session.
 *
 *  - an already-open tab → select it (no re-navigate, no transition);
 *  - otherwise → navigate to the encoded `directory`/`id` path.
 *
 *  Local-row behavior is byte-unchanged from B1 (same two outcomes). */
export function resolveDropdownOpenAction(
  session: DropdownSession,
  hasExistingTab: boolean,
  encodePath: (directory: string, id: string) => string,
): DropdownOpenAction {
  if (hasExistingTab) return { type: "select-tab", sessionId: session.id }
  return { type: "navigate", path: encodePath(session.directory, session.id) }
}
