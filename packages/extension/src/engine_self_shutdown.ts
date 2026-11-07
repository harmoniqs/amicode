// ============================================================================
// Engine self-shutdown idle predicate (#1596, ADR 0020).
//
// Pure function — no side effects, no process-level I/O. The engine overlay's
// self-shutdown.ts drives the timer + process.exit using this same logic.
// Extracted here for testability from the extension test suite.
// ============================================================================

/**
 * Inputs to the idle predicate. All values are read at check time.
 */
export interface IdlePredicateInput {
  /** Milliseconds since the last /keepalive ping was received. */
  msSinceLastPing: number;
  /** Grace window (seconds) from the last /keepalive request body. */
  graceSeconds: number;
  /** Number of in-flight agent turns across all sessions. */
  inFlightTurns: number;
  /** Number of active event-stream (SSE) subscribers. */
  activeEventStreamSubscribers: number;
  /** Whether this engine is role-exempt (fleet server/hub — never self-exits). */
  roleExempt: boolean;
}

/**
 * Should the engine self-exit?
 *
 * All four conditions must hold simultaneously:
 *   1. Grace window elapsed: now − lastPing > graceSeconds
 *   2. No in-flight agent turns
 *   3. No active SSE subscribers (fleet clients hold these)
 *   4. Not role-exempt (fleet server/hub engines never self-exit)
 */
export function shouldSelfExit(input: IdlePredicateInput): boolean {
  if (input.roleExempt) return false;
  if (input.inFlightTurns > 0) return false;
  if (input.activeEventStreamSubscribers > 0) return false;
  return input.msSinceLastPing > input.graceSeconds * 1000;
}
