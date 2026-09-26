import { afterEach, describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import {
  claimPortalMount,
  isPortalOwner,
  releasePortalMount,
  _resetPortalRegistry,
} from "./titlebar-portal-registry"

afterEach(() => {
  _resetPortalRegistry()
})

describe("#1577 titlebar portal dedup — registry core", () => {
  test("claimPortalMount returns a unique token on each call", () => {
    const t1 = claimPortalMount("sessions")
    const t2 = claimPortalMount("sessions")
    const t3 = claimPortalMount("status")
    expect(t1).not.toBe(t2)
    expect(t2).not.toBe(t3)
    expect(t1).not.toBe(t3)
  })

  test("the latest claimant is the owner — prior claimant is not", () => {
    createRoot((dispose) => {
      const t1 = claimPortalMount("sessions")
      expect(isPortalOwner("sessions", t1)).toBe(true)

      // A second claim ejects the first
      const t2 = claimPortalMount("sessions")
      expect(isPortalOwner("sessions", t2)).toBe(true)
      expect(isPortalOwner("sessions", t1)).toBe(false)
      dispose()
    })
  })

  test("different mount points are independent", () => {
    createRoot((dispose) => {
      const tSessions = claimPortalMount("sessions")
      const tStatus = claimPortalMount("status")
      expect(isPortalOwner("sessions", tSessions)).toBe(true)
      expect(isPortalOwner("status", tStatus)).toBe(true)

      // Claiming sessions again doesn't affect status
      const tSessions2 = claimPortalMount("sessions")
      expect(isPortalOwner("sessions", tSessions2)).toBe(true)
      expect(isPortalOwner("sessions", tSessions)).toBe(false)
      expect(isPortalOwner("status", tStatus)).toBe(true) // unchanged
      dispose()
    })
  })

  test("releasePortalMount clears ownership when token matches", () => {
    createRoot((dispose) => {
      const t1 = claimPortalMount("sessions")
      expect(isPortalOwner("sessions", t1)).toBe(true)

      releasePortalMount("sessions", t1)
      expect(isPortalOwner("sessions", t1)).toBe(false)
      dispose()
    })
  })

  test("releasePortalMount is a no-op when token is stale", () => {
    createRoot((dispose) => {
      const t1 = claimPortalMount("side-panel")
      const t2 = claimPortalMount("side-panel")

      // t1 is stale — releasing it must NOT eject t2
      releasePortalMount("side-panel", t1)
      expect(isPortalOwner("side-panel", t2)).toBe(true)
      dispose()
    })
  })
})

describe("#1577 AC2 — repeated focus switches never accumulate owners", () => {
  test("cycling claim/release simulating local↔remote↔local always has exactly one owner", () => {
    createRoot((dispose) => {
      const ids = ["sessions", "status", "side-panel"] as const

      // Simulate 5 focus switches (new SessionHeader mounts, old unmounts)
      let prevTokens: number[] = []
      for (let i = 0; i < 5; i++) {
        // Release previous tokens (old component's onCleanup)
        for (let j = 0; j < prevTokens.length; j++) {
          releasePortalMount(ids[j], prevTokens[j])
        }

        // Claim all three mount points (new component mounts)
        const newTokens = ids.map((id) => claimPortalMount(id))

        // Exactly one owner per mount point
        for (let j = 0; j < ids.length; j++) {
          expect(isPortalOwner(ids[j], newTokens[j])).toBe(true)
        }

        prevTokens = newTokens
      }
      dispose()
    })
  })

  test("concurrent mount (startTransition): new claim ejects old before old cleans up", () => {
    createRoot((dispose) => {
      // Simulate: old SessionHeader is still mounted, new one mounts
      const oldToken = claimPortalMount("sessions")
      expect(isPortalOwner("sessions", oldToken)).toBe(true)

      // New SessionHeader mounts — claims the same mount point
      const newToken = claimPortalMount("sessions")
      expect(isPortalOwner("sessions", newToken)).toBe(true)
      expect(isPortalOwner("sessions", oldToken)).toBe(false)

      // Eventually old SessionHeader unmounts — release is a no-op
      releasePortalMount("sessions", oldToken)
      expect(isPortalOwner("sessions", newToken)).toBe(true) // still owner
      dispose()
    })
  })
})

describe("#1577 AC1 — ownership transfer gives exactly one winner per mount", () => {
  test("isPortalOwner returns false for a stale token immediately after a new claim", () => {
    createRoot((dispose) => {
      const t1 = claimPortalMount("sessions")
      expect(isPortalOwner("sessions", t1)).toBe(true)

      // Simulate a second SessionHeader mounting — claims the same point
      const t2 = claimPortalMount("sessions")
      // Stale token loses, new token wins — the read is instant
      expect(isPortalOwner("sessions", t1)).toBe(false)
      expect(isPortalOwner("sessions", t2)).toBe(true)
      dispose()
    })
  })

  test("all three session-scoped mount points transfer ownership atomically", () => {
    createRoot((dispose) => {
      const ids = ["sessions", "status", "side-panel"] as const

      // Old SessionHeader claims all three
      const oldTokens = ids.map((id) => claimPortalMount(id))
      for (let i = 0; i < ids.length; i++) {
        expect(isPortalOwner(ids[i], oldTokens[i])).toBe(true)
      }

      // New SessionHeader claims all three — old loses everywhere
      const newTokens = ids.map((id) => claimPortalMount(id))
      for (let i = 0; i < ids.length; i++) {
        expect(isPortalOwner(ids[i], oldTokens[i])).toBe(false)
        expect(isPortalOwner(ids[i], newTokens[i])).toBe(true)
      }
      dispose()
    })
  })
})

describe("#1577 session-header wiring — the registry is consumed", () => {
  test("session-header imports and uses the portal registry for claim/release/ownership", async () => {
    const { readFileSync } = await import("node:fs")
    const { resolve } = await import("node:path")
    const source = readFileSync(resolve(__dirname, "session/session-header.tsx"), "utf8")

    // Must import the registry
    expect(source).toContain("claimPortalMount")
    expect(source).toContain("isPortalOwner")
    expect(source).toContain("releasePortalMount")

    // Must claim the three session-scoped mount points
    expect(source).toContain('claimPortalMount("sessions")')
    expect(source).toContain('claimPortalMount("status")')
    expect(source).toContain('claimPortalMount("side-panel")')

    // Must gate portal rendering on ownership
    expect(source).toContain('isPortalOwner("sessions"')
    expect(source).toContain('isPortalOwner("status"')
    expect(source).toContain('isPortalOwner("side-panel"')

    // Must release on cleanup
    expect(source).toContain("releasePortalMount(")
    expect(source).toContain("onCleanup(")
  })
})

describe("#1577 AC3 — no net-new /event subscriber", () => {
  test("the registry module does not import event, fetch, or subscription machinery", async () => {
    // Source-string assertion: the registry is pure signals + Map,
    // no network or event-bus imports
    const { readFileSync } = await import("node:fs")
    const { resolve } = await import("node:path")
    const source = readFileSync(resolve(__dirname, "titlebar-portal-registry.ts"), "utf8")

    expect(source).not.toContain("addEventListener")
    expect(source).not.toContain("EventSource")
    expect(source).not.toContain("/event")
    expect(source).not.toContain("fetch(")
    expect(source).not.toContain("createResource")
    expect(source).not.toContain("useServer")
  })
})
