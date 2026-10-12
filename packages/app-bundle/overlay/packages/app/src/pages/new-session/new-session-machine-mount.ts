/**
 * new-session-machine-mount.ts — #1453 (W4b)
 *
 * The data/seam layer that MOUNTS the new-session machine picker
 * (`new-session-machine-picker.ts`, #1442) into the live new-session flow.
 * Two responsibilities, both pure and unit-testable:
 *
 *  1. Build the picker's machine list from the fleet-sessions projection
 *     (`fleetSessionsFromResponse` output, W2 #1447 / W4a #1452), grouped by
 *     the `amicode_owner` overlay — one option per owning machine.
 *
 *  2. Consume the W3 (#1451) host→overlay focus push: the host posts ONE
 *     `{source:"amicode", kind:"fleet-focus", machineId}` down-message over the
 *     chat_bridge (ChatPanel.postMessage) on every effective focus change. The
 *     receiver here LATCHES the latest push so the picker can RE-READ current
 *     focus on mount (`current()`) rather than assume it caught the last push —
 *     the push is best-effort, NOT queued/replayed (a push that fired before
 *     the overlay had any listener is genuinely lost; the picker then defaults
 *     to home/local, the safe default). W3 exposes no host read-back endpoint,
 *     so the latch IS the read-back: its `message` listener installs when the
 *     receiver is created (the singleton installs at the new-session view's
 *     first render) and captures every subsequent push.
 *
 * The focus value drives the picker DEFAULT only — it is DISTINCT from the
 * sidebar focus selector (a different affordance, W3-owned). Selecting a
 * machine here chooses where a NEW session runs; it never re-focuses the
 * sidebar.
 */
import type { MachineOption } from "../../components/new-session-machine-picker"
import type { FleetSessionEntry } from "../session/timeline/session-header-provenance"

// ── machine list from the projection ─────────────────────────────────────────

/** Build the picker's machine list from the fleet-sessions projection: one
 *  option per owning machine, grouped by `amicode_owner.owner_machine_id`
 *  (first occurrence wins). Owner-less (pre-fleet / local-path) sessions are
 *  skipped — no bogus machine. An empty projection yields no machines (the
 *  honest fleet-of-one degrade). */
export function machineOptionsFromFleetSessions(entries: readonly FleetSessionEntry[]): MachineOption[] {
  const seen = new Set<string>()
  const options: MachineOption[] = []
  for (const entry of entries) {
    const owner = entry.amicode_owner
    if (!owner) continue
    if (seen.has(owner.owner_machine_id)) continue
    seen.add(owner.owner_machine_id)
    options.push({ machineId: owner.owner_machine_id, name: owner.owner_name, isLocal: owner.is_local })
  }
  return options
}

// ── the fleet-focus down-message (#1451 seam) ────────────────────────────────

/** The parsed focus: the focused machine id, or undefined for home (local). */
export interface FleetFocus {
  machineId: string | undefined
}

/** Parse the W3 (#1451) `fleet-focus` down-message envelope. Matches
 *  `source==="amicode"` AND `kind==="fleet-focus"` EXACTLY. `machineId` may be
 *  a string (focus that machine) or undefined/absent (home / unfocus — a VALID
 *  message, not malformed). Any other `machineId` type, or a non-matching
 *  source/kind, is not a fleet-focus message → undefined. */
export function parseFleetFocusMessage(raw: unknown): FleetFocus | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const d = raw as { source?: unknown; kind?: unknown; machineId?: unknown }
  if (d.source !== "amicode" || d.kind !== "fleet-focus") return undefined
  if (d.machineId === undefined) return { machineId: undefined }
  if (typeof d.machineId === "string") return { machineId: d.machineId }
  return undefined
}

// ── the overlay-side focus receiver (latch + re-read on mount) ───────────────

/** The minimal window surface the receiver needs — injected so the latch is
 *  unit-testable with a fake window (bun's test env has no DOM window). */
export interface WindowLike {
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void
}

/** The overlay-side receiver for the W3 focus push. Latches the latest focus
 *  so the picker can re-read it on mount, and notifies subscribers on each
 *  effective push. */
export interface FleetFocusReceiver {
  /** The latest focused machine id (undefined = home/local, or no push yet).
   *  This is the RE-READ-ON-MOUNT value the picker seeds its default from. */
  current(): string | undefined
  /** Subscribe to focus changes; returns an unsubscribe. */
  subscribe(callback: (machineId: string | undefined) => void): () => void
  /** Remove the window listener and drop subscribers. */
  dispose(): void
}

/** Create a focus receiver bound to `win`. Installs a `message` listener that
 *  latches every `fleet-focus` push; non-fleet-focus messages are ignored and
 *  never clobber the latch. */
export function createFleetFocusReceiver(win: WindowLike): FleetFocusReceiver {
  let latest: string | undefined
  const subscribers = new Set<(machineId: string | undefined) => void>()

  const onMessage = (event: MessageEvent) => {
    const focus = parseFleetFocusMessage((event as { data?: unknown }).data)
    if (!focus) return
    latest = focus.machineId
    for (const callback of subscribers) callback(latest)
  }

  win.addEventListener("message", onMessage)

  return {
    current: () => latest,
    subscribe(callback) {
      subscribers.add(callback)
      return () => subscribers.delete(callback)
    },
    dispose() {
      win.removeEventListener("message", onMessage)
      subscribers.clear()
    },
  }
}

// ── the process-wide singleton (installed at first render) ───────────────────

let singleton: FleetFocusReceiver | undefined

/** The process-wide focus receiver, bound to the real `window`. Lazily created
 *  on first call (the new-session view's render), so its listener is installed
 *  as early as the picker can be shown — maximizing the recoverable window for
 *  the best-effort push. Returns undefined outside a DOM context (SSR / tests),
 *  where callers fall back to home/local. */
export function getFleetFocusReceiver(): FleetFocusReceiver | undefined {
  if (typeof window === "undefined") return undefined
  if (!singleton) singleton = createFleetFocusReceiver(window)
  return singleton
}

// ── #1522 (ADR 0033 decision A): SSE-sourced focus event dispatch ────────────
//
// The SSE fan-in aggregator emits `amicode.fleet.focus` as the FIRST frame on
// every (re)connect. This function re-emits the SSE data as a window.postMessage
// with the SAME `{source:"amicode", kind:"fleet-focus", machineId}` envelope the
// chat_bridge uses — so the EXISTING latch catches it with zero changes.
// This is the SECOND input to the same seed path (the chat_bridge push is the
// first), not a new focus store.

/** Dispatch an SSE-sourced `amicode.fleet.focus` event to the existing focus
 *  latch via `window.postMessage`. If the event is NOT an `amicode.fleet.focus`
 *  type, this is a no-op (never clobbers the latch with non-focus data). */
export function dispatchSseFocusEvent(
  data: { type?: string; focusedMachineId?: string; isHome?: boolean; [key: string]: unknown },
  win: Window,
): void {
  if (data.type !== "amicode.fleet.focus") return
  // Re-emit with the same envelope parseFleetFocusMessage expects:
  //   { source: "amicode", kind: "fleet-focus", machineId }
  // `focusedMachineId` in the SSE data maps to `machineId` on the envelope.
  win.postMessage(
    { source: "amicode", kind: "fleet-focus", machineId: data.focusedMachineId },
    "*",
  )
}
