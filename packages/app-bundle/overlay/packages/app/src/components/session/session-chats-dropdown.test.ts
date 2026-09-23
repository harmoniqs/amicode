import { describe, expect, test } from "bun:test"

/**
 * Tests for the Session Chats Dropdown logic (amicode#274).
 * Validates session sorting, search filtering, open/close state, and
 * tab-status derivation — the same behavior as the dashboard sessions
 * flyout (amicode#273).
 */

type SessionOwnerTag = {
  owner_machine_id: string
  owner_name: string
  device_type?: string
  directory?: string
  is_local: boolean
}

type Session = {
  id: string
  title?: string
  directory: string
  parentID?: string
  time: { created: number; updated?: number; archived?: number | null }
  /** Fleet-wide owner overlay (#1439 — absent on pre-fleet sessions). */
  amicode_owner?: SessionOwnerTag
}

// --- Helpers under test (pure logic extracted from the component) ---

/** Sort sessions: open-tab sessions first, preserving relative order within each group. */
function sortSessionsByOpenTab(
  sessions: Session[],
  hasOpenTab: (session: Session) => boolean,
): Session[] {
  const open: Session[] = []
  const rest: Session[] = []
  for (const session of sessions) {
    if (hasOpenTab(session)) {
      open.push(session)
    } else {
      rest.push(session)
    }
  }
  return [...open, ...rest]
}

/** Filter sessions by search query (matches title or id). */
function filterSessionsByQuery(
  sessions: Session[],
  query: string,
  getTitle: (session: Session) => string,
): Session[] {
  const q = query.trim().toLowerCase()
  if (!q) return sessions
  return sessions.filter((session) => getTitle(session).toLowerCase().includes(q))
}

/** Derive the machine badge label for a session (#1439).
 *  Local sessions are unbadged (absence = local, ADR 0031 §D6);
 *  remote sessions show the owner's name as the badge. */
function deriveBadge(session: Session): string | undefined {
  if (!session.amicode_owner) return undefined
  if (session.amicode_owner.is_local) return undefined
  return session.amicode_owner.owner_name
}

/** Filter sessions to a specific machine (#1439).
 *  null/undefined = all machines (the "clear" state). */
function filterSessionsByMachine(
  sessions: Session[],
  machineId: string | null | undefined,
): Session[] {
  if (machineId == null) return sessions
  return sessions.filter(
    (s) => s.amicode_owner?.owner_machine_id === machineId,
  )
}

/**
 * Simulates the flyout open/close state machine — the same pattern used
 * in the component. Verifies the toggle works and the dismiss handler
 * (outside click / Escape) doesn't race with the opening click.
 */
function createFlyoutState() {
  let open = false
  let dismissListener: ((e: { target: unknown }) => void) | null = null
  const flyoutRoot = { contains: (target: unknown) => target === "inside" }

  return {
    get open() { return open },
    toggle() { open = !open },
    /** Simulates the deferred dismiss listener attachment (setTimeout(0)) */
    attachDismissListener() {
      if (!open) { dismissListener = null; return }
      dismissListener = (e) => {
        if (!flyoutRoot.contains(e.target)) open = false
      }
    },
    /** Simulates a mousedown event after the listener is attached */
    simulateOutsideClick() { dismissListener?.({ target: "outside" }) },
    simulateInsideClick() { dismissListener?.({ target: "inside" }) },
  }
}

// --- Tests ---

describe("Session Chats Dropdown", () => {
  const sessions: Session[] = [
    { id: "ses_1", title: "X gate optimization", directory: "/proj", time: { created: 100 } },
    { id: "ses_2", title: "CZ gate", directory: "/proj", time: { created: 200 } },
    { id: "ses_3", title: "Cat state prep", directory: "/proj", time: { created: 300 } },
  ]

  describe("open/close state", () => {
    test("toggle opens the flyout", () => {
      const state = createFlyoutState()
      expect(state.open).toBe(false)
      state.toggle()
      expect(state.open).toBe(true)
    })

    test("toggle closes when already open", () => {
      const state = createFlyoutState()
      state.toggle() // open
      state.toggle() // close
      expect(state.open).toBe(false)
    })

    test("dismiss listener does NOT fire before attachment (deferred)", () => {
      const state = createFlyoutState()
      state.toggle() // open
      // Before attachDismissListener, an outside click should NOT close
      state.simulateOutsideClick()
      expect(state.open).toBe(true)
    })

    test("dismiss listener closes on outside click after attachment", () => {
      const state = createFlyoutState()
      state.toggle() // open
      state.attachDismissListener() // simulates the setTimeout(0) firing
      state.simulateOutsideClick()
      expect(state.open).toBe(false)
    })

    test("dismiss listener does NOT close on inside click", () => {
      const state = createFlyoutState()
      state.toggle() // open
      state.attachDismissListener()
      state.simulateInsideClick()
      expect(state.open).toBe(true)
    })
  })

  describe("sortSessionsByOpenTab", () => {
    test("moves sessions with open tabs to the front", () => {
      const openIds = new Set(["ses_2"])
      const sorted = sortSessionsByOpenTab(sessions, (s) => openIds.has(s.id))

      expect(sorted[0].id).toBe("ses_2")
      expect(sorted.slice(1).map((s) => s.id)).toEqual(["ses_1", "ses_3"])
    })

    test("preserves order when no sessions have open tabs", () => {
      const sorted = sortSessionsByOpenTab(sessions, () => false)
      expect(sorted.map((s) => s.id)).toEqual(["ses_1", "ses_2", "ses_3"])
    })

    test("preserves order when all sessions have open tabs", () => {
      const sorted = sortSessionsByOpenTab(sessions, () => true)
      expect(sorted.map((s) => s.id)).toEqual(["ses_1", "ses_2", "ses_3"])
    })
  })

  describe("filterSessionsByQuery", () => {
    const getTitle = (s: Session) => s.title || s.id

    test("returns all sessions when query is empty", () => {
      const result = filterSessionsByQuery(sessions, "", getTitle)
      expect(result).toHaveLength(3)
    })

    test("filters by title substring (case-insensitive)", () => {
      const result = filterSessionsByQuery(sessions, "gate", getTitle)
      expect(result.map((s) => s.id)).toEqual(["ses_1", "ses_2"])
    })

    test("filters by session id when title is missing", () => {
      const noTitleSessions: Session[] = [
        { id: "ses_abc", directory: "/proj", time: { created: 100 } },
        { id: "ses_xyz", directory: "/proj", time: { created: 200 } },
      ]
      const result = filterSessionsByQuery(noTitleSessions, "abc", getTitle)
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe("ses_abc")
    })

    test("returns empty when nothing matches", () => {
      const result = filterSessionsByQuery(sessions, "nonexistent", getTitle)
      expect(result).toHaveLength(0)
    })

    test("trims whitespace from query", () => {
      const result = filterSessionsByQuery(sessions, "  cat  ", getTitle)
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe("ses_3")
    })
  })

  describe("openSession navigation strategy", () => {
    /**
     * Opening a session must use direct navigate() — NOT tabs.openPath/addSessionTab.
     * tabs.addSessionTab wraps in startTransition, which keeps both old and new UI
     * mounted during the transition, causing Portal-rendered buttons to duplicate.
     *
     * The correct strategy:
     * - Session with existing tab → select the tab (no navigation, no transition)
     * - Session without a tab → navigate directly (the session page creates its own tab)
     * - In both cases, close the flyout BEFORE any navigation
     */
    type NavigationAction =
      | { type: "select-tab"; sessionId: string }
      | { type: "navigate"; path: string }

    function resolveOpenAction(
      session: Session,
      hasExistingTab: boolean,
      encodePath: (dir: string, id: string) => string,
    ): NavigationAction {
      if (hasExistingTab) {
        return { type: "select-tab", sessionId: session.id }
      }
      return { type: "navigate", path: encodePath(session.directory, session.id) }
    }

    const encodePath = (dir: string, id: string) => `/${btoa(dir)}/session/${id}`

    test("session with existing tab → select-tab (no startTransition)", () => {
      const session = sessions[0]
      const action = resolveOpenAction(session, true, encodePath)

      expect(action.type).toBe("select-tab")
      expect((action as { type: "select-tab"; sessionId: string }).sessionId).toBe("ses_1")
    })

    test("session without existing tab → navigate directly (avoids startTransition)", () => {
      const session = sessions[0]
      const action = resolveOpenAction(session, false, encodePath)

      expect(action.type).toBe("navigate")
      expect((action as { type: "navigate"; path: string }).path).toBe(`/${btoa("/proj")}/session/ses_1`)
    })

    test("flyout closes before navigation (prevents portal duplication)", () => {
      const state = createFlyoutState()
      state.toggle() // open
      expect(state.open).toBe(true)

      // Simulate openSession: close first, then navigate
      state.toggle() // close
      const action = resolveOpenAction(sessions[0], false, encodePath)

      expect(state.open).toBe(false) // flyout closed BEFORE navigation
      expect(action.type).toBe("navigate") // would navigate after close
    })
  })

  // ── fleet-wide machine badges (#1439, AC2) ─────────────────────────────────

  describe("deriveBadge — machine badge for fleet sessions", () => {
    const localSession: Session = {
      id: "ses_local",
      title: "Local work",
      directory: "/proj",
      time: { created: 100 },
      amicode_owner: {
        owner_machine_id: "macbook-pro",
        owner_name: "MacBook Pro",
        device_type: "laptop",
        is_local: true,
      },
    }

    const remoteSession: Session = {
      id: "ses_remote",
      title: "Remote work",
      directory: "/proj",
      time: { created: 200 },
      amicode_owner: {
        owner_machine_id: "mac-studio",
        owner_name: "Mac Studio",
        device_type: "desktop",
        is_local: false,
      },
    }

    const preFleetsession: Session = {
      id: "ses_old",
      title: "Legacy",
      directory: "/proj",
      time: { created: 50 },
      // no amicode_owner — pre-fleet session
    }

    test("local session is unbadged (absence = local)", () => {
      expect(deriveBadge(localSession)).toBeUndefined()
    })

    test("remote session shows the owner machine name as badge", () => {
      expect(deriveBadge(remoteSession)).toBe("Mac Studio")
    })

    test("pre-fleet session (no owner tag) is unbadged", () => {
      expect(deriveBadge(preFleetsession)).toBeUndefined()
    })
  })

  // ── per-machine filter (#1439, AC3) ────────────────────────────────────────

  describe("filterSessionsByMachine — per-machine narrowing", () => {
    const fleetSessions: Session[] = [
      {
        id: "ses_a",
        title: "Local session",
        directory: "/proj",
        time: { created: 100 },
        amicode_owner: { owner_machine_id: "macbook", owner_name: "MacBook", is_local: true },
      },
      {
        id: "ses_b",
        title: "Studio session 1",
        directory: "/proj",
        time: { created: 200 },
        amicode_owner: { owner_machine_id: "mac-studio", owner_name: "Mac Studio", is_local: false },
      },
      {
        id: "ses_c",
        title: "Studio session 2",
        directory: "/proj",
        time: { created: 300 },
        amicode_owner: { owner_machine_id: "mac-studio", owner_name: "Mac Studio", is_local: false },
      },
      {
        id: "ses_d",
        title: "Mini session",
        directory: "/proj",
        time: { created: 400 },
        amicode_owner: { owner_machine_id: "mac-mini", owner_name: "Mac Mini", is_local: false },
      },
    ]

    test("null machineId returns all sessions (the 'all machines' state)", () => {
      expect(filterSessionsByMachine(fleetSessions, null)).toHaveLength(4)
    })

    test("undefined machineId returns all sessions (the 'clear filter' state)", () => {
      expect(filterSessionsByMachine(fleetSessions, undefined)).toHaveLength(4)
    })

    test("a specific machineId narrows to that machine's sessions only", () => {
      const studio = filterSessionsByMachine(fleetSessions, "mac-studio")
      expect(studio).toHaveLength(2)
      expect(studio.every((s) => s.amicode_owner?.owner_machine_id === "mac-studio")).toBe(true)
    })

    test("the local machine's sessions are filterable by its machine_id", () => {
      const local = filterSessionsByMachine(fleetSessions, "macbook")
      expect(local).toHaveLength(1)
      expect(local[0].id).toBe("ses_a")
    })

    test("a machineId with no sessions returns an empty list", () => {
      expect(filterSessionsByMachine(fleetSessions, "nonexistent")).toHaveLength(0)
    })

    test("filter composes with filterSessionsByQuery", () => {
      const getTitle = (s: Session) => s.title || s.id
      const studioSessions = filterSessionsByMachine(fleetSessions, "mac-studio")
      const searched = filterSessionsByQuery(studioSessions, "session 2", getTitle)
      expect(searched).toHaveLength(1)
      expect(searched[0].id).toBe("ses_c")
    })
  })
})
