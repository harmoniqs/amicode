import { createSimpleContext } from "@opencode-ai/ui/context"
import { createStore } from "solid-js/store"
import { IS_AMICODE_PANE } from "@/utils/amicode-pane"

// amicode(split v2): in-app split state. One right pane (the ask: two sessions
// side by side). `right.path` is a same-origin route ("/<dir>/session/<id>",
// "/new-session?draftId=…") — the SplitFrame iframes the app at that route.
// Drags: a titlebar tab drag carries its href; a "merge" drag comes from the
// pane header. v2 guardrails: drops ONLY land on the window's narrow edge
// rails (the content area is never a target), the pane never exceeds 60%,
// and the state never persists across app reloads.

type RightPane = { id: string; path: string; title?: string; widthPct: number }
/** source records WHERE the drag started: a strip tab (move semantics — the
 *  session keeps both views) or a panel entry (open semantics — an already-
 *  open session gets focused, never duplicated). */
type Drag = { kind: "tab"; href: string; source: "strip" | "panel" } | undefined

const paneId = (): string =>
  (crypto as { randomUUID?: () => string }).randomUUID?.() ?? `pane-${Date.now()}-${Math.random().toString(36).slice(2)}`

export const { use: useSplit, provider: SplitProvider } = createSimpleContext({
  name: "Split",
  gate: false,
  init: () => {
    const [store, setStore] = createStore<{ right?: RightPane; drag: Drag }>({ drag: undefined })
    return {
      get enabled() {
        return !IS_AMICODE_PANE
      },
      get right() {
        return store.right
      },
      get drag() {
        return store.drag
      },
      beginTabDrag(href: string, source: "strip" | "panel" = "strip") {
        if (IS_AMICODE_PANE) return
        setStore("drag", { kind: "tab", href, source })
      },
      endDrag() {
        setStore("drag", undefined)
      },
      splitWith(path: string) {
        if (IS_AMICODE_PANE) return
        // 50/50 by default — an even split reads as intentional; the sash
        // still lets you go asymmetric (25–60) when you want it.
        setStore("right", { id: paneId(), path, widthPct: 50 })
        setStore("drag", undefined)
      },
      unsplit() {
        setStore("right", undefined)
        setStore("drag", undefined)
      },
      /** The pane navigated itself (route-info bridge) — keep path/title current. */
      setRightRoute(path: string, title?: string) {
        if (!store.right) return
        setStore("right", "path", path)
        if (title) setStore("right", "title", title)
      },
      setWidthPct(pct: number) {
        if (!store.right) return
        setStore("right", "widthPct", Math.max(25, Math.min(60, pct)))
      },
    }
  },
})
