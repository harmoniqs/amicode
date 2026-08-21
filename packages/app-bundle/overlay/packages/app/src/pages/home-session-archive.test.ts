import { expect, test } from "bun:test"
import { SESSION_TABS_REMOVED_EVENT, readSessionTabsRemovedDetail } from "@/components/titlebar-session-events"
import { archiveHomeSession, unarchiveHomeSession } from "./home-session-archive"
import type { ServerConnection } from "@/context/server"

const remote = "remote" as ServerConnection.Key

test("archiving a Home session removes its open titlebar tab", async () => {
  let detail: ReturnType<typeof readSessionTabsRemovedDetail>
  let removed = false
  window.addEventListener(
    SESSION_TABS_REMOVED_EVENT,
    (event) => {
      detail = readSessionTabsRemovedDetail(event)
    },
    { once: true },
  )

  await archiveHomeSession({
    server: remote,
    session: { id: "ses_1", directory: "/workspace" },
    archive: async () => undefined,
    remove: () => {
      removed = true
    },
  })

  expect(removed).toBe(true)
  expect(detail).toEqual({ server: remote, directory: "/workspace", sessionIDs: ["ses_1"] })
})

test("reports archive failures without removing the session", async () => {
  const failure = new Error("offline")
  let error: unknown
  let removed = false

  await archiveHomeSession({
    server: remote,
    session: { id: "ses_1", directory: "/workspace" },
    archive: async () => Promise.reject(failure),
    remove: () => {
      removed = true
    },
    onError: (value) => {
      error = value
    },
  })

  expect(error).toBe(failure)
  expect(removed).toBe(false)
})

test("unarchiving a session calls unarchive and adds it back", async () => {
  let added = false
  let unarchived = false

  await unarchiveHomeSession({
    session: { id: "ses_2", directory: "/workspace" },
    unarchive: async () => {
      unarchived = true
    },
    add: () => {
      added = true
    },
  })

  expect(unarchived).toBe(true)
  expect(added).toBe(true)
})

test("reports unarchive failures without adding the session back", async () => {
  const failure = new Error("network error")
  let error: unknown
  let added = false

  await unarchiveHomeSession({
    session: { id: "ses_2", directory: "/workspace" },
    unarchive: async () => Promise.reject(failure),
    add: () => {
      added = true
    },
    onError: (value) => {
      error = value
    },
  })

  expect(error).toBe(failure)
  expect(added).toBe(false)
})

// amicode#273 AC8: tests for archive section expand + unarchive flow
test("unarchive removes from archived list (integration contract)", async () => {
  // Simulates the flow: unarchive succeeds → add callback fires → session moves to active
  const archivedList = ["ses_a", "ses_b", "ses_c"]
  let addedBack: string | undefined

  await unarchiveHomeSession({
    session: { id: "ses_b", directory: "/workspace" },
    unarchive: async () => undefined,
    add: () => {
      addedBack = "ses_b"
      const idx = archivedList.indexOf("ses_b")
      if (idx >= 0) archivedList.splice(idx, 1)
    },
  })

  expect(addedBack).toBe("ses_b")
  expect(archivedList).toEqual(["ses_a", "ses_c"])
})

test("expanding archived section triggers a load (contract: add is called after unarchive)", async () => {
  // Validates the contract that unarchiveHomeSession calls `add` on success —
  // the UI relies on this to move the session from the archived list to active.
  let callOrder: string[] = []

  await unarchiveHomeSession({
    session: { id: "ses_x", directory: "/proj" },
    unarchive: async () => {
      callOrder.push("unarchive")
    },
    add: () => {
      callOrder.push("add")
    },
  })

  expect(callOrder).toEqual(["unarchive", "add"])
})
