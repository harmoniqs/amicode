// amicode#2001: the What's-new landing page. Shown as an overlay ABOVE the
// session view on the first open after the version changes — the session
// underneath stays mounted, so Continue (or Esc) records the version as seen
// and simply reveals the session that was open. Reopened from the command
// palette ("Amicode: What's New" → open-whats-new) and the status popover.
// One Continue, no tour. amicode#2020: a fixed frame (pinned header + footer,
// only the cards scroll); the markup is whats-new-view.tsx, the decisions
// (expanded cards, clamp, ordering, keys) are whats-new-model.ts. Content:
// GET /amicode/releases (bundled notes, works offline); which cards and the
// "new for you" arrivals come from the service.
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { amicodeGet } from "@/utils/amicode-fetch"
import { inAmicode } from "@/utils/amicode-bridge"
import {
  buildCardViews,
  initialExpanded,
  notesLink,
  onWhatsNewRequest,
  parseReleasesBody,
  releasesRoute,
  requestWhatsNew,
  resolveLastSeen,
  summaryLine,
  toggleIn,
  whatsNewKeyHandler,
  writeLastSeenLocal,
  type WhatsNewPayload,
} from "./whats-new-model"
import { WhatsNewCardView, WhatsNewFrame, WhatsNewWelcome, focusContinue } from "./whats-new-view"

const QUERY_TIMEOUT_MS = 1500

/** Ask the extension host for its globalState last-seen version. */
function queryExtension(): Promise<string | null | undefined> {
  return new Promise((resolve) => {
    const done = (v: string | null | undefined) => {
      window.removeEventListener("message", onMsg)
      clearTimeout(timer)
      resolve(v)
    }
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { source?: string; kind?: string; lastSeen?: unknown } | undefined
      if (d?.source !== "amicode" || d.kind !== "whats-new-state") return
      done(typeof d.lastSeen === "string" ? d.lastSeen : null)
    }
    const timer = setTimeout(() => done(undefined), QUERY_TIMEOUT_MS)
    window.addEventListener("message", onMsg)
    try {
      window.parent?.postMessage({ source: "amicode", kind: "whats-new-query" }, "*")
    } catch {
      done(undefined)
    }
  })
}

const storage = () => {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

const ROOT = '[data-component="amicode-whats-new"]'

/** A toggled card re-renders; put keyboard focus back on the control that was used. */
const refocus = (selector: string) =>
  queueMicrotask(() => (document.querySelector(`${ROOT} ${selector}`) as HTMLElement | null)?.focus())

export function AmicodeWhatsNew() {
  const server = useServer()
  const platform = usePlatform()
  const [page, setPage] = createSignal<WhatsNewPayload | undefined>()
  // amicode#2020: the newest card starts expanded, older ones collapsed.
  const [expanded, setExpanded] = createSignal<string[]>([])
  const [more, setMore] = createSignal<string[]>([])
  let checked = false

  const open = (p: WhatsNewPayload) => {
    setExpanded(initialExpanded(p.cards))
    setMore([])
    setPage(p)
  }
  // Focus lands on Continue when the page opens.
  createEffect(() => {
    if (page()) setTimeout(() => focusContinue(document), 0)
  })

  const load = async (since: string | null) => {
    const conn = server.current
    if (!conn) return undefined
    return parseReleasesBody(await amicodeGet(conn, releasesRoute(since)).catch(() => undefined))
  }

  // The first open after the version changes: once per boot, once a server is up.
  createEffect(() => {
    const conn = server.current
    if (!conn || checked) return
    checked = true
    void (async () => {
      const since = await resolveLastSeen({
        framed: inAmicode(),
        query: queryExtension,
        storage: storage(),
        serverUrl: conn.http.url,
      })
      const p = await load(since)
      if (p?.show) open(p)
    })()
  })

  // Reopen (palette command / status popover): the full bundled history.
  const reopen = async () => {
    const p = await load("0.0.0")
    if (p) open({ ...p, welcome: p.cards.length === 0 })
  }
  onCleanup(onWhatsNewRequest(() => void reopen()))
  const onBridge = (e: MessageEvent) => {
    const d = e.data as { source?: string; kind?: string } | undefined
    if (d?.source === "amicode" && d.kind === "open-whats-new") void reopen()
  }
  window.addEventListener("message", onBridge)
  onCleanup(() => window.removeEventListener("message", onBridge))

  const dismiss = () => {
    const p = page()
    if (!p) return
    setPage(undefined)
    const conn = server.current
    if (conn) writeLastSeenLocal(storage(), conn.http.url, p.current)
    if (inAmicode()) {
      try {
        window.parent?.postMessage({ source: "amicode", kind: "whats-new-seen", version: p.current }, "*")
      } catch {}
    }
  }

  // Enter and Esc both dismiss (Enter yields to inputs / other controls).
  const keys = whatsNewKeyHandler(dismiss)
  const onKey = (e: KeyboardEvent) => {
    if (page()) keys(e)
  }
  window.addEventListener("keydown", onKey, { capture: true })
  onCleanup(() => window.removeEventListener("keydown", onKey, { capture: true }))

  return (
    <Show when={page()}>
      {(p) => {
        const views = createMemo(() => buildCardViews(p(), expanded(), more()))
        return (
          <WhatsNewFrame
            title={p().welcome ? "Welcome to Amicode" : "What's new in Amicode"}
            version={p().current}
            summary={summaryLine(p())}
            notesHref={notesLink(p())}
            onContinue={dismiss}
            onOpenNotes={(href) => platform.openExternal(href)}
          >
            <Show when={p().welcome}>
              <WhatsNewWelcome />
            </Show>
            {/* one slot per version: a toggle re-renders only that card, so the
                scroll region (and its scroll position) is never rebuilt */}
            <For each={p().cards.map((c) => c.version)}>
              {(version) => {
                const view = createMemo(() => views().find((c) => c.version === version)!, undefined, {
                  equals: (a, b) => JSON.stringify(a) === JSON.stringify(b),
                })
                return (
                  <>
                    {(() => (
                      <WhatsNewCardView
                        card={view()}
                        onToggleCard={(v) => {
                          setExpanded((l) => toggleIn(l, v))
                          refocus(`[data-version="${v}"] [data-slot="whats-new-card-toggle"]`)
                        }}
                        onToggleMore={(k) => {
                          setMore((l) => toggleIn(l, k))
                          refocus(`[data-slot="whats-new-more"][data-key="${k}"]`)
                        }}
                      />
                    ))()}
                  </>
                )
              }}
            </For>
          </WhatsNewFrame>
        )
      }}
    </Show>
  )
}

/** amicode#2001: the status-popover entry — reopens the page. */
export function WhatsNewStatusEntry(props: { onClose?: () => void }) {
  return (
    <div class="flex px-4 pb-3">
      <button
        type="button"
        data-action="amicode-whats-new"
        class="text-12-regular text-text-weak hover:text-text-base"
        onClick={() => {
          props.onClose?.()
          requestWhatsNew()
        }}
      >
        What's new in Amicode
      </button>
    </div>
  )
}
