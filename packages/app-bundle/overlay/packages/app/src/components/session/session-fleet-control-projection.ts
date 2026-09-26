/**
 * session-fleet-control-projection.ts — the SHARED control-projection poll.
 *
 * Extracted from session-header.tsx so both the session header (composer scrim)
 * and the titlebar tab strip (driving-remote icon) can consume the same
 * ref-counted, single-interval poll of GET /amicode/fleet/sessions without
 * importing each other. The poll runs ≈3 s + refetch on window focus, and tears
 * down when the last consumer unmounts.
 *
 * Two hooks:
 *  - useSharedControlProjection()  — convenience for components inside a
 *    <ServerProvider> (calls useServer() internally).
 *  - useControlProjectionForConnection(conn) — for components that have an
 *    explicit ServerConnection (e.g. the titlebar tab strip).
 */

import { createResource, createRoot, createSignal, onCleanup } from "solid-js"
import { useServer, type ServerConnection } from "@/context/server"
import { amicodeGet } from "@/utils/amicode-fetch"

const FLEET_CONTROL_POLL_MS = 3000

type SharedControlProjection = { latest: () => unknown; refetch: () => void }

let sharedControlPoll: SharedControlProjection | null = null
let sharedControlDispose: (() => void) | null = null
let sharedControlRefs = 0

function acquireSharedControlProjection(conn: () => ServerConnection.Any | undefined): SharedControlProjection {
  sharedControlRefs += 1
  if (!sharedControlPoll) {
    createRoot((dispose) => {
      const [tick, setTick] = createSignal(0)
      const [projection, { refetch }] = createResource(
        () => [conn(), tick()] as const,
        ([c]) => (c ? amicodeGet(c, "/amicode/fleet/sessions").catch(() => undefined) : undefined),
      )
      const interval = setInterval(() => setTick((t) => t + 1), FLEET_CONTROL_POLL_MS)
      const onFocus = () => void refetch()
      if (typeof window !== "undefined") window.addEventListener("focus", onFocus)
      sharedControlPoll = { latest: () => projection.latest, refetch: () => void refetch() }
      sharedControlDispose = () => {
        clearInterval(interval)
        if (typeof window !== "undefined") window.removeEventListener("focus", onFocus)
        dispose()
        sharedControlPoll = null
        sharedControlDispose = null
      }
    })
  }
  return sharedControlPoll!
}

function releaseSharedControlProjection() {
  sharedControlRefs = Math.max(0, sharedControlRefs - 1)
  if (sharedControlRefs === 0 && sharedControlDispose) sharedControlDispose()
}

/** Shared accessor for components inside a <ServerProvider> context (e.g.
 *  SessionHeader, SessionComposerControlScrim). Acquires on mount, releases
 *  on cleanup — exactly one interval poll runs while any consumer is mounted. */
export function useSharedControlProjection(): () => unknown {
  const server = useServer()
  const shared = acquireSharedControlProjection(() => server.current)
  onCleanup(releaseSharedControlProjection)
  return shared.latest
}

/** Shared accessor for components that hold an explicit connection rather than
 *  a <ServerProvider> context (e.g. TitlebarTabStrip). Same ref-counted
 *  singleton — no duplicate polling when both hooks are live. */
export function useControlProjectionForConnection(conn: () => ServerConnection.Any | undefined): () => unknown {
  const shared = acquireSharedControlProjection(conn)
  onCleanup(releaseSharedControlProjection)
  return shared.latest
}
