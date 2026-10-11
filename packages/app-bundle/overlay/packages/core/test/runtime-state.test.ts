import { describe, expect } from "bun:test"
import { Duration, Effect, Layer } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { Database } from "@opencode-ai/core/database/database"
import { RuntimeState } from "@opencode-ai/core/runtime-state"
import { testEffect } from "./lib/effect"

// Each test builds a fresh in-memory database through the scoped layer run,
// so rows never leak between tests.
const storeLayer = Layer.provide(RuntimeState.layer, Database.layerFromPath(":memory:"))
const it = testEffect(storeLayer)

const ownerA = { owner_id: "own_aaaa", pid: 111 }
const ownerB = { owner_id: "own_bbbb", pid: 222 }

describe("RuntimeState", () => {
  it.effect("busy rows are visible on enter and read dead once the TTL lapses", () =>
    Effect.gen(function* () {
      const state = yield* RuntimeState.Service
      yield* state.busyEnter({ sessionID: "ses_busy", owner: ownerA })

      const live = yield* state.busyLive("ses_busy")
      expect(live).toHaveLength(1)
      expect(live[0]!.owner_id).toBe(ownerA.owner_id)
      expect(live[0]!.session_id).toBe("ses_busy")

      // No further heartbeats: the row must read dead within the TTL window.
      yield* TestClock.adjust(Duration.seconds(20))
      expect(yield* state.busyLive("ses_busy")).toEqual([])
    }),
  )

  it.effect("heartbeats keep a busy row live across TTL windows", () =>
    Effect.gen(function* () {
      const state = yield* RuntimeState.Service
      yield* state.busyEnter({ sessionID: "ses_beat", owner: ownerA })

      yield* TestClock.adjust(Duration.seconds(6))
      yield* state.busyHeartbeat({ sessionID: "ses_beat", owner: ownerA })
      // 14s after the last heartbeat: still inside the 15s window.
      yield* TestClock.adjust(Duration.seconds(14))
      expect(yield* state.busyLive("ses_beat")).toHaveLength(1)

      // 2s more: past the window, dead.
      yield* TestClock.adjust(Duration.seconds(2))
      expect(yield* state.busyLive("ses_beat")).toEqual([])
    }),
  )

  it.effect("busy exit removes the owning process's row only", () =>
    Effect.gen(function* () {
      const state = yield* RuntimeState.Service
      yield* state.busyEnter({ sessionID: "ses_exit", owner: ownerA })
      yield* state.busyEnter({ sessionID: "ses_exit", owner: ownerB })
      expect(yield* state.busyLive("ses_exit")).toHaveLength(2)

      yield* state.busyExit({ sessionID: "ses_exit", owner: ownerA })
      const live = yield* state.busyLive("ses_exit")
      expect(live).toHaveLength(1)
      expect(live[0]!.owner_id).toBe(ownerB.owner_id)
    }),
  )

  it.effect("double ownership is visible and both rows carry the advisory conflict marker", () =>
    Effect.gen(function* () {
      const state = yield* RuntimeState.Service
      yield* state.busyEnter({ sessionID: "ses_ghost", owner: ownerA })
      yield* state.busyEnter({ sessionID: "ses_ghost", owner: ownerB })

      const busy = yield* state.busyLive("ses_ghost")
      expect(busy).toHaveLength(2)
      expect(busy.every((row) => row.conflict)).toBe(true)
      expect(new Set(busy.map((row) => row.owner_id))).toEqual(new Set([ownerA.owner_id, ownerB.owner_id]))

      const owners = yield* state.ownersLive("ses_ghost")
      expect(owners).toHaveLength(2)
      expect(owners.every((row) => row.conflict)).toBe(true)
    }),
  )

  it.effect("coordinator registration lives until unregister or TTL", () =>
    Effect.gen(function* () {
      const state = yield* RuntimeState.Service
      yield* state.register({ sessionID: "ses_reg", owner: ownerA })
      expect(yield* state.ownersLive("ses_reg")).toHaveLength(1)

      yield* state.unregister({ sessionID: "ses_reg", owner: ownerA })
      expect(yield* state.ownersLive("ses_reg")).toEqual([])

      // An unregistered-then-re-registered row that stops heartbeating reads dead.
      yield* state.register({ sessionID: "ses_reg", owner: ownerA })
      yield* TestClock.adjust(Duration.seconds(20))
      expect(yield* state.ownersLive("ses_reg")).toEqual([])
    }),
  )

  it.effect("pending rows are recorded, settled idempotently, and expire from the live view at TTL", () =>
    Effect.gen(function* () {
      const state = yield* RuntimeState.Service
      const request = { id: "que_1", sessionID: "ses_q", questions: [] }
      yield* state.recordPending({
        kind: "question",
        id: "que_1",
        sessionID: "ses_q",
        directory: "/work",
        data: request,
        owner: ownerA,
      })

      const live = yield* state.livePending("question")
      expect(live).toHaveLength(1)
      expect(live[0]!.id).toBe("que_1")
      expect(live[0]!.data).toEqual(request)
      expect(live[0]!.directory).toBe("/work")

      // Settle is idempotent: the first settles, the replay keeps the recorded resolution.
      expect(
        yield* state.settlePending({ kind: "question", id: "que_1", state: "replied", resolution: [["One"]] }),
      ).toBe(true)
      expect(
        yield* state.settlePending({ kind: "question", id: "que_1", state: "replied", resolution: [["Two"]] }),
      ).toBe(false)
      const settled = yield* state.getPending("question", "que_1")
      expect(settled?.state).toBe("replied")
      expect(settled?.resolution).toEqual([["One"]])
      expect(yield* state.livePending("question")).toEqual([])

      // The owner's exit cleanup removes the row entirely.
      yield* state.discardPending({ kind: "question", id: "que_1", owner: ownerA })
      expect(yield* state.getPending("question", "que_1")).toBeUndefined()
    }),
  )

  it.effect("a pending row whose owner stopped heartbeating reads dead but the fact stays readable", () =>
    Effect.gen(function* () {
      const state = yield* RuntimeState.Service
      yield* state.recordPending({
        kind: "permission",
        id: "per_1",
        sessionID: "ses_p",
        data: { id: "per_1", sessionID: "ses_p", permission: "bash" },
        owner: ownerA,
      })

      // Heartbeats keep it in the live view…
      yield* TestClock.adjust(Duration.seconds(6))
      yield* state.heartbeatPending({ kind: "permission", id: "per_1", owner: ownerA })
      expect(yield* state.livePending("permission")).toHaveLength(1)

      // …then the owner dies: dead in the live view, but the recorded fact remains.
      yield* TestClock.adjust(Duration.seconds(20))
      expect(yield* state.livePending("permission")).toEqual([])
      expect((yield* state.getPending("permission", "per_1"))?.state).toBe("pending")
    }),
  )
})
