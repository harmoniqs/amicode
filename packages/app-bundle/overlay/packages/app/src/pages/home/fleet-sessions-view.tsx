// The merged sessions VIEW (amicissimo#393, Slice C): the thin Solid consumer
// of the fleet-sessions view-model. Rendered AROUND the home flyout's base
// sessions list, which passes through verbatim whenever the view is absent
// (no entitlement — the H3 byte-identity discipline), the probe is still in
// flight, or the hub is down (standalone-pointer: the base standalone posture
// runs, the service's honest pointer surfaces above it).
//
// In fleet/degraded posture the merged projection REPLACES the base list —
// both stores in one list, every row provenance-tagged — and any posture
// transition (the refetch_epoch) refetches BEFORE first render: the rendered
// rows go stale and an honest loading state takes their place, never
// stale-as-current.
import { For, Show, type JSX, createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { useLanguage } from "@/context/language"
import type { ServerConnection } from "@/context/server"
import { amicodeGet } from "@/utils/amicode-fetch"
import {
  currencyTokensCompatible,
  fleetProjectionView,
  fleetSessionsListState,
  fleetStatusView,
  type FleetProjectionView,
  type FleetSessionRow,
  type FleetStatusView,
} from "./fleet-sessions"

const FLEET_ROW =
  "flex h-7 min-w-0 w-full shrink-0 cursor-default items-center gap-2 rounded-sm border-0 bg-transparent px-1.5 py-0 text-left text-v2-text-text-muted [font-weight:440] transition-[background-color,color,box-shadow] duration-[120ms] ease-in-out hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:text-v2-text-text-base focus-visible:outline-none disabled:cursor-default disabled:opacity-60"
const FLEET_ROW_TITLE = "min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap"
const FLEET_POINTER =
  "mb-2 rounded-sm border border-v2-border-border-base bg-v2-background-bg-layer-01 px-2 py-1.5 text-[11px] leading-4 text-v2-text-text-muted [font-weight:440]"
const FLEET_PROVENANCE_PILL =
  "shrink-0 rounded-xs border border-v2-border-border-base px-1 py-0.5 text-[9px] leading-none uppercase tracking-wide text-v2-text-text-faint"

const STATUS_POLL_MS = 5_000

export function FleetSessions(props: {
  server: ServerConnection.Any | undefined
  onOpenSession: (row: FleetSessionRow) => void
  /** The base sessions list — rendered verbatim whenever the fleet view is
   *  absent, the probe is pending, or the hub is down (the base standalone
   *  posture keeps running). */
  children: JSX.Element
}) {
  const language = useLanguage()
  const [status, setStatus] = createSignal<FleetStatusView | undefined>(undefined)
  const [projection, setProjection] = createSignal<FleetProjectionView | undefined>(undefined)
  const [renderedEpoch, setRenderedEpoch] = createSignal<number | undefined>(undefined)

  const loadStatus = async () => {
    let raw: unknown
    try {
      raw = await amicodeGet(props.server, "/amicode/fleet/status")
    } catch {
      raw = undefined // a 404 (no entitlement) or any failure → the view does not exist
    }
    setStatus(fleetStatusView(raw))
  }

  const loadProjection = async (epoch: number | undefined) => {
    let raw: unknown
    try {
      raw = await amicodeGet(props.server, "/amicode/fleet/sessions")
    } catch {
      return // keep the honest loading state; the next posture tick retries
    }
    const next = fleetProjectionView(raw)
    setProjection((prev) =>
      // D2 currency honesty: a refetch that is currency-compatible with what
      // is rendered (same sources, same token) changes nothing — keep the
      // rendered rows. Tokens over different source sets are never compared;
      // an incompatible token replaces the render.
      currencyTokensCompatible(prev?.currency ?? null, next.currency) ? prev : next,
    )
    setRenderedEpoch(epoch)
  }

  onMount(() => void loadStatus())

  // The posture tick: status polls; a transition (refetch_epoch bump) or a
  // first view under fleet/degraded triggers the projection refetch.
  createEffect(() => {
    const s = status()
    if (!s?.exists) return
    const posture = s.posture
    if (posture?.state === "standalone") return
    const epoch = posture?.refetchEpoch
    if (renderedEpoch() !== epoch) void loadProjection(epoch)
  })
  createEffect(() => {
    const timer = setInterval(() => void loadStatus(), STATUS_POLL_MS)
    onCleanup(() => clearInterval(timer))
  })

  const view = () =>
    fleetSessionsListState({ status: status(), projection: projection(), renderedEpoch: renderedEpoch() })
  const rows = () => {
    const list = [...(projection()?.rows ?? [])]
    list.sort((a, b) => (b.updated ?? -1) - (a.updated ?? -1))
    return list
  }

  return (
    <Show
      when={view().state === "merged" || view().state === "degraded"}
      fallback={
        <>
          <Show when={view().state === "standalone-pointer"}>
            <p data-component="fleet-sessions-pointer" class={FLEET_POINTER}>
              {view().pointer}
            </p>
          </Show>
          <Show when={view().state === "loading" || view().state === "stale"}>
            <FleetSessionsSkeleton label={language.t("common.loading")} />
          </Show>
          <Show when={view().state === "base" || view().state === "absent"}>{props.children}</Show>
        </>
      }
    >
      <Show when={view().state === "degraded"}>
        <p data-component="fleet-sessions-degraded" class={FLEET_POINTER}>
          {language.t("fleet.sessions.degraded")}
        </p>
      </Show>
      <div class="flex min-w-0 flex-col gap-px" data-component="fleet-sessions-list">
        <For each={rows()}>{(row) => <FleetSessionRowView row={row} onOpen={props.onOpenSession} />}</For>
        <Show when={rows().length === 0}>
          <p class="px-1.5 py-2 text-[12px] text-v2-text-text-faint" data-component="fleet-sessions-empty">
            {language.t("home.sessions.empty")}
          </p>
        </Show>
      </div>
    </Show>
  )
}

function FleetSessionRowView(props: { row: FleetSessionRow; onOpen: (row: FleetSessionRow) => void }) {
  const language = useLanguage()
  const canOpen = () => !!(props.row.id && props.row.directory)
  return (
    <div class="group/session relative flex h-7 min-w-0 items-center rounded-sm">
      <button
        type="button"
        data-component="fleet-session-row"
        data-provenance={props.row.provenance ?? "untagged"}
        class={FLEET_ROW}
        disabled={!canOpen()}
        onClick={() => canOpen() && props.onOpen(props.row)}
      >
        <Show when={props.row.provenance !== null}>
          <span data-component="fleet-session-provenance" class={FLEET_PROVENANCE_PILL}>
            {props.row.provenance === "hub"
              ? language.t("fleet.sessions.provenance.hub")
              : language.t("fleet.sessions.provenance.local")}
          </span>
        </Show>
        <span class={FLEET_ROW_TITLE}>{props.row.title}</span>
      </button>
    </div>
  )
}

function FleetSessionsSkeleton(props: { label: string }) {
  return (
    <div class="flex min-w-0 flex-col gap-px" aria-hidden="true" data-component="fleet-sessions-skeleton">
      <For each={[0, 1, 2, 3]}>
        {() => <div class="h-7 rounded-sm bg-v2-background-bg-deep opacity-70" />}
      </For>
    </div>
  )
}
