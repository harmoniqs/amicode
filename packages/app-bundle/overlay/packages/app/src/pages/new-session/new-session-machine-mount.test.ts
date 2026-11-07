/**
 * new-session-machine-mount.test.ts — #1453 (W4b)
 *
 * Mounts the (previously-dead) new-session machine picker in the live
 * new-session flow. This suite proves the DELIVERED behavior of the mount's
 * data seam — NOT the injected literal the #1442 picker unit test already
 * covers:
 *
 *  - the machine list is built from the fleet-sessions projection
 *    (fleetSessionsFromResponse output), grouped by amicode_owner;
 *  - the focused machine arrives over the W3 (#1451) chat_bridge `fleet-focus`
 *    down-message, is latched by the overlay-side receiver, re-read on mount,
 *    and feeds the picker's default;
 *  - `machineId: undefined` on the envelope is home/unfocus, NOT a malformed
 *    message.
 *
 * Message-driven behavior is tested with an injected fake window (the same
 * pattern as clipboard-bridge.test.ts) — bun's test env has no DOM window.
 */
import { describe, expect, test } from "bun:test"
import { createMachinePickerState, type MachineOption } from "../../components/new-session-machine-picker"
import type { FleetSessionEntry } from "../session/timeline/session-header-provenance"
import {
  createFleetFocusReceiver,
  machineOptionsFromFleetSessions,
  parseFleetFocusMessage,
  dispatchSseFocusEvent,
  type WindowLike,
} from "./new-session-machine-mount"

type Listener = (event: MessageEvent) => void

/** A stand-in for the framed window that records message listeners and lets a
 *  test drive a host `fleet-focus` down-message (the chat_bridge push W3 emits). */
function fakeWindow() {
  const listeners = new Set<Listener>()
  const win: WindowLike & { postMessage(data: unknown, origin: string): void } = {
    addEventListener: (_type: string, fn: Listener) => listeners.add(fn),
    removeEventListener: (_type: string, fn: Listener) => listeners.delete(fn),
    // #1522: dispatchSseFocusEvent uses postMessage to re-emit focus data.
    // In the real browser postMessage triggers message event listeners; this
    // fake does the same synchronously for test determinism.
    postMessage: (data: unknown, _origin: string) =>
      listeners.forEach((fn) => fn({ data } as MessageEvent)),
  }
  return {
    win,
    /** Drive a host down-message the way ChatPanel.postMessage → the webview does. */
    drive: (data: unknown) => listeners.forEach((fn) => fn({ data } as MessageEvent)),
    listenerCount: () => listeners.size,
  }
}

const machines: MachineOption[] = [
  { machineId: "A", name: "MacBook Pro", isLocal: true },
  { machineId: "B", name: "Mac Studio", isLocal: false },
  { machineId: "C", name: "Build Server", isLocal: false },
]

describe("new-session machine picker mount — focus delivered over the bridge (#1453 AC1)", () => {
  test("driving the chat_bridge {kind:'fleet-focus', machineId:'B'} defaults the picker to B", () => {
    const bridge = fakeWindow()
    const receiver = createFleetFocusReceiver(bridge.win)

    // W3 (#1451) posts this exact envelope over chat_bridge on focus change.
    bridge.drive({ source: "amicode", kind: "fleet-focus", machineId: "B" })

    // The mount re-reads current focus on mount and feeds it as the default.
    const state = createMachinePickerState({ machines, focusedMachineId: receiver.current() })
    expect(state.selectedMachineId).toBe("B")

    receiver.dispose()
  })

  test("a focus push that arrived BEFORE the picker is built is re-read on mount (best-effort latch)", () => {
    const bridge = fakeWindow()
    const receiver = createFleetFocusReceiver(bridge.win)

    // The push fires first — no picker exists yet (best-effort delivery, not queued).
    bridge.drive({ source: "amicode", kind: "fleet-focus", machineId: "C" })

    // The picker mounts LATER and re-reads current() rather than waiting for a fresh push.
    const state = createMachinePickerState({ machines, focusedMachineId: receiver.current() })
    expect(state.selectedMachineId).toBe("C")

    receiver.dispose()
  })

  test("a home/unfocus push (machineId undefined) defaults the picker to the local machine", () => {
    const bridge = fakeWindow()
    const receiver = createFleetFocusReceiver(bridge.win)

    bridge.drive({ source: "amicode", kind: "fleet-focus", machineId: undefined })

    const state = createMachinePickerState({ machines, focusedMachineId: receiver.current() })
    expect(state.selectedMachineId).toBe("A") // local default, not a bogus focus
    expect(receiver.current()).toBeUndefined()

    receiver.dispose()
  })
})

describe("parseFleetFocusMessage — the fleet-focus envelope (#1451 seam)", () => {
  test("a machineId string is a focus on that machine", () => {
    expect(parseFleetFocusMessage({ source: "amicode", kind: "fleet-focus", machineId: "B" })).toEqual({
      machineId: "B",
    })
  })

  test("machineId undefined is home/unfocus (a valid message, NOT malformed)", () => {
    expect(parseFleetFocusMessage({ source: "amicode", kind: "fleet-focus", machineId: undefined })).toEqual({
      machineId: undefined,
    })
  })

  test("a missing machineId key is also home/unfocus", () => {
    expect(parseFleetFocusMessage({ source: "amicode", kind: "fleet-focus" })).toEqual({ machineId: undefined })
  })

  test("a non-amicode source is not a fleet-focus message", () => {
    expect(parseFleetFocusMessage({ source: "vscode", kind: "fleet-focus", machineId: "B" })).toBeUndefined()
  })

  test("a different amicode kind is not a fleet-focus message", () => {
    expect(parseFleetFocusMessage({ source: "amicode", kind: "preview-file", machineId: "B" })).toBeUndefined()
  })

  test("a non-string, non-undefined machineId is malformed", () => {
    expect(parseFleetFocusMessage({ source: "amicode", kind: "fleet-focus", machineId: 42 })).toBeUndefined()
  })

  test("non-object input is rejected", () => {
    expect(parseFleetFocusMessage(null)).toBeUndefined()
    expect(parseFleetFocusMessage("fleet-focus")).toBeUndefined()
    expect(parseFleetFocusMessage(undefined)).toBeUndefined()
  })
})

describe("machineOptionsFromFleetSessions — build the list from the projection", () => {
  test("groups sessions by amicode_owner into one option per machine", () => {
    const entries: FleetSessionEntry[] = [
      { id: "s1", amicode_owner: { owner_machine_id: "A", owner_name: "MacBook Pro", is_local: true } },
      { id: "s2", amicode_owner: { owner_machine_id: "B", owner_name: "Mac Studio", is_local: false } },
      { id: "s3", amicode_owner: { owner_machine_id: "B", owner_name: "Mac Studio", is_local: false } },
    ]
    expect(machineOptionsFromFleetSessions(entries)).toEqual([
      { machineId: "A", name: "MacBook Pro", isLocal: true },
      { machineId: "B", name: "Mac Studio", isLocal: false },
    ])
  })

  test("preserves is_local and dedupes on first occurrence", () => {
    const entries: FleetSessionEntry[] = [
      { id: "s1", amicode_owner: { owner_machine_id: "B", owner_name: "Mac Studio", is_local: false } },
      { id: "s2", amicode_owner: { owner_machine_id: "A", owner_name: "MacBook Pro", is_local: true } },
    ]
    const opts = machineOptionsFromFleetSessions(entries)
    expect(opts.map((o) => o.machineId)).toEqual(["B", "A"])
    expect(opts.find((o) => o.machineId === "A")?.isLocal).toBe(true)
  })

  test("skips owner-less (pre-fleet / local-path) sessions — no bogus machine", () => {
    const entries: FleetSessionEntry[] = [
      { id: "legacy" },
      { id: "s1", amicode_owner: { owner_machine_id: "B", owner_name: "Mac Studio", is_local: false } },
    ]
    expect(machineOptionsFromFleetSessions(entries)).toEqual([
      { machineId: "B", name: "Mac Studio", isLocal: false },
    ])
  })

  test("an empty projection yields no machines (honest fleet-of-one degrade)", () => {
    expect(machineOptionsFromFleetSessions([])).toEqual([])
  })
})

describe("createFleetFocusReceiver — latch + subscribe (best-effort, re-read on mount)", () => {
  test("current() latches the LATEST focus push", () => {
    const bridge = fakeWindow()
    const receiver = createFleetFocusReceiver(bridge.win)
    expect(receiver.current()).toBeUndefined()

    bridge.drive({ source: "amicode", kind: "fleet-focus", machineId: "B" })
    expect(receiver.current()).toBe("B")

    bridge.drive({ source: "amicode", kind: "fleet-focus", machineId: "C" })
    expect(receiver.current()).toBe("C")

    bridge.drive({ source: "amicode", kind: "fleet-focus", machineId: undefined })
    expect(receiver.current()).toBeUndefined()

    receiver.dispose()
  })

  test("subscribe fires on each effective focus push and unsubscribe stops it", () => {
    const bridge = fakeWindow()
    const receiver = createFleetFocusReceiver(bridge.win)
    const seen: (string | undefined)[] = []
    const off = receiver.subscribe((m) => seen.push(m))

    bridge.drive({ source: "amicode", kind: "fleet-focus", machineId: "B" })
    bridge.drive({ source: "amicode", kind: "fleet-focus", machineId: undefined })
    off()
    bridge.drive({ source: "amicode", kind: "fleet-focus", machineId: "C" })

    expect(seen).toEqual(["B", undefined])
    receiver.dispose()
  })

  test("ignores non-fleet-focus messages (does not clobber the latch)", () => {
    const bridge = fakeWindow()
    const receiver = createFleetFocusReceiver(bridge.win)
    bridge.drive({ source: "amicode", kind: "fleet-focus", machineId: "B" })
    bridge.drive({ source: "amicode", kind: "preview-file", path: "/x" })
    bridge.drive({ source: "vscode", kind: "fleet-focus", machineId: "C" })
    expect(receiver.current()).toBe("B")
    receiver.dispose()
  })

  test("dispose removes the window listener", () => {
    const bridge = fakeWindow()
    const receiver = createFleetFocusReceiver(bridge.win)
    expect(bridge.listenerCount()).toBe(1)
    receiver.dispose()
    expect(bridge.listenerCount()).toBe(0)
  })
})

// ── #1522 AC5 — SSE-sourced focus event feeds the existing latch ────────────
describe("#1522 AC5 — SSE focus frame seeds the picker through the existing latch", () => {
  test("dispatchSseFocusEvent re-emits focused-peer data as a chat_bridge envelope the latch catches", () => {
    const bridge = fakeWindow()
    const receiver = createFleetFocusReceiver(bridge.win)

    // Simulate the SSE amicode.fleet.focus event data (the JSON payload the
    // aggregator writes into the `data:` line of the SSE frame).
    dispatchSseFocusEvent(
      { type: "amicode.fleet.focus", focusedMachineId: "studio", isHome: false, absent: false },
      bridge.win as unknown as Window,
    )

    expect(receiver.current()).toBe("studio")
    receiver.dispose()
  })

  test("dispatchSseFocusEvent with home focus (no machineId) → latch returns undefined (home)", () => {
    const bridge = fakeWindow()
    const receiver = createFleetFocusReceiver(bridge.win)

    dispatchSseFocusEvent(
      { type: "amicode.fleet.focus", isHome: true, absent: false },
      bridge.win as unknown as Window,
    )

    expect(receiver.current()).toBeUndefined()
    receiver.dispose()
  })

  test("dispatchSseFocusEvent with non-focus event is a no-op (latch not clobbered)", () => {
    const bridge = fakeWindow()
    const receiver = createFleetFocusReceiver(bridge.win)

    // Pre-seed with a real focus
    bridge.drive({ source: "amicode", kind: "fleet-focus", machineId: "studio" })
    expect(receiver.current()).toBe("studio")

    // A non-focus SSE event should be ignored
    dispatchSseFocusEvent(
      { type: "session.updated", id: "s1" } as any,
      bridge.win as unknown as Window,
    )

    expect(receiver.current()).toBe("studio") // unchanged
    receiver.dispose()
  })
})
