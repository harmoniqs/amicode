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
})
