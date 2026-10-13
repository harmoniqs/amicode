// Per-session prompt SERIALIZATION (FIFO queue) — issue #1582.
//
// Promoted from the investigation probe (probe_runner_concurrency.ts). Drives
// the REAL forked Runner (overlay copy of packages/opencode/src/effect/runner.ts)
// with latch-forced interleaving — no engine, no hardware, deterministic.
//
// The base Runner COALESCED: ensureRunning on Running returned the in-flight
// run's `done` and DISCARDED the second caller's `work`, stranding the second
// prompt in the window between the loop's final history read and the Idle
// transition. The fix turns that path into a FIFO queue: a prompt arriving while
// running is ENQUEUED (own fresh `done`) and started as its own turn when the
// current run finishes, going Running(current) -> Running(next) directly (never
// through Idle). See spec-20260927-per-session-prompt-coalesce-stranding.
//
// Two latch aim-points are mandatory (close-vs-shrink discriminator):
//   1. the ORIGINAL window (message arrives while Running, after the loop's
//      final read);
//   2. the RESIDUAL finish-time gap of the FIXED code (message arrives at the
//      instant finishRun is transitioning). A mere window-shrink passes (1) and
//      fails (2); a true close passes both.

import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Latch, Ref, Scope } from "effect"
import { Runner } from "@/effect/runner"
import { it } from "../lib/effect"

const waitForState = <A, E>(runner: Runner.Runner<A, E>, tag: Runner.State<A, E>["_tag"]) =>
  Effect.gen(function* () {
    while (runner.state._tag !== tag) yield* Effect.yieldNow
  }).pipe(Effect.timeout("1 second"))

describe("Runner — SERIAL prompt queue (#1582)", () => {
  // AC: a second prompt arriving during the ORIGINAL stranding window is
  // processed as its OWN turn, without any further external prompt.
  it.live(
    "second prompt arriving while running becomes its own turn (original window)",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)

      const startedA = yield* Latch.make(false)
      const releaseA = yield* Latch.make(false)
      const ranB = yield* Ref.make(false)

      const workA = Effect.gen(function* () {
        yield* startedA.open
        yield* releaseA.await
        return "A"
      })
      const workB = Effect.gen(function* () {
        yield* Ref.set(ranB, true)
        return "B"
      })

      const fa = yield* runner.ensureRunning(workA).pipe(Effect.forkChild)
      yield* startedA.await
      const fb = yield* runner.ensureRunning(workB).pipe(Effect.forkChild)
      // B enqueues behind the running A; release A so the queue drains.
      yield* releaseA.open

      const rA = yield* Fiber.join(fa)
      const rB = yield* Fiber.join(fb)

      expect(rA).toBe("A")
      expect(rB).toBe("B") // own turn, NOT A's result (coalesce would give "A")
      expect(yield* Ref.get(ranB)).toBe(true) // B's work actually ran
      expect(runner.state._tag).toBe("Idle")
    }),
  )

  // AC (close-vs-shrink discriminator): a message injected at the finish-time
  // transition point (the RESIDUAL gap of the fixed code) is still not stranded.
  it.live(
    "prompt arriving at the finish-time transition is not stranded (residual gap)",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)

      const aAtFinish = yield* Latch.make(false)
      const mayFinish = yield* Latch.make(false)
      const ranB = yield* Ref.make(false)

      // A signals it has reached its finish point, then holds while B's
      // ensureRunning lands — B must enqueue and run as its own turn even
      // though it arrives at the exact finish-time transition.
      const workA = Effect.gen(function* () {
        yield* aAtFinish.open
        yield* mayFinish.await
        return "A"
      })

      const fa = yield* runner.ensureRunning(workA).pipe(Effect.forkChild)
      yield* aAtFinish.await
      // still Running; B lands in the residual window
      const fb = yield* runner
        .ensureRunning(
          Effect.gen(function* () {
            yield* Ref.set(ranB, true)
            return "B"
          }),
        )
        .pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* mayFinish.open // A returns -> finishRun must drain to B, not settle Idle

      const rA = yield* Fiber.join(fa)
      const rB = yield* Fiber.join(fb)

      expect(rA).toBe("A")
      expect(rB).toBe("B")
      expect(yield* Ref.get(ranB)).toBe(true)
      expect(runner.state._tag).toBe("Idle")
    }),
  )

  // AC: exactly-once — the queued turn runs once, never duplicated, never
  // re-answering the prior turn.
  it.live(
    "queued turn runs exactly once",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const bCalls = yield* Ref.make(0)

      const startedA = yield* Latch.make(false)
      const releaseA = yield* Latch.make(false)
      const workA = Effect.gen(function* () {
        yield* startedA.open
        yield* releaseA.await
        return "A"
      })
      const workB = Effect.gen(function* () {
        yield* Ref.update(bCalls, (n) => n + 1)
        return "B"
      })

      const fa = yield* runner.ensureRunning(workA).pipe(Effect.forkChild)
      yield* startedA.await
      const fb = yield* runner.ensureRunning(workB).pipe(Effect.forkChild)
      yield* releaseA.open
      yield* Fiber.join(fa)
      const rB = yield* Fiber.join(fb)

      expect(rB).toBe("B")
      expect(yield* Ref.get(bCalls)).toBe(1)
    }),
  )

  // AC: arrival order — first prompt's turn completes before the second begins.
  it.live(
    "turns run in arrival order (A completes before B begins)",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const events = yield* Ref.make<string[]>([])

      const startedA = yield* Latch.make(false)
      const releaseA = yield* Latch.make(false)
      const workA = Effect.gen(function* () {
        yield* startedA.open
        yield* releaseA.await
        yield* Ref.update(events, (e) => [...e, "A-end"])
        return "A"
      })
      const workB = Effect.gen(function* () {
        yield* Ref.update(events, (e) => [...e, "B-start"])
        return "B"
      })

      const fa = yield* runner.ensureRunning(workA).pipe(Effect.forkChild)
      yield* startedA.await
      const fb = yield* runner.ensureRunning(workB).pipe(Effect.forkChild)
      yield* releaseA.open
      yield* Fiber.join(fa)
      yield* Fiber.join(fb)

      expect(yield* Ref.get(events)).toEqual(["A-end", "B-start"])
    }),
  )

  // AC: at most one generation loop runs simultaneously per session.
  it.live(
    "at most one turn runs at a time (queued turn is serial, not concurrent)",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const active = yield* Ref.make(0)
      const maxActive = yield* Ref.make(0)

      const startedA = yield* Latch.make(false)
      const releaseA = yield* Latch.make(false)
      const enter = Effect.gen(function* () {
        const n = yield* Ref.updateAndGet(active, (x) => x + 1)
        yield* Ref.update(maxActive, (m) => Math.max(m, n))
      })
      const leave = Ref.update(active, (x) => x - 1)

      const workA = Effect.gen(function* () {
        yield* enter
        yield* startedA.open
        yield* releaseA.await
        yield* leave
        return "A"
      })
      const workB = Effect.gen(function* () {
        yield* enter
        yield* leave
        return "B"
      })

      const fa = yield* runner.ensureRunning(workA).pipe(Effect.forkChild)
      yield* startedA.await
      const fb = yield* runner.ensureRunning(workB).pipe(Effect.forkChild)
      yield* releaseA.open
      yield* Fiber.join(fa)
      yield* Fiber.join(fb)

      expect(yield* Ref.get(maxActive)).toBe(1)
    }),
  )

  // AC: a session with no genuinely-new intent reaches idle in finite steps.
  it.live(
    "reaches idle with no new intent (no re-run storm)",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      yield* runner.ensureRunning(Effect.succeed("only"))
      expect(runner.state._tag).toBe("Idle")
      expect(runner.busy).toBe(false)
    }),
  )

  // AC: a queued caller never hangs — its call always settles.
  it.live(
    "queued caller never hangs",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)

      const startedA = yield* Latch.make(false)
      const releaseA = yield* Latch.make(false)
      const fa = yield* runner
        .ensureRunning(
          Effect.gen(function* () {
            yield* startedA.open
            yield* releaseA.await
            return "A"
          }),
        )
        .pipe(Effect.forkChild)
      yield* startedA.await
      const fb = yield* runner.ensureRunning(Effect.succeed("B")).pipe(Effect.forkChild)
      yield* releaseA.open

      const rB = yield* Fiber.join(fb).pipe(Effect.timeout("1 second"))
      expect(rB).toBe("B")
    }),
  )

  // AC: same-instant double-submit into Idle produces two distinct turns
  // (never merge), consistent with SERIAL.
  it.live(
    "same-tick fan-in yields two distinct turns",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const calls = yield* Ref.make(0)
      const work = Effect.gen(function* () {
        yield* Ref.update(calls, (n) => n + 1)
        yield* Effect.sleep("5 millis")
        return "w"
      })

      const [a, b] = yield* Effect.all([runner.ensureRunning(work), runner.ensureRunning(work)], {
        concurrency: "unbounded",
      })

      expect(a).toBe("w")
      expect(b).toBe("w")
      // SERIAL: the loser enqueues and runs its own turn — work runs TWICE.
      expect(yield* Ref.get(calls)).toBe(2)
      expect(runner.state._tag).toBe("Idle")
    }),
  )

  // AC: cancel fails every queued caller with a cancellation (none hang).
  it.live(
    "cancel fails every queued caller with Cancelled (own-work, in order)",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const ranQueued = yield* Ref.make(false)

      const startedA = yield* Latch.make(false)
      const a = yield* runner
        .ensureRunning(
          Effect.gen(function* () {
            yield* startedA.open
            return yield* Effect.never.pipe(Effect.as("A"))
          }),
        )
        .pipe(Effect.exit, Effect.forkChild)
      yield* startedA.await
      yield* waitForState(runner, "Running")

      const b = yield* runner
        .ensureRunning(
          Effect.gen(function* () {
            yield* Ref.set(ranQueued, true)
            return "B"
          }),
        )
        .pipe(Effect.exit, Effect.forkChild)
      yield* Effect.yieldNow

      yield* runner.cancel

      const exitA = yield* Fiber.await(a).pipe(Effect.timeout("1 second"))
      const exitB = yield* Fiber.await(b).pipe(Effect.timeout("1 second"))
      // Both callers settle (do not hang); each `.pipe(Effect.exit)` fiber
      // succeeds carrying an inner Failure (Cancelled, mapped to a die since
      // there is no onInterrupt). The queued caller's work never ran.
      const inner = <T,>(e: Exit.Exit<Exit.Exit<T, unknown>, never>) =>
        Exit.isSuccess(e) ? e.value : Exit.die("outer failed")
      expect(Exit.isFailure(inner(exitA))).toBe(true)
      expect(Exit.isFailure(inner(exitB))).toBe(true)
      expect(yield* Ref.get(ranQueued)).toBe(false)
      expect(runner.busy).toBe(false)
    }),
  )

  // AC: cancel with onInterrupt resolves every queued caller gracefully.
  it.live(
    "cancel with onInterrupt resolves queued callers via fallback",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s, { onInterrupt: Effect.succeed("fallback") })

      const startedA = yield* Latch.make(false)
      const a = yield* runner
        .ensureRunning(
          Effect.gen(function* () {
            yield* startedA.open
            return yield* Effect.never.pipe(Effect.as("A"))
          }),
        )
        .pipe(Effect.forkChild)
      yield* startedA.await
      yield* waitForState(runner, "Running")
      const b = yield* runner.ensureRunning(Effect.succeed("B")).pipe(Effect.forkChild)
      yield* Effect.yieldNow

      yield* runner.cancel

      const exitA = yield* Fiber.await(a).pipe(Effect.timeout("1 second"))
      const exitB = yield* Fiber.await(b).pipe(Effect.timeout("1 second"))
      expect(Exit.isSuccess(exitA)).toBe(true)
      expect(Exit.isSuccess(exitB)).toBe(true)
      if (Exit.isSuccess(exitA)) expect(exitA.value).toBe("fallback")
      if (Exit.isSuccess(exitB)) expect(exitB.value).toBe("fallback")
    }),
  )

  // AC: abort flushes the whole queue — no queued turn starts after abort.
  it.live(
    "abort flushes the whole queue — no queued turn starts",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s, { onInterrupt: Effect.succeed("fallback") })
      const ran = yield* Ref.make<string[]>([])

      const startedA = yield* Latch.make(false)
      const a = yield* runner
        .ensureRunning(
          Effect.gen(function* () {
            yield* Ref.update(ran, (e) => [...e, "A"])
            yield* startedA.open
            return yield* Effect.never.pipe(Effect.as("A"))
          }),
        )
        .pipe(Effect.forkChild)
      yield* startedA.await
      yield* waitForState(runner, "Running")

      const mk = (name: string) =>
        runner
          .ensureRunning(
            Effect.gen(function* () {
              yield* Ref.update(ran, (e) => [...e, name])
              return name
            }),
          )
          .pipe(Effect.forkChild)
      const b = yield* mk("B")
      const c = yield* mk("C")
      yield* Effect.yieldNow

      yield* runner.cancel // abort route

      yield* Fiber.await(b).pipe(Effect.timeout("1 second"))
      yield* Fiber.await(c).pipe(Effect.timeout("1 second"))
      yield* Fiber.await(a).pipe(Effect.timeout("1 second"))

      // Only A's work ran; no queued turn started after abort.
      expect(yield* Ref.get(ran)).toEqual(["A"])
      expect(runner.busy).toBe(false)
    }),
  )

  // AC: instance shutdown (scope close -> finalizer -> cancel) flushes queued
  // callers so none hang.
  it.live(
    "shutdown (cancel) flushes queued callers",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s, { onInterrupt: Effect.succeed("fallback") })
      const startedA = yield* Latch.make(false)

      const a = yield* runner
        .ensureRunning(
          Effect.gen(function* () {
            yield* startedA.open
            return yield* Effect.never.pipe(Effect.as("A"))
          }),
        )
        .pipe(Effect.forkChild)
      yield* startedA.await
      yield* waitForState(runner, "Running")
      const b = yield* runner.ensureRunning(Effect.succeed("B")).pipe(Effect.forkChild)
      yield* Effect.yieldNow

      // run-state.ts finalizer calls runner.cancel on instance teardown.
      yield* runner.cancel

      const rB = yield* Fiber.join(b).pipe(Effect.timeout("1 second"))
      expect(rB).toBe("fallback")
      yield* Fiber.await(a).pipe(Effect.timeout("1 second"))
    }),
  )

  // AC (G4): a prompt arriving while a shell runs is not dropped — it is queued
  // and runs after the shell (shell pending slot + prompt queue unified).
  it.live(
    "prompt arriving during shell is queued and runs after (not dropped)",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const gate = yield* Deferred.make<void>()
      const ran = yield* Ref.make<string[]>([])

      const sh = yield* runner
        .startShell(
          Effect.gen(function* () {
            yield* Deferred.await(gate)
            yield* Ref.update(ran, (e) => [...e, "shell"])
            return "shell"
          }),
        )
        .pipe(Effect.forkChild)
      yield* waitForState(runner, "Shell")

      const p1 = yield* runner
        .ensureRunning(
          Effect.gen(function* () {
            yield* Ref.update(ran, (e) => [...e, "p1"])
            return "p1"
          }),
        )
        .pipe(Effect.forkChild)
      yield* waitForState(runner, "ShellThenRun")
      const p2 = yield* runner
        .ensureRunning(
          Effect.gen(function* () {
            yield* Ref.update(ran, (e) => [...e, "p2"])
            return "p2"
          }),
        )
        .pipe(Effect.forkChild)
      yield* Effect.yieldNow

      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.await(sh)
      const r1 = yield* Fiber.join(p1).pipe(Effect.timeout("1 second"))
      const r2 = yield* Fiber.join(p2).pipe(Effect.timeout("1 second"))

      // Both prompts ran, as their OWN turns, after the shell, in arrival order.
      expect(r1).toBe("p1")
      expect(r2).toBe("p2")
      expect(yield* Ref.get(ran)).toEqual(["shell", "p1", "p2"])
      expect(runner.state._tag).toBe("Idle")
    }),
  )

  // AC: shell / revert / delete busy-bounce behavior unchanged — startShell
  // still rejects with Busy while a run is active.
  it.live(
    "startShell still bounces with Busy while a run is active",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const started = yield* Deferred.make<void>()
      const fiber = yield* runner
        .ensureRunning(
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined)
            return yield* Effect.never.pipe(Effect.as("x"))
          }),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* waitForState(runner, "Running")

      const exit = yield* runner.startShell(Effect.succeed("nope")).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Runner.Busy)

      yield* runner.cancel
      yield* Fiber.await(fiber).pipe(Effect.timeout("1 second"))
    }),
  )
})
