// #1584 — the client-side SSE liveness watchdog's decision, extracted as a
// ZERO-DEPENDENCY pure fn so its test runs in-place (`bun test --conditions=solid`)
// outside the materialized tree. It MUST NOT import solid-js or @opencode-ai/*
// (that dependency is exactly what makes stream-gap.test.ts fail in-place).
//
// Mirrors the `applySseError` pattern (server-sdk.tsx): the part that reads as
// redundant — "why reconnect a stream that says it is connected?" — is the part
// a silently half-open socket makes essential, so it is covered by a test.
//
// The overlay app's v1 event iterator "neither throws nor completes" when the
// socket goes half-open (sleep/wake, Wi-Fi blip, engine replaced without
// FIN/RST): `onSseError` never fires, the `for await` parks forever, and
// `streamStatus` stays "connected" while the transcript freezes. This watchdog
// catches that: a stream that BELIEVES itself connected but has seen no frame
// for strictly longer than `staleMs` is force-reconnected (abort the parked
// attempt so the loop re-opens with the `lastEventID` cursor — lossless).

/** Reconnect a stale-but-"connected" stream — the watchdog's decision.
 *
 *  Returns `true` iff the stream believes itself `"connected"` AND no frame has
 *  arrived for strictly longer than `staleMs`. A `"disconnected"` stream is
 *  already being reconnected by the loop, so the watchdog leaves it alone; a
 *  stream exactly at the threshold is not yet stale (strict `>`). */
export function shouldReconnectIdleStream(input: {
  status: "connected" | "disconnected"
  now: number
  lastFrameAt: number
  staleMs: number
}): boolean {
  return input.status === "connected" && input.now - input.lastFrameAt > input.staleMs
}
