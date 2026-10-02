import { Cause, Deferred, Effect, Exit, Fiber, Latch, Schema, Scope, SynchronizedRef } from "effect"

export interface Runner<A, E = never> {
  readonly state: State<A, E>
  readonly busy: boolean
  readonly ensureRunning: (work: Effect.Effect<A, E>) => Effect.Effect<A, E>
  readonly startShell: (work: Effect.Effect<A, E>, ready?: Latch.Latch) => Effect.Effect<A, E | Busy>
  readonly cancel: Effect.Effect<void>
}

export class Cancelled extends Schema.TaggedErrorClass<Cancelled>()("RunnerCancelled", {}) {}
export class Busy extends Schema.TaggedErrorClass<Busy>()("RunnerBusy", {}) {}

interface RunHandle<A, E> {
  id: number
  done: Deferred.Deferred<A, E | Cancelled>
  fiber: Fiber.Fiber<A, E>
}

interface ShellHandle<A, E> {
  id: number
  cancelled: Deferred.Deferred<void>
  ready?: Latch.Latch
  fiber: Fiber.Fiber<A, E>
}

interface PendingHandle<A, E> {
  id: number
  done: Deferred.Deferred<A, E | Cancelled>
  work: Effect.Effect<A, E>
}

// #1582 — SERIAL prompt queue (overlay fork of base runner.ts). The prompt path
// (ensureRunning) used to COALESCE: on state Running it returned the in-flight
// run's `done` and DISCARDED the second caller's `work`, stranding the second
// prompt in the window between the run loop's final history read and the Idle
// transition. This fork turns that path into a FIFO queue: a prompt arriving
// while running (or while a shell runs) is ENQUEUED with its OWN fresh `done`,
// and finishRun/finishShell dequeue and startRun the next queued turn INSIDE the
// same SynchronizedRef transition, going Running(current) -> Running(next)
// directly (never through Idle). cancel/finalizer flush the whole queue, failing
// every queued caller with Cancelled so none hang. See
// spec-20260927-per-session-prompt-coalesce-stranding. Base-drift: forked from
// base packages/opencode/src/effect/runner.ts (allowlisted, #1229-style).
//
// ShellThenRun no longer carries an inline `run` slot — the pending prompt queue
// (closure-local `queue`, below) is the single source of pending turns, unifying
// the shell-then-run handoff with the prompt queue so a prompt arriving during a
// shell is never dropped.
export type State<A, E> =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Running"; readonly run: RunHandle<A, E> }
  | { readonly _tag: "Shell"; readonly shell: ShellHandle<A, E> }
  | { readonly _tag: "ShellThenRun"; readonly shell: ShellHandle<A, E> }

export const make = <A, E = never>(
  scope: Scope.Scope,
  opts?: {
    onIdle?: Effect.Effect<void>
    onBusy?: Effect.Effect<void>
    onInterrupt?: Effect.Effect<A, E>
  },
): Runner<A, E> => {
  const ref = SynchronizedRef.makeUnsafe<State<A, E>>({ _tag: "Idle" })
  const idle = opts?.onIdle ?? Effect.void
  const onBusy = opts?.onBusy ?? Effect.void
  const onInterrupt = opts?.onInterrupt
  let ids = 0

  // #1582 — FIFO queue of pending prompt turns. Each entry carries its OWN
  // `done`, so a queued caller resolves with the result of its OWN turn (never
  // the in-flight run's result). Enqueued by ensureRunning when the runner is
  // busy (Running / Shell / ShellThenRun); drained head-first by finishRun and
  // finishShell inside the single ref transition. UNBOUNDED by design in this
  // fix; abort (cancel) is the sole drain (a depth cap is a tracked follow-up).
  const queue: PendingHandle<A, E>[] = []

  const state = () => SynchronizedRef.getUnsafe(ref)
  const next = () => {
    ids += 1
    return ids
  }

  const complete = (done: Deferred.Deferred<A, E | Cancelled>, exit: Exit.Exit<A, E>) =>
    Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
      ? Deferred.fail(done, new Cancelled()).pipe(Effect.asVoid)
      : Deferred.done(done, exit).pipe(Effect.asVoid)

  const awaitDone = (done: Deferred.Deferred<A, E | Cancelled>) =>
    Deferred.await(done).pipe(Effect.catchTag("RunnerCancelled", (e) => onInterrupt ?? Effect.die(e)))

  const idleIfCurrent = () =>
    SynchronizedRef.modify(ref, (st) => [st._tag === "Idle" ? idle : Effect.void, st] as const).pipe(Effect.flatten)

  // #1582 — explicit return type annotations break the finishRun <-> startRun
  // inference cycle introduced when finishRun became effectful (modifyEffect) to
  // drain the queue: finishRun references startRun, whose onExit references
  // finishRun. The base finishRun used sync `modify` and dodged the cycle.
  const startRun = (
    work: Effect.Effect<A, E>,
    done: Deferred.Deferred<A, E | Cancelled>,
  ): Effect.Effect<RunHandle<A, E>> =>
    Effect.gen(function* () {
      const id = next()
      const fiber = yield* work.pipe(
        Effect.onExit((exit) => finishRun(id, done, exit)),
        Effect.forkIn(scope),
      )
      return { id, done, fiber } satisfies RunHandle<A, E>
    })

  const finishRun = (
    id: number,
    done: Deferred.Deferred<A, E | Cancelled>,
    exit: Exit.Exit<A, E>,
  ): Effect.Effect<void> =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        // Not the current run (e.g. superseded by cancel): just settle this done.
        if (!(st._tag === "Running" && st.run.id === id)) {
          return [complete(done, exit), st] as const
        }
        // #1582 — drain the FIFO queue INSIDE this single ref transition:
        // non-empty queue -> dequeue head and startRun it, transitioning
        // Running(current) -> Running(next) DIRECTLY (never through Idle, so the
        // onIdle hook — which deletes the session's runner — never fires on a
        // drain and cannot orphan the turn being drained). Empty queue -> settle
        // Idle exactly as the base did.
        const head = queue.shift()
        if (head === undefined) {
          return [
            Effect.gen(function* () {
              yield* idle
              yield* complete(done, exit)
            }),
            { _tag: "Idle" } as const,
          ] as const
        }
        const run = yield* startRun(head.work, head.done)
        return [complete(done, exit), { _tag: "Running", run } as const] as const
      }),
    ).pipe(Effect.flatten)

  const finishShell = (id: number) =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        // #1582 — the shell-then-run pending slot IS the prompt queue head, so a
        // prompt arriving during a shell is promoted here (never dropped). On
        // shell finish: drain the queue head into a run if any is queued
        // (Shell/ShellThenRun -> Running), else settle Idle.
        if ((st._tag === "Shell" || st._tag === "ShellThenRun") && st.shell.id === id) {
          const head = queue.shift()
          if (head === undefined) {
            return [idle, { _tag: "Idle" }] as const
          }
          const run = yield* startRun(head.work, head.done)
          return [Effect.void, { _tag: "Running", run }] as const
        }
        return [Effect.void, st] as const
      }),
    ).pipe(Effect.flatten)

  const stopShell = (shell: ShellHandle<A, E>) =>
    Effect.gen(function* () {
      if (shell.ready) yield* shell.ready.await.pipe(Effect.exit, Effect.asVoid)
      yield* Deferred.succeed(shell.cancelled, undefined).pipe(Effect.asVoid)
      yield* Fiber.interrupt(shell.fiber)
    })

  const ensureRunning = (work: Effect.Effect<A, E>) =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        switch (st._tag) {
          case "Running":
          case "ShellThenRun":
          case "Shell": {
            // #1582 — SERIAL: the runner is busy, so ENQUEUE this work with its
            // OWN fresh `done` and return awaitDone(thatDone). The caller resolves
            // with the result of its OWN turn (not the in-flight run's), and no
            // work is discarded. During a bare Shell, the first enqueue also flips
            // the state to ShellThenRun so the shell handoff knows to promote.
            const pending = {
              id: next(),
              done: yield* Deferred.make<A, E | Cancelled>(),
              work,
            } satisfies PendingHandle<A, E>
            queue.push(pending)
            const nextState = st._tag === "Shell" ? ({ _tag: "ShellThenRun", shell: st.shell } as const) : st
            return [awaitDone(pending.done), nextState] as const
          }
          case "Idle": {
            const done = yield* Deferred.make<A, E | Cancelled>()
            const run = yield* startRun(work, done)
            return [awaitDone(done), { _tag: "Running", run }] as const
          }
        }
      }),
    ).pipe(Effect.flatten)

  const startShell = (work: Effect.Effect<A, E>, ready?: Latch.Latch): Effect.Effect<A, E | Busy> =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        if (st._tag !== "Idle") {
          const reject: Effect.Effect<A, E | Busy> = Effect.fail(new Busy())
          return [reject, st] as const
        }
        yield* onBusy
        const id = next()
        const cancelled = yield* Deferred.make<void>()
        const fiber = yield* work.pipe(Effect.ensuring(finishShell(id)), Effect.forkChild)
        const shell = { id, cancelled, ready, fiber } satisfies ShellHandle<A, E>
        return [
          Effect.gen(function* () {
            const exit = yield* Fiber.await(fiber)
            if (Exit.isSuccess(exit)) return exit.value
            if (
              Cause.hasInterruptsOnly(exit.cause) ||
              ((yield* Deferred.isDone(cancelled)) && Cause.hasInterrupts(exit.cause) && !Cause.hasDies(exit.cause))
            ) {
              if (onInterrupt) return yield* onInterrupt
              return yield* Effect.die(new Cancelled())
            }
            return yield* Effect.failCause(exit.cause)
          }),
          { _tag: "Shell", shell },
        ] as const
      }),
    ).pipe(Effect.flatten)

  // #1582 — fail EVERY queued caller with Cancelled and clear the queue. Each
  // resolves via awaitDone's onInterrupt mapping (so no queued caller hangs).
  // Used by cancel on every busy branch: abort flushes the WHOLE queue and no
  // queued turn starts after abort; the instance finalizer (run-state.ts) calls
  // cancel on shutdown, inheriting this drain.
  const flushQueue = Effect.suspend(() => {
    const pending = queue.splice(0, queue.length)
    return Effect.forEach(pending, (p) => Deferred.fail(p.done, new Cancelled()).pipe(Effect.asVoid), {
      discard: true,
    })
  })

  const cancel = SynchronizedRef.modify(ref, (st) => {
    switch (st._tag) {
      case "Idle":
        return [Effect.void, st] as const
      case "Running":
        return [
          Effect.gen(function* () {
            yield* flushQueue
            yield* Fiber.interrupt(st.run.fiber)
            yield* Deferred.fail(st.run.done, new Cancelled()).pipe(Effect.asVoid)
            yield* idleIfCurrent()
          }),
          { _tag: "Idle" } as const,
        ] as const
      case "Shell":
        return [
          Effect.gen(function* () {
            yield* stopShell(st.shell)
            yield* flushQueue
            yield* idleIfCurrent()
          }),
          { _tag: "Idle" } as const,
        ] as const
      case "ShellThenRun":
        return [
          Effect.gen(function* () {
            yield* stopShell(st.shell)
            yield* flushQueue
            yield* idleIfCurrent()
          }),
          { _tag: "Idle" } as const,
        ] as const
    }
  }).pipe(Effect.flatten)

  return {
    get state() {
      return state()
    },
    get busy() {
      return state()._tag !== "Idle"
    },
    ensureRunning,
    startShell,
    cancel,
  }
}

export * as Runner from "./runner"
