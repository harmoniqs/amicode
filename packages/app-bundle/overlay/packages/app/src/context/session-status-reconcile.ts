/**
 * Session status reconciliation — a safety valve for remote prompts.
 * When the optimistic "busy" status is set but the SSE resolution event
 * never arrives, this module polls the session endpoint and reconciles.
 */

export const RECONCILE_TIMEOUT_MS = 30_000
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * Start a reconciliation timer for a session.
 * If the SSE event resolves the status within the timeout, call cancel().
 * Otherwise, the timer fires and calls the reconcile callback.
 */
export function startReconcileTimer(
  sessionId: string,
  onReconcile: (sessionId: string) => void,
  timeoutMs = RECONCILE_TIMEOUT_MS,
): void {
  // Cancel any existing timer for this session
  cancelReconcileTimer(sessionId)
  const timer = setTimeout(() => {
    pendingTimers.delete(sessionId)
    onReconcile(sessionId)
  }, timeoutMs)
  // Don't block Node's exit (for tests)
  if (typeof timer === "object" && "unref" in timer) timer.unref()
  pendingTimers.set(sessionId, timer)
}

/**
 * Cancel the reconciliation timer for a session.
 * Call this when the SSE event resolves the status normally.
 */
export function cancelReconcileTimer(sessionId: string): void {
  const existing = pendingTimers.get(sessionId)
  if (existing !== undefined) {
    clearTimeout(existing)
    pendingTimers.delete(sessionId)
  }
}

/**
 * Cancel all pending timers (cleanup on unmount/navigation).
 */
export function cancelAllReconcileTimers(): void {
  for (const timer of pendingTimers.values()) {
    clearTimeout(timer)
  }
  pendingTimers.clear()
}

/**
 * Check if a reconciliation timer is pending for a session.
 */
export function hasReconcileTimer(sessionId: string): boolean {
  return pendingTimers.has(sessionId)
}
