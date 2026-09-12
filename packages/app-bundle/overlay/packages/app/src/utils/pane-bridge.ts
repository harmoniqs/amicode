// amicode(workbench S2): the parent ⇄ pane-instance command bridge. One
// envelope source so it can be told apart from the generic amicode bridges
// (clipboard/theme/route-info). The parent owns drop resolution and issues
// open/close/focus commands; each instance reports its tab list (the mirror
// the parent resolves moves against — the ack is the next tabs-changed that
// contains the expected change).

export type WorkbenchTabReport = { tabs: string[]; active?: string }

export type WorkbenchMessage =
  | { kind: "tabs-changed"; paneId: string; report: WorkbenchTabReport }
  | { kind: "drag-tab-start"; path: string }
  | { kind: "drag-tab-end" }
  | { kind: "open-tab"; path: string; activate?: boolean }
  | { kind: "close-tab"; path: string }
  | { kind: "focus-tab"; path: string }

export const WORKBENCH_SOURCE = "amicode-workbench"

export const isWorkbenchMessage = (d: unknown): d is WorkbenchMessage & { source: string } =>
  !!d && typeof d === "object" && (d as { source?: unknown }).source === WORKBENCH_SOURCE

/** Parent ⇄ instance post. targetOrigin stays explicit at call sites. */
export function postWorkbench(target: Window, msg: WorkbenchMessage, targetOrigin: string): void {
  target.postMessage({ source: WORKBENCH_SOURCE, ...msg }, targetOrigin)
}

export function listenWorkbench(handler: (msg: WorkbenchMessage, event: MessageEvent) => void): () => void {
  const onMsg = (e: MessageEvent) => {
    const d = e.data as unknown
    if (!isWorkbenchMessage(d)) return
    const { source: _source, ...msg } = d as { source: string } & WorkbenchMessage
    handler(msg, e)
  }
  window.addEventListener("message", onMsg)
  return () => window.removeEventListener("message", onMsg)
}
