import { createSignal, onCleanup, onMount, Show, type JSX, type ParentProps } from "solid-js"
import { useLocation, useNavigate } from "@solidjs/router"
import { useTheme } from "@opencode-ai/ui/theme/context"
import { useSplit } from "@/context/split"
import { useServer } from "@/context/server"
import { useLayout } from "@/context/layout"
import { useWorkbench, MAIN_PANE_ID } from "@/context/workbench"
import { useTabs } from "@/context/tabs"
import { WorkbenchPanel } from "@/components/workbench-panel"
import { IS_AMICODE_PANE } from "@/utils/amicode-pane"
import { hiddenProjectWorktree } from "@/utils/amicode-hidden-project"
import { authTokenFromCredentials } from "@/utils/server"
import { listenWorkbench, postWorkbench, type WorkbenchMessage } from "@/utils/pane-bridge"

// amicode(split v2): drag one of the app's own titlebar tabs onto the window's
// LEFT or RIGHT EDGE RAIL and the app splits — the dragged session becomes the
// right pane (the app iframing ITSELF, chrome-lite via ?amicode_pane=1), the
// main side stays live and never reloads.
//
// v2 guardrails, learned the hard way (see amicode repo history):
//  - drops land ONLY on the 48px edge rails. The content area is never a drop
//    target, so a sloppy tab drag can't fire a split.
//  - the pane is capped at 60% and the main side keeps a 280px floor, so the
//    live view is never crushed.
//  - the pane self-heals: same-origin frame emptiness (a boot that renders
//    nothing) auto-merges instead of leaving a black void on screen.
// Merge back: drag the pane header onto either rail, or hit its ×.

const RAIL_PX = 48

export function SplitFrame(props: ParentProps<{ titlebar?: JSX.Element }>) {
  const split = useSplit()
  const server = useServer()
  const theme = useTheme()
  const navigate = useNavigate()
  const location = useLocation()
  const layout = useLayout()
  const workbench = useWorkbench()
  const tabs = useTabs()

  let frameRef: HTMLIFrameElement | undefined
  let rowRef: HTMLDivElement | undefined
  const [hot, setHot] = createSignal<DropZone>()

  // amicode(workbench S2): pane instances report drags + tab lists over the
  // bridge. Drag state here is unified: {path, from, source} — the route, the
  // pane it came from ("main" for the top document), and where it started
  // ("strip" vs "panel" — they carry different singleton semantics).
  type DragState = { path: string; from: string; source: "strip" | "panel" }
  const [bridgeDrag, setBridgeDrag] = createSignal<DragState>()
  const dragState = (): DragState | undefined => {
    const local = split.drag
    if (local) return { path: local.href, from: MAIN_PANE_ID, source: local.source }
    return bridgeDrag()
  }
  const clearDrag = () => {
    split.endDrag()
    setBridgeDrag(undefined)
    setHot(undefined)
  }

  const unlisten = listenWorkbench((msg: WorkbenchMessage, e) => {
    if (IS_AMICODE_PANE) return
    if (msg.kind === "tabs-changed") workbench.report(msg.paneId, msg.report)
    if (msg.kind === "drag-tab-start") setBridgeDrag({ path: msg.path, from: paneIdOfSource(e.source) ?? "pane", source: "strip" })
    if (msg.kind === "drag-tab-end") setBridgeDrag(undefined)
  })
  onCleanup(unlisten)

  const paneIdOfSource = (source: MessageEventSource | null): string | undefined => {
    if (frameRef && source === frameRef.contentWindow) return split.right?.id
    return undefined
  }

  const paneSrc = (pane: { id: string; path: string }): string => {
    const conn = server.current
    // Boot from the APP's origin, not the backend's: production serves both
    // from one URL, but dev/e2e splits them (vite serves the app, the backend
    // only answers API) — a pane pointed at the backend loads JSON, not the
    // app. window.location.origin is right in both worlds.
    const u = new URL(window.location.origin)
    const q = pane.path.indexOf("?")
    u.pathname = q === -1 ? pane.path : pane.path.slice(0, q)
    u.search = q === -1 ? "" : pane.path.slice(q)
    u.searchParams.set("colorScheme", theme.mode())
    if (conn?.http.password)
      u.searchParams.set("auth_token", authTokenFromCredentials({ username: conn.http.username, password: conn.http.password }))
    const hidden = hiddenProjectWorktree()
    if (hidden) u.searchParams.set("amicode_hide_project", hidden)
    u.searchParams.set("amicode_pane", pane.id)
    return u.href
  }

  const paneOrigin = (): string => window.location.origin

  // The pane's route-info bridge → header title + current path.
  const onMsg = (e: MessageEvent) => {
    const d = e.data as { source?: string; kind?: string; path?: string; title?: string } | undefined
    if (!d || d.source !== "amicode" || d.kind !== "route-info") return
    if (!frameRef || e.source !== frameRef.contentWindow) return
    if (typeof d.path === "string" && d.path.startsWith("/") && !d.path.startsWith("//")) {
      split.setRightRoute(d.path, typeof d.title === "string" && d.title.length > 0 ? d.title.slice(0, 120) : undefined)
    }
  }

  // Editor-theme changes reach the MAIN app via the extension bridge; forward
  // them into the pane so both halves re-theme together.
  let themeObserver: MutationObserver | undefined

  onMount(() => {
    window.addEventListener("message", onMsg)
    themeObserver = new MutationObserver(() => {
      const mode = document.documentElement.dataset.colorScheme
      if ((mode === "light" || mode === "dark") && frameRef?.contentWindow) {
        frameRef.contentWindow.postMessage({ source: "amicode", kind: "theme", colorScheme: mode }, paneOrigin())
      }
    })
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-color-scheme"] })
  })
  onCleanup(() => {
    window.removeEventListener("message", onMsg)
    themeObserver?.disconnect()
  })

  // Boot guard: a pane that renders NOTHING is worse than no pane — merge it
  // back out. Same-origin frame, so we can look inside after load settles.
  const guardPane = () => {
    window.setTimeout(() => {
      try {
        const doc = frameRef?.contentDocument
        const empty = !doc || !doc.body || doc.body.childElementCount === 0
        if (empty) {
          console.warn("[amicode/split] pane booted empty — merging back")
          if (split.right) workbench.removePane(split.right.id)
          split.unsplit()
        }
      } catch {
        /* cross-origin (never in practice) — leave the pane alone */
      }
    }, 2500)
  }

  // amicode(workbench S2): drop targets are EXPLICIT and geometry-resolved
  // over a full-row shield: window edge rails (split), the main strip / panel
  // (move to main), a pane's strip region (move to that pane). Content areas
  // are never targets — the hair-trigger rule is absolute.
  type DropZone = "rail-left" | "rail-right" | "strip-main" | "panel" | "strip-pane"

  const zoneAt = (x: number, y: number): DropZone | undefined => {
    if (!rowRef) return undefined
    const rect = rowRef.getBoundingClientRect()
    if (x - rect.left < RAIL_PX) return "rail-left"
    if (rect.right - x < RAIL_PX) return "rail-right"
    const mainStrip = rowRef.querySelector("[data-split-main] .no-scrollbar")?.getBoundingClientRect()
    if (mainStrip && y >= mainStrip.top && y <= mainStrip.bottom && x >= mainStrip.left && x <= mainStrip.right)
      return "strip-main"
    const panel = rowRef.querySelector("[data-workbench-panel]")?.getBoundingClientRect()
    if (panel && y >= panel.top && y <= panel.bottom && x >= panel.left && x <= panel.right) return "panel"
    const pane = rowRef.querySelector("[data-pane]")?.getBoundingClientRect()
    if (pane && y >= pane.top && y <= pane.top + 36 && x >= pane.left && x <= pane.right) return "strip-pane"
    return undefined
  }

  const executeDrop = (zone: DropZone | undefined, drag: DragState) => {
    if (!zone) return
    if (zone === "rail-left" || zone === "rail-right") {
      // Singleton gate — but scoped to the clobber vectors: PANEL-originated
      // opens of an already-open session, pane-originated drops of one, and
      // DRAFTS always (two instances editing one draft's text silently
      // clobber). A STRIP-originated session split keeps both views — the
      // deliberate two-panes-one-session gesture the user validated.
      const isDraft = drag.path.startsWith("/new-session")
      const dupBlocked = drag.source === "panel" || drag.from !== MAIN_PANE_ID || isDraft
      if (dupBlocked && workbench.isOpen(drag.path)) return moveToMain(drag.path, drag.from)
      if (drag.from !== MAIN_PANE_ID) {
        // a pane's tab onto a rail = bring it home to the main strip
        moveToMain(drag.path, drag.from)
        return
      }
      if (zone === "rail-right") {
        split.splitWith(drag.path)
        return
      }
      const prev = `${location.pathname}${location.search}`
      navigate(drag.path)
      split.splitWith(prev)
      return
    }
    if (zone === "strip-main" || zone === "panel") return moveToMain(drag.path, drag.from)
    if (zone === "strip-pane") {
      const paneId = split.right?.id
      if (paneId) moveToPane(drag.path, paneId, drag.from)
    }
  }

  /** Move to the main strip. Singleton: already open there → just activate. */
  const moveToMain = (path: string, from: string) => {
    tabs.openPath(path, { activate: true })
    if (from !== MAIN_PANE_ID && !workbench.isOpen(path)) postCloseToSource(path, from)
  }

  /** Move to a pane's strip. Singleton: already open in it → focus instead.
   *  Liveness: a pane that never reported to the mirror is DEAD (blocked or
   *  crashed boot) — the drop is a no-op and the tab stays in its source
   *  (the fault-injection gate: nothing is ever lost into a dead pane). */
  const moveToPane = (path: string, paneId: string, from: string) => {
    if (!frameRef?.contentWindow || from === paneId) return
    if (!workbench.mirror[paneId]) {
      console.warn("[workbench] drop onto a pane that never reported — keeping the tab in", from)
      return
    }
    const openThere = workbench.mirror[paneId]?.tabs.includes(path)
    postWorkbench(frameRef.contentWindow, { kind: openThere ? "focus-tab" : "open-tab", path, activate: true }, paneOrigin())
    if (!openThere) postCloseToSource(path, from)
  }

  /** open-THEN-close: the source copy closes only after the open was issued;
   *  the mirror + singleton reconciliation (below) is the ack. */
  const postCloseToSource = (path: string, from: string) => {
    if (from === MAIN_PANE_ID) tabs.closePath(path)
    else if (frameRef?.contentWindow) postWorkbench(frameRef.contentWindow, { kind: "close-tab", path }, paneOrigin())
  }

  /** Singleton reconciliation: any path reported in 2+ panes keeps the FIRST
   *  copy (main wins) and closes elsewhere — duplicates cannot survive a
   *  report, however a drop went wrong. */
  const reconcileSingletons = () => {
    for (const path of new Set(Object.values(workbench.mirror).flatMap((m) => m.tabs))) {
      const holders = workbench.panesWith(path)
      if (holders.length < 2) continue
      for (const holder of holders.slice(1)) {
        console.warn("[workbench] singleton reconciliation: closing duplicate", path, "in", holder)
        if (holder === MAIN_PANE_ID) tabs.closePath(path)
        else if (frameRef?.contentWindow) postWorkbench(frameRef.contentWindow, { kind: "close-tab", path }, paneOrigin())
      }
    }
  }

  // Sash drag: pointer capture on the handle; the pane iframe takes
  // pointer-events:none so moves reach us.
  const startSash = (e: PointerEvent) => {
    const sash = e.currentTarget as HTMLElement
    sash.setPointerCapture(e.pointerId)
    if (frameRef) frameRef.style.pointerEvents = "none"
    const onMove = (ev: PointerEvent) => {
      if (!rowRef) return
      const rect = rowRef.getBoundingClientRect()
      split.setWidthPct(((rect.right - ev.clientX) / Math.max(rect.width, 1)) * 100)
    }
    const onUp = () => {
      if (frameRef) frameRef.style.pointerEvents = ""
      sash.removeEventListener("pointermove", onMove)
      sash.removeEventListener("pointerup", onUp)
    }
    sash.addEventListener("pointermove", onMove)
    sash.addEventListener("pointerup", onUp)
  }

  // In a pane (framed app), the split is inert: pass through — but KEEP the
  // titlebar (it lives in this slot since the layout hands it down here).
  if (IS_AMICODE_PANE)
    return (
      <>
        {props.titlebar && <div class="w-full flex-none">{props.titlebar}</div>}
        {props.children}
      </>
    )

  return (
    // w-full: <main> is `flex flex-col items-start` — without an explicit
    // width this row shrinks to its content and crushes both panes into
    // corner columns (the v1/v2 crush bug, seen in the e2e screenshots).
    //
    // amicode(workbench S2): drop resolution rides the ROW's own handlers —
    // dragover/drop bubble up from the content, so no hit-testable cover is
    // ever needed (a pointer-events:auto shield under an active native drag
    // thrashed the page into a lock — the S2.1 bisect). While a workbench tab
    // drag is live we preventDefault + stopPropagation so the composer's
    // file-drop never eats a tab; with no drag live, file drops pass through.
    <div
      ref={rowRef}
      class="relative h-full w-full min-h-0 min-w-0 flex flex-row"
      onDragOver={(e) => {
        if (!dragState()) return
        e.preventDefault()
        e.stopPropagation()
        setHot(zoneAt(e.clientX, e.clientY))
      }}
      onDragLeave={() => setHot(undefined)}
      onDrop={(e) => {
        if (!dragState()) return
        e.preventDefault()
        e.stopPropagation()
        const drag = dragState()
        const zone = zoneAt(e.clientX, e.clientY)
        clearDrag()
        if (drag) executeDrop(zone, drag)
        reconcileSingletons()
      }}
    >
      {/* main side — the live app, never reloaded by a split. Its titlebar
          renders INSIDE this column (handed down by the layout): full width
          when unsplit (identical to before), confined to the main side when
          split — so the pane's own titlebar sits at the same height and the
          two sides' content baselines align. */}
      <div data-split-main class="relative min-h-0 min-w-[280px] flex-1 flex flex-col">
        {props.titlebar && <div class="w-full flex-none">{props.titlebar}</div>}
        {/* amicode(workbench): the hideable sessions panel sits left of the
            routed content, inside the main column — visibility rides the
            titlebar's sidebar toggle (layout.sidebar, persisted). Workbench
            routes only: the home dashboard has its own session surfaces (the
            smoke-suite home broke when the panel muscled in there). */}
        <div class="relative min-h-0 flex-1 flex flex-row">
          <Show when={layout.sidebar.opened() && location.pathname !== "/"}>
            <WorkbenchPanel />
          </Show>
          <div class="relative min-h-0 flex-1 flex flex-col">{props.children}</div>
        </div>
      </div>

      <Show when={split.right}>
        {(right) => (
          <>
            <div class="group relative w-1 flex-none cursor-col-resize hover:bg-[var(--v2-border-border-focus)]" onPointerDown={startSash}>
              {/* merge control on the sash — the pane's only extra chrome, so
                  both sides' content starts at the same height */}
              <button
                class="absolute left-1/2 top-1/2 z-10 flex size-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-[var(--v2-border-border-base)] bg-[var(--v2-background-bg-deep)] text-[10px] text-v2-text-text-faint opacity-70 hover:opacity-100"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  split.unsplit()
                }}
                aria-label="Merge pane back"
                title="Merge pane back"
              >
                ✕
              </button>
            </div>
            <section data-pane class="relative flex min-h-0 min-w-0 flex-col" style={{ width: `${right().widthPct}%` }}>
              {/* No parent header: the pane's OWN titlebar is the chrome, so
                  both sides' content baselines align (the "weird offset"). The
                  merge control lives on the sash instead. */}
              <iframe
                ref={frameRef}
                src={paneSrc(right())}
                onLoad={guardPane}
                class="min-h-0 flex-1 border-0"
                allow="clipboard-read; clipboard-write"
                sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-downloads"
              />
              {/* amicode(workbench S2): the drop cover — pointer-events:auto
                  ONLY over the pane area, ONLY while a drag is live, and NEVER
                  over the drag's source (a cover under the active drag locked
                  the page; S2.1/S2.4 bisects). Drops here resolve exactly like
                  row-bubbled drops. */}
              <Show when={dragState() && dragState()?.from !== right().id}>
                <div
                  data-pane-drop-cover
                  class="absolute inset-0 z-40"
                  classList={{ "bg-[var(--v2-overlay-simple-overlay-pressed)]": hot() === "strip-pane" }}
                  onDragOver={(e) => {
                    if (!dragState()) return
                    e.preventDefault()
                    e.stopPropagation()
                    setHot(zoneAt(e.clientX, e.clientY))
                  }}
                  onDragLeave={() => setHot(undefined)}
                  onDrop={(e) => {
                    if (!dragState()) return
                    e.preventDefault()
                    e.stopPropagation()
                    const drag = dragState()
                    const zone = zoneAt(e.clientX, e.clientY)
                    clearDrag()
                    if (drag) executeDrop(zone, drag)
                    reconcileSingletons()
                  }}
                />
              </Show>
            </section>
          </>
        )}
      </Show>

      {/* drag visuals ONLY — never hit-testable (pointer-events:none always):
          the rails light up during a drag; resolution rides the row handlers. */}
      <div data-drag-visuals class="pointer-events-none absolute inset-0 z-50">
        <div
          data-rail="left"
          class="absolute inset-y-0 left-0 transition-colors"
          classList={{
            "bg-[var(--v2-overlay-simple-overlay-pressed)]": !!dragState(),
            "outline outline-1 outline-[var(--v2-border-border-focus)]": hot() === "rail-left",
            "opacity-0": !dragState(),
          }}
          style={{ width: `${RAIL_PX}px` }}
        />
        <div
          data-rail="right"
          class="absolute inset-y-0 right-0 transition-colors"
          classList={{
            "bg-[var(--v2-overlay-simple-overlay-pressed)]": !!dragState(),
            "outline outline-1 outline-[var(--v2-border-border-focus)]": hot() === "rail-right",
            "opacity-0": !dragState(),
          }}
          style={{ width: `${RAIL_PX}px` }}
        />
      </div>
    </div>
  )
}
