import { createSimpleContext } from "@opencode-ai/ui/context"
import { createStore, produce } from "solid-js/store"
import { IS_AMICODE_PANE } from "@/utils/amicode-pane"

// amicode(workbench S2): the parent's single source of truth for cross-pane
// tab state. Mirrors every instance's tab list (each instance reports
// tabs-changed over the pane bridge; the top document reports directly).
// The parent resolves drops into commands against this mirror — open-then-
// close, with the mirror itself as the ack (a command is confirmed by the
// next report that reflects it). Boot-time reconciliation: a tab reported
// nowhere is dropped from the mirror (finding: silent reconciliation drops
// are themselves visible in the mirror history).

export type PaneTabMirror = { tabs: string[]; active?: string }

export const MAIN_PANE_ID = "main"

export const { use: useWorkbench, provider: WorkbenchProvider } = createSimpleContext({
  name: "Workbench",
  gate: false,
  init: () => {
    const [mirror, setMirror] = createStore<Record<string, PaneTabMirror>>({})

    const report = (paneId: string, r: PaneTabMirror) => {
      setMirror(paneId, { tabs: r.tabs, active: r.active })
    }
    const removePane = (paneId: string) => {
      setMirror(
        produce((m) => {
          delete m[paneId]
        }),
      )
    }

    /** Every pane currently showing `path` (session-tab singleton checks). */
    const panesWith = (path: string): string[] =>
      Object.entries(mirror)
        .filter(([, m]) => m.tabs.includes(path))
        .map(([id]) => id)

    /** Global duplicate check — the singleton rule's enforcement data. */
    const isOpen = (path: string): boolean => panesWith(path).length > 0

    return {
      mirror,
      report,
      removePane,
      panesWith,
      isOpen,
      get enabled() {
        return !IS_AMICODE_PANE
      },
    }
  },
})
