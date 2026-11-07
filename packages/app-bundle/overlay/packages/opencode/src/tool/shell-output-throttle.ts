// #1778 — throttle a running tool's output preview. Each preview update is a
// `message.part.updated` on the live stream carrying up to 30 KB of output, and
// a chatty command produces one per output chunk. The first update goes out at
// once; after that at most one per interval, a trailing update carrying the
// latest value; `flush` delivers whatever is still unsent (on completion).
// Time is effect's Clock, so TestClock drives it deterministically.
import { Clock, Duration, Effect, Fiber } from "effect"
import type * as Scope from "effect/Scope"

export const OUTPUT_THROTTLE_MS = 200

export const makeOutputThrottle = Effect.fnUntraced(function* (
  send: (output: string) => Effect.Effect<void>,
  interval: Duration.Input = Duration.millis(OUTPUT_THROTTLE_MS),
) {
  const scope: Scope.Scope = yield* Effect.scope
  const every = Duration.toMillis(Duration.fromInputUnsafe(interval))
  let latest: string | undefined
  let sent: string | undefined
  let sentAt = Number.NEGATIVE_INFINITY
  let trailing: Fiber.Fiber<void> | undefined

  // Sends the latest value unless it already went out.
  const deliver = Effect.suspend(() => {
    if (latest === undefined || latest === sent) return Effect.void
    const value = latest
    sent = value
    return Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) => {
        sentAt = now
        return send(value)
      }),
    )
  })

  /** A new preview value: sent now if the interval has passed, else by the trailing update. */
  const offer = (value: string) =>
    Effect.gen(function* () {
      latest = value
      if (trailing) return
      const wait = sentAt + every - (yield* Clock.currentTimeMillis)
      if (wait <= 0) return yield* deliver
      trailing = yield* Effect.sleep(Duration.millis(wait)).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            trailing = undefined
            return deliver
          }),
        ),
        Effect.forkIn(scope),
      )
    })

  /** Deliver anything unsent now (the guaranteed final update) and drop the pending trailing one. */
  const flush = Effect.gen(function* () {
    const pending = trailing
    trailing = undefined
    if (pending) yield* Fiber.interrupt(pending)
    yield* deliver
  })

  return { offer, flush }
})
