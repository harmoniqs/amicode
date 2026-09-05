// D2 (spec spec-20260905-045114-session-device-lifecycle), issue #817: the
// persisted session snapshot is a render accelerator, never an authority.
// Ported from the fork reference (harmoniqs/opencode#296) with the REVISED
// currency placement: the token is derived CLIENT-side over the fetched
// projection (session-currency.ts) — no server currency field exists to
// verify against, the boot decision derives both sides.
//
// Pure and dependency-free (type imports only) so it unit-tests headless.
import type { Session } from "@opencode-ai/sdk/v2/client"
import { deriveCurrencyToken } from "./session-currency"

export type SessionSnapshot = {
  sessions: Session[]
  currency?: string
}

export type BootCurrencyDecision = {
  /** The fetched response is always adopted — it is the authority. */
  adopt: boolean
  /** The persisted snapshot contradicts the server (stale or tokenless) and
   *  must be invalidated (overwritten by the fetched state). */
  stale: boolean
  /** The client-derived token to persist alongside the adopted rows. */
  currency: string
}

export function bootCurrencyDecision(input: {
  snapshot?: SessionSnapshot
  response: { sessions: Session[] }
  /** The hub's self-reported version (health endpoint); undefined when the
   *  hub did not report one — the stamp degrades to "unavailable". */
  serverVersion?: string
}): BootCurrencyDecision {
  // The response's token is derived from ITS rows every time — out-of-band
  // writes, archive churn, and same-tick touches all move it by construction.
  const currency = deriveCurrencyToken(input.response.sessions, input.serverVersion)
  // A tokenless snapshot was written by a client that could not prove its own
  // currency — the founding #293 shape — and reads as stale on first proof.
  const stale =
    input.snapshot !== undefined &&
    (input.snapshot.currency === undefined || input.snapshot.currency !== currency)
  return { adopt: true, stale, currency }
}

export function toSnapshot(sessions: Session[], currency: string): SessionSnapshot {
  return { sessions, currency }
}
