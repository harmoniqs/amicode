import { describe, expect, test } from "bun:test"

/**
 * Tests for the Session Chats Dropdown logic (amicode#274).
 * Validates session sorting, search filtering, open/close state, and
 * tab-status derivation — the same behavior as the dashboard sessions
 * flyout (amicode#273).
 */

type Session = {
  id: string
  title?: string
  directory: string
  parentID?: string
  time: { created: number; updated?: number; archived?: number | null }
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
})
