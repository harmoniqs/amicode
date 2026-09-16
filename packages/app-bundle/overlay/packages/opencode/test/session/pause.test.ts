import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Database } from "@opencode-ai/core/database/database"
import { Effect } from "effect"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "@/session/session"
import { SessionPause } from "@/session/pause"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { Snapshot } from "@/snapshot"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances, reloadInstance } from "../fixture/fixture"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const layer = LayerNode.compile(
  LayerNode.group([
    BackgroundJob.node,
    EventV2Bridge.node,
    Session.node,
    SessionProjector.node,
    SessionPause.node,
    SessionRunState.node,
    SessionStatus.node,
    Snapshot.node,
    Database.node,
    RuntimeFlags.node,
  ]),
)

const it = testEffect(layer)

describe("session.pause", () => {
  it.instance("pause marks a session Paused and resumable in durable metadata", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const pause = yield* SessionPause.Service
      const chat = yield* sessions.create({ title: "to-pause" })

      yield* pause.pause(chat.id)

      const marker = yield* pause.marker(chat.id)
      expect(marker?.paused).toBe(true)
      expect(marker?.resumable).toBe(true)
      expect(yield* pause.isPaused(chat.id)).toBe(true)
    }),
  )

  it.instance("paused state is distinct from idle, busy, and error", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const pause = yield* SessionPause.Service
      const status = yield* SessionStatus.Service
      const chat = yield* sessions.create({ title: "distinct" })

      // Not paused before the pause action.
      expect(yield* pause.isPaused(chat.id)).toBe(false)

      yield* pause.pause(chat.id)

      // Paused is its own durable fact, not a SessionStatus value (which stays
      // in the upstream idle/busy/retry union). idle/busy/error never read as paused.
      expect(yield* pause.isPaused(chat.id)).toBe(true)
      const s = yield* status.get(chat.id)
      expect(s.type).not.toBe("busy")
    }),
  )

  it.instance("Paused marker survives a simulated engine restart", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const pause = yield* SessionPause.Service
      const test = yield* TestInstance
      const chat = yield* sessions.create({ title: "durable" })

      yield* pause.pause(chat.id)

      // Simulate an engine restart: invalidate all in-memory instance state so
      // the next read comes from persisted storage, not a warm cache.
      yield* reloadInstance({ directory: test.directory })

      expect(yield* pause.isPaused(chat.id)).toBe(true)
      const marker = yield* pause.marker(chat.id)
      expect(marker?.resumable).toBe(true)
    }),
  )

  it.instance("resume with no steer clears the Paused marker", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const pause = yield* SessionPause.Service
      const chat = yield* sessions.create({ title: "resume-plain" })

      yield* pause.pause(chat.id)
      const outcome = yield* pause.resume(chat.id)

      expect(outcome.steer).toBeUndefined()
      expect(yield* pause.isPaused(chat.id)).toBe(false)
      expect(yield* pause.marker(chat.id)).toBeUndefined()
    }),
  )

  it.instance("resume with a steer message returns the steer and clears the marker", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const pause = yield* SessionPause.Service
      const chat = yield* sessions.create({ title: "resume-steer" })

      yield* pause.pause(chat.id)
      const outcome = yield* pause.resume(chat.id, "actually, focus on the cache key")

      expect(outcome.steer).toBe("actually, focus on the cache key")
      expect(yield* pause.isPaused(chat.id)).toBe(false)
    }),
  )

  it.instance("pausing a session with no running turn is a benign, idempotent no-op", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const pause = yield* SessionPause.Service
      const chat = yield* sessions.create({ title: "idle-pause" })

      // No running turn: pause must not error, and must be idempotent.
      yield* pause.pause(chat.id)
      yield* pause.pause(chat.id)

      expect(yield* pause.isPaused(chat.id)).toBe(true)
    }),
  )

  it.instance("Stop (abort) settles distinctly from Pause and does not leave a resumable marker", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const pause = yield* SessionPause.Service
      const runState = yield* SessionRunState.Service
      const chat = yield* sessions.create({ title: "stop-vs-pause" })

      // A hard Stop routes through the existing cancel path and never marks the
      // session resumable — it is not discoverable as Paused.
      yield* runState.cancel(chat.id)

      expect(yield* pause.isPaused(chat.id)).toBe(false)
    }),
  )

  it.instance("pause does not settle the session as idle-done — Paused is never silently read as done", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const pause = yield* SessionPause.Service
      const chat = yield* sessions.create({ title: "not-done" })

      yield* pause.pause(chat.id)

      // The durable marker is the source of truth: a caller checking "is this
      // resumable?" gets true, so no surface can silently treat it as finished.
      const marker = yield* pause.marker(chat.id)
      expect(marker?.paused).toBe(true)
      expect(marker?.resumable).toBe(true)
    }),
  )
})
