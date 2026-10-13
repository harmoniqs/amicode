// ============================================================================
// Engine self-shutdown (#1596, ADR 0020).
//
// The detached engine survives the extension host's exit. While active, the
// extension pings POST /keepalive at a regular interval (well under the grace
// window). This module:
//
//   1. Receives the keepalive pings (touchKeepalive) — updates lastPingAt and
//      graceSeconds; starts the idle watcher on the first ping.
//   2. Tracks active SSE subscribers (notifySseConnect / notifySseDisconnect)
//      so fleet clients that hold event-stream connections keep the engine alive.
//   3. Tracks in-flight agent turns (notifyTurnStart / notifyTurnEnd) so a busy
//      session prevents premature exit.
//   4. Checks the idle predicate every 5 seconds:
//        shouldSelfExit = graceElapsed AND noTurns AND noSse AND NOT roleExempt
//      When all hold: log, delete handshake, process.exit(0).
//
// If AMICO_ENGINE_ROLE_EXEMPT=1 (fleet server/hub), the idle watcher NEVER
// starts — even if /keepalive is called.
// ============================================================================

import { existsSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

// ── Module-level state ──────────────────────────────────────────────────────

let lastPingAt = 0
let graceSeconds = 30
let sseSubscribers = 0
let busySessions = 0
let watcherTimer: ReturnType<typeof setInterval> | undefined
let started = false

/** The idle watcher check interval (ms). */
const CHECK_INTERVAL_MS = 5_000

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Called from the /keepalive route handler on each POST.
 * Updates the last-ping timestamp and the grace window. Starts the idle
 * watcher on the first call (unless role-exempt).
 */
export function touchKeepalive(grace: number): void {
  lastPingAt = Date.now()
  graceSeconds = grace
  if (!started) {
    startIdleWatcher()
  }
}

/** Track an SSE connection opening. Fleet clients hold these. */
export function notifySseConnect(): void {
  sseSubscribers++
}

/** Track an SSE connection closing. */
export function notifySseDisconnect(): void {
  sseSubscribers = Math.max(0, sseSubscribers - 1)
}

/** Track an agent turn starting. */
export function notifyTurnStart(): void {
  busySessions++
}

/** Track an agent turn finishing. */
export function notifyTurnEnd(): void {
  busySessions = Math.max(0, busySessions - 1)
}

// ── Getters (for testing / diagnostics) ─────────────────────────────────────

export function getLastPingAt(): number {
  return lastPingAt
}

export function getGraceSeconds(): number {
  return graceSeconds
}

export function getSseSubscribers(): number {
  return sseSubscribers
}

export function getBusySessions(): number {
  return busySessions
}

export function isStarted(): boolean {
  return started
}

// ── Pure predicate ──────────────────────────────────────────────────────────

/**
 * Should the engine self-exit? All conditions must hold:
 *   1. Grace window elapsed
 *   2. No in-flight turns
 *   3. No active SSE subscribers
 *   4. Not role-exempt
 */
export function shouldSelfExit(now: number): boolean {
  if (isRoleExempt()) return false
  if (busySessions > 0) return false
  if (sseSubscribers > 0) return false
  if (lastPingAt === 0) return false // no ping ever received
  return now - lastPingAt > graceSeconds * 1000
}

// ── Role exemption ──────────────────────────────────────────────────────────

/** Read once at first use; cached for the process lifetime. */
let _roleExempt: boolean | undefined
export function isRoleExempt(): boolean {
  if (_roleExempt === undefined) {
    _roleExempt = process.env.AMICO_ENGINE_ROLE_EXEMPT === "1"
  }
  return _roleExempt
}

// ── Handshake file ──────────────────────────────────────────────────────────

function handshakePath(): string {
  return join(homedir(), ".amico", "ops", "server", "standalone.json")
}

function deleteHandshake(): void {
  try {
    const p = handshakePath()
    if (existsSync(p)) unlinkSync(p)
  } catch {
    // best-effort — the file may already be gone
  }
}

// ── Idle watcher ────────────────────────────────────────────────────────────

function startIdleWatcher(): void {
  if (started) return
  if (isRoleExempt()) return // fleet server/hub — never self-exit
  started = true

  watcherTimer = setInterval(() => {
    if (shouldSelfExit(Date.now())) {
      // eslint-disable-next-line no-console
      console.log("[self-shutdown] idle, exiting")
      deleteHandshake()
      process.exit(0)
    }
  }, CHECK_INTERVAL_MS)

  // Don't keep the process alive just for the self-shutdown timer
  if (watcherTimer && typeof watcherTimer === "object" && "unref" in watcherTimer) {
    ;(watcherTimer as NodeJS.Timeout).unref()
  }
}

/** Stop the idle watcher (for testing). */
export function stopIdleWatcher(): void {
  if (watcherTimer !== undefined) {
    clearInterval(watcherTimer)
    watcherTimer = undefined
  }
  started = false
}

/** Reset all state (for testing). */
export function _resetForTesting(): void {
  stopIdleWatcher()
  lastPingAt = 0
  graceSeconds = 30
  sseSubscribers = 0
  busySessions = 0
  _roleExempt = undefined
}
