/**
 * remote-create-arm.ts — #1643 (completes #1484 AC3)
 *
 * The arming store + fetch-seam attachment — the mechanism that carries the
 * owner header from the composer's pre-flight decision to the actual create
 * request, WITHOUT threading a parameter through the SDK's typed create call
 * (which takes no per-call headers). It mirrors the sseFetch precedent
 * (server-sdk.tsx): a custom fetch wrapper rewrites the outgoing request.
 *
 * Flow:
 *   1. The composer pre-flight resolves a REMOTE target → armRemoteCreate(id).
 *   2. It calls sdk().api.session.create(...); that create is a path-less
 *      POST /session (the exact case the multiplexer routes on the header).
 *   3. The SDK's fetch wrapper calls attachOwnerHeaderIfArmed — on a create
 *      POST while armed, it attaches x-amicode-owner and DISARMS (one-shot).
 *   4. A local create never arms → no header → byte-unchanged behavior.
 *
 * One-shot by design: the header must land on exactly the create it was armed
 * for, never leak onto later requests. Module-level state is the right lifetime
 * (a single armed create at a time; a create is synchronous-to-arm here).
 */

import { OWNER_HEADER } from "./remote-create-header"

// ── the arming store ─────────────────────────────────────────────────────────

let _armedOwner: string | undefined

/** Arm the next session-create to route to this owner peer. */
export function armRemoteCreate(ownerMachineId: string): void {
  const trimmed = ownerMachineId.trim()
  _armedOwner = trimmed === "" ? undefined : trimmed
}

/** Clear any armed owner (called on disarm and after a one-shot attach). */
export function disarmRemoteCreate(): void {
  _armedOwner = undefined
}

/** Read the armed owner without consuming it (test/inspection). */
export function peekArmedOwner(): string | undefined {
  return _armedOwner
}

// ── request recognition ──────────────────────────────────────────────────────

/** Is this the path-less session-create POST? Both client shapes:
 *    POST /session       (v1 legacy client)
 *    POST /api/session   (v2 vendored client)
 *  A create carries NO trailing sub-segment (message/command/etc. are not
 *  creates). Mirrors the multiplexer's own path discipline. */
export function isSessionCreate(method: string, url: string): boolean {
  if (method.toUpperCase() !== "POST") return false
  let pathname: string
  try {
    pathname = new URL(url).pathname
  } catch {
    pathname = url
  }
  return pathname === "/session" || pathname === "/api/session"
}

// ── the fetch-seam attachment ────────────────────────────────────────────────

/** On a create POST while armed, return headers with x-amicode-owner attached
 *  and DISARM (one-shot); otherwise return the headers unchanged. Existing
 *  headers are preserved. */
export function attachOwnerHeaderIfArmed(
  method: string,
  url: string,
  headers: Record<string, string>,
): Record<string, string> {
  if (_armedOwner === undefined) return headers
  if (!isSessionCreate(method, url)) return headers
  const owner = _armedOwner
  disarmRemoteCreate()
  return { ...headers, [OWNER_HEADER]: owner }
}
