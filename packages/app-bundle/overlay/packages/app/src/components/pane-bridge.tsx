import { createEffect, onCleanup } from "solid-js"
import { useLocation } from "@solidjs/router"
import { useTabs, tabHref, draftHref, type Tab } from "@/context/tabs"
import { useWorkbench, MAIN_PANE_ID } from "@/context/workbench"
import { AMICODE_PANE_ID, IS_AMICODE_PANE } from "@/utils/amicode-pane"
import { listenWorkbench, postWorkbench, type WorkbenchMessage } from "@/utils/pane-bridge"

// amicode(workbench S2): every app instance mounts this. Two jobs:
//  1. REPORT — the instance's tab list (as route paths) flows to the parent's
//     mirror whenever it changes: panes post over the bridge; the top document
//     writes the workbench store directly (it IS the parent).
//  2. OBEY — panes execute the parent's open/close/focus commands via their
//     own tabs context (the top document's commands are issued directly, no
//     messages needed).
// Renders nothing.

const tabsReport = (tabs: Tab[], activePath?: string) => ({
  tabs: tabs.map((t) => (t.type === "draft" ? draftHref(t.draftID) : tabHref(t))),
  active: activePath,
})

export function WorkbenchBridge() {
  const tabs = useTabs()
  const location = useLocation()
  const workbench = useWorkbench()

  const activePath = () => {
    const path = `${location.pathname}${location.search}`
    const list = tabs.store
    return list.some((t) => (t.type === "draft" ? draftHref(t.draftID) : tabHref(t)) === path) ? path : undefined
  }

  // REPORT
  createEffect(() => {
    const report = tabsReport(tabs.store, activePath())
    if (IS_AMICODE_PANE) {
      postWorkbench(window.parent, { kind: "tabs-changed", paneId: AMICODE_PANE_ID ?? "pane", report }, "*")
    } else {
      workbench.report(MAIN_PANE_ID, report)
    }
  })

  // OBEY (panes only — the parent commands the top document directly)
  if (IS_AMICODE_PANE) {
    const unlisten = listenWorkbench((msg: WorkbenchMessage) => {
      if (msg.kind === "open-tab") tabs.openPath(msg.path, { activate: msg.activate })
      if (msg.kind === "close-tab") tabs.closePath(msg.path)
      if (msg.kind === "focus-tab") tabs.openPath(msg.path, { activate: true })
    })
    onCleanup(unlisten)
  }

  return null
}

/** amicode(workbench): pane strips report drags to the parent (the parent owns
 *  drop resolution across frames). The top document uses the split context
 *  instead — this helper is pane-mode only. */
export function reportTabDrag(path: string | undefined) {
  if (!IS_AMICODE_PANE) return
  if (path === undefined) postWorkbench(window.parent, { kind: "drag-tab-end" }, "*")
  else postWorkbench(window.parent, { kind: "drag-tab-start", path }, "*")
}
