// amicode#2001: the What's-new landing page. Shown as an overlay ABOVE the
// session view on the first open after the version changes — the session
// underneath stays mounted, so Continue (or Esc) records the version as seen
// and simply reveals the session that was open. Reopened from the command
// palette ("Amicode: What's New" → open-whats-new) and the status popover.
// One Continue, no tour. Content: GET /amicode/releases (bundled notes, works
// offline); the decisions live in whats-new-model.ts + the service.
import { Button } from "@opencode-ai/ui/button"
import { For, Show, createEffect, createSignal, onCleanup } from "solid-js"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { amicodeGet } from "@/utils/amicode-fetch"
import { inAmicode } from "@/utils/amicode-bridge"
import {
  onWhatsNewRequest,
  parseReleasesBody,
  releasesRoute,
  requestWhatsNew,
  resolveLastSeen,
  writeLastSeenLocal,
  type WhatsNewPayload,
} from "./whats-new-model"

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

const fmtDate = (d: string) => {
  const t = Date.parse(`${d}T00:00:00Z`)
  return Number.isFinite(t)
    ? new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })
    : d
}

export function AmicodeWhatsNew() {
  const server = useServer()
  const platform = usePlatform()
  const [page, setPage] = createSignal<WhatsNewPayload | undefined>()
  let checked = false

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
      if (p?.show) setPage(p)
    })()
  })

  // Reopen (palette command / status popover): the full bundled history.
  const reopen = async () => {
    const p = await load("0.0.0")
    if (p) setPage({ ...p, welcome: p.cards.length === 0 })
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

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !page()) return
    e.preventDefault()
    e.stopPropagation()
    dismiss()
  }
  window.addEventListener("keydown", onKey, { capture: true })
  onCleanup(() => window.removeEventListener("keydown", onKey, { capture: true }))

  return (
    <Show when={page()}>
      {(p) => (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="What's new in Amicode"
          data-component="amicode-whats-new"
          class="fixed inset-0 z-[200] flex justify-center overflow-y-auto bg-background-base"
        >
          <div class="flex flex-col gap-5 w-full max-w-[640px] px-6 py-10">
            <div class="flex flex-col gap-1">
              <div class="text-16-medium text-text-strong">
                {p().welcome ? "Welcome to Amicode" : "What's new in Amicode"}
              </div>
              <div class="text-12-regular text-text-weak">Version {p().current}</div>
            </div>

            <Show when={p().welcome}>
              <div class="flex flex-col gap-2 p-4 rounded-lg bg-[var(--v2-background-bg-base)] shadow-[var(--shadow-lg-border-base)]">
                <div class="text-14-medium text-text-strong">Conversational research, in your editor</div>
                <div class="text-14-regular text-text-base">
                  Start a session and describe what you want to explore. Amicode connects your vaults, models and
                  compute, and runs the work where you can watch it. This page comes back after each update with
                  what changed.
                </div>
              </div>
            </Show>

            <For each={p().cards}>
              {(card, i) => (
                <div class="flex flex-col gap-3 p-4 rounded-lg bg-[var(--v2-background-bg-base)] shadow-[var(--shadow-lg-border-base)]">
                  <div class="flex items-baseline justify-between gap-2">
                    <div class="text-14-medium text-text-strong">{card.version}</div>
                    <div class="text-12-regular text-text-weak">{fmtDate(card.date)}</div>
                  </div>
                  <For each={card.highlights}>
                    {(h) => (
                      <div class="flex flex-col gap-0.5">
                        <div class="text-14-medium text-text-base">{h.title}</div>
                        <Show when={h.body}>
                          <div class="text-13-regular text-text-weak">{h.body}</div>
                        </Show>
                      </div>
                    )}
                  </For>
                  <Show when={i() === 0 && p().newForYou.length > 0}>
                    <div class="flex flex-col gap-1 pt-1" data-slot="new-for-you">
                      <div class="text-12-medium text-text-strong">New for you</div>
                      <div class="text-12-regular text-text-weak">Models now available to your account:</div>
                      <For each={p().newForYou}>
                        {(m) => (
                          <div class="text-13-regular text-text-base">
                            {m.model} <span class="text-text-weak">· {m.provider}</span>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                  <Show when={card.body}>
                    <div class="text-13-regular text-text-weak whitespace-pre-line">{card.body}</div>
                  </Show>
                  <Show when={card.notes}>
                    {(href) => (
                      <a
                        class="text-12-regular text-text-weak underline self-start"
                        href={href()}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => {
                          e.preventDefault()
                          platform.openExternal(href())
                        }}
                      >
                        Full release notes
                      </a>
                    )}
                  </Show>
                </div>
              )}
            </For>

            <Button variant="primary" class="self-start h-8 px-4" onClick={dismiss} autofocus>
              Continue
            </Button>
          </div>
        </div>
      )}
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
