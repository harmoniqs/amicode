// AMICODE (widget kernel): host side of bridge protocol v1 — the single seam
// between sandboxed widget frames and the app. All I/O crosses here, which
// makes this the enforcement point for the fetch/action allowlists. Pure
// handler (deps injected) so the message routing is unit-testable; the JSX
// frame component stays a thin shell.
import { allowAction, allowFetch } from "./widget-allowlist"

export const HOST_BRIDGE_VERSION = 1

export type FrameMessage =
  | { t: "amc:ready" }
  | { t: "amc:height"; h: number }
  | { t: "amc:empty"; empty: boolean }
  | { t: "amc:fetch"; id: number; path: unknown }
  | { t: "amc:action"; id: number; verb: unknown; payload?: unknown }
  | { t: "amc:prompt"; text: string }
  | { t: "amc:open"; entity: string }
  | { t: "amc:error"; message: string }

export interface BridgeDeps {
  /** allowlist-checked already; performs the GET and returns parsed JSON */
  fetch: (path: string) => Promise<unknown>
  /** allowlist-checked already; executes a host action */
  action: (verb: string, payload: unknown) => Promise<unknown>
  prompt: (text: string) => void
  open: (entity: string) => void
  ready: () => void
  height: (h: number) => void
  /** explicit empty-state signal (MutationObserver-driven; layout-independent) */
  empty: (empty: boolean) => void
  error: (message: string) => void
  /** post amc:result back into the frame */
  post: (msg: { t: "amc:result"; id: number; ok: boolean; data?: unknown; error?: string }) => void
}

/** Route one frame→host message. Unknown/malformed messages are ignored —
 *  frames are untrusted. Returns a promise so tests can await completion. */
export async function handleWidgetMessage(raw: unknown, deps: BridgeDeps): Promise<void> {
  if (typeof raw !== "object" || raw === null) return
  const msg = raw as Record<string, unknown>
  switch (msg.t) {
    case "amc:ready":
      deps.ready()
      return
    case "amc:height":
      if (typeof msg.h === "number" && Number.isFinite(msg.h) && msg.h >= 0) deps.height(msg.h)
      return
    case "amc:empty":
      if (typeof msg.empty === "boolean") deps.empty(msg.empty)
      return
    case "amc:prompt":
      if (typeof msg.text === "string") deps.prompt(msg.text)
      return
    case "amc:open":
      if (typeof msg.entity === "string") deps.open(msg.entity)
      return
    case "amc:error":
      deps.error(typeof msg.message === "string" ? msg.message : "widget error")
      return
    case "amc:fetch": {
      const id = msg.id
      if (typeof id !== "number") return
      if (!allowFetch(msg.path)) {
        deps.post({ t: "amc:result", id, ok: false, error: `fetch not allowed: ${String(msg.path)}` })
        return
      }
      try {
        const data = await deps.fetch(msg.path)
        deps.post({ t: "amc:result", id, ok: true, data })
      } catch (e) {
        deps.post({ t: "amc:result", id, ok: false, error: (e as Error).message })
      }
      return
    }
    case "amc:action": {
      const id = msg.id
      if (typeof id !== "number") return
      if (!allowAction(msg.verb)) {
        deps.post({ t: "amc:result", id, ok: false, error: `action not allowed: ${String(msg.verb)}` })
        return
      }
      try {
        const data = await deps.action(msg.verb as string, msg.payload ?? {})
        deps.post({ t: "amc:result", id, ok: true, data })
      } catch (e) {
        deps.post({ t: "amc:result", id, ok: false, error: (e as Error).message })
      }
      return
    }
    default:
      return
  }
}
