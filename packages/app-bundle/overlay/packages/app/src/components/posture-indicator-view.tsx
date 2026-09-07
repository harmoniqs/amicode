// The posture indicator VIEW (S2, spec-20260907-011500 D2, #859): the thin
// Solid consumer of the posture-indicator view-model.
//
// Ambient-when-ignored (the observability clause): collapsed/quiet until
// there is a recommendation — the offer banner is the one thing that asserts
// itself; the collapsed row expands on click (inspectable on demand). When
// the route does not exist the view renders NOTHING (never a dead widget).
//
// The switch is the Tab-switch contract made product: `local.agent.set` IS
// the mid-session re-bind (the next prompt carries the new posture's card);
// in a session it also lands the posture change on the session record
// (session.update metadata — the ADR-0011 vNext additive surface, fire-
// and-forget: a harness without the metadata field still gets the binding).
// plan.auto_switch = auto defers the click to the TURN BOUNDARY (never mid-
// generation), announces, and preserves state — only the agent binding
// changes, so the session's draft and pending questions ride along.
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useParams } from "@solidjs/router"
import { useLanguage } from "@/context/language"
import { useLocal } from "@/context/local"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { useSync } from "@/context/sync"
import type { ServerConnection } from "@/context/server"
import { amicodeGet, amicodePost } from "@/utils/amicode-fetch"
import {
  deferredSwitchTick,
  postureBodyView,
  postureIndicatorState,
  switchDecision,
  switchEffect,
  type PostureBodyView,
} from "./posture-indicator"

const POLL_MS = 15_000
const ANNOUNCE_MS = 6_000

const WRAP = "flex flex-col gap-1.5 rounded-sm border border-v2-border-border-base bg-v2-background-bg-layer-01 px-2 py-1.5 text-[11px] leading-4 text-v2-text-text-muted [font-weight:440]"
const QUIET =
  "flex h-7 min-w-0 w-full shrink-0 items-center gap-2 rounded-sm border border-v2-border-border-base bg-transparent px-1.5 py-0 text-left text-[11px] text-v2-text-text-muted transition-[background-color,color] duration-[120ms] ease-in-out hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base cursor-pointer"
const ROW_BTN =
  "cursor-pointer rounded-xs border border-v2-border-border-base px-1.5 py-0.5 text-[10px] leading-none text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base"
const REASON = "min-w-0 flex-1 overflow-hidden text-ellipsis"

export function PostureIndicator(props: { server: ServerConnection.Any | undefined }) {
  const language = useLanguage()
  const local = useLocal()
  const sync = useSync()
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const params = useParams()

  const [body, setBody] = createSignal<PostureBodyView | undefined>(undefined)
  const [expanded, setExpanded] = createSignal(false)
  const [announcement, setAnnouncement] = createSignal<{ kind: "switched" | "deferred"; mode: string } | undefined>(undefined)
  const [pending, setPending] = createSignal<{ target: string; planHash: string | null } | undefined>(undefined)

  const load = async () => {
    let raw: unknown
    try {
      raw = await amicodeGet(props.server, "/amicode/posture")
    } catch {
      setBody(undefined) // a 404 (older extension) or any failure → the view does not exist
      return
    }
    setBody(postureBodyView(raw))
  }

  onMount(() => {
    void load()
    const timer = setInterval(() => void load(), POLL_MS)
    onCleanup(() => clearInterval(timer))
  })

  const sessionID = createMemo(() => params.id || undefined)
  const statusType = createMemo(() => {
    const id = sessionID()
    if (!id) return undefined
    const statuses = (sync().data as unknown as Record<string, Record<string, { type?: string }> | undefined>)["session_status"]
    return statuses?.[id]?.type
  })
  const currentAgent = createMemo(() => local.agent.current()?.name)
  const view = createMemo(() => postureIndicatorState({ body: body(), currentAgent: currentAgent() }))
  const offer = createMemo(() => {
    const v = view()
    return v.state === "offer" ? v : undefined
  })
  const quiet = createMemo(() => {
    const v = view()
    return v.state === "quiet" ? v : undefined
  })

  const announce = (kind: "switched" | "deferred", mode: string) => {
    setAnnouncement({ kind, mode })
    setTimeout(() => setAnnouncement(undefined), ANNOUNCE_MS)
  }

  /** The Tab-switch contract, made product: re-bind the agent; land the
   *  posture change on the session record (additive metadata, fire-and-
   *  forget); ONLY the binding changes — the draft and pending questions
   *  ride along untouched. */
  const executeSwitch = (target: string) => {
    const effect = switchEffect(target)
    local.agent.set(effect.agent)
    const id = sessionID()
    if (id) {
      try {
        void Promise.resolve(
          serverSDK().client.session.update({
            sessionID: id,
            directory: sdk().directory,
            metadata: effect.sessionRecord,
          }),
        ).catch(() => {}) // the binding already landed; the record write is additive
      } catch {
        // an SDK without the metadata surface — the binding is the contract
      }
    }
    setPending(undefined)
    announce("switched", target)
  }

  const switchClick = (target: string) => {
    const decision = switchDecision({
      target,
      autoSwitch: body()?.autoSwitch ?? "confirm",
      statusType: statusType(),
    })
    if (decision.defer) {
      setPending({ target, planHash: body()?.plan?.planHash ?? null })
      announce("deferred", target)
      return
    }
    executeSwitch(target)
  }

  const dismissClick = () => {
    const hash = body()?.plan?.planHash
    if (hash) {
      void amicodePost(props.server, "/amicode/posture/dismiss", { plan_hash: hash })
        .then(() => load())
        .catch(() => {})
    } else {
      void load()
    }
  }

  // The turn boundary: the deferred switch fires when the session goes idle,
  // drops when a newer plan superseded the queued one.
  createEffect(() => {
    const p = pending()
    if (!p) return
    const tick = deferredSwitchTick({
      pending: p,
      statusType: statusType(),
      latestPlanHash: body()?.plan?.planHash ?? undefined,
    })
    if (tick.action === "fire" && tick.target !== undefined) executeSwitch(tick.target)
    else if (tick.action === "drop") setPending(undefined)
  })

  // The mode ids are product nouns; the key lookup is typed over the
  // dictionary (dynamic keys are never handed to t untyped).
  const MODE_KEYS: Record<string, Parameters<typeof language.t>[0]> = {
    plan: "posture.mode.plan",
    develop: "posture.mode.develop",
    research: "posture.mode.research",
    build: "posture.mode.build",
  }
  const modeName = (mode: string) => language.t(MODE_KEYS[mode] ?? "posture.mode.plan")

  return (
    <Show when={view().state !== "absent"}>
      <div data-component="posture-indicator" class={WRAP}>
        <Show when={offer()} keyed>
          {(o) => (
            <>
              <div class="flex items-center gap-2" data-part="offer-head">
                <span data-part="offer-title" class="shrink-0 text-v2-text-text-base [font-weight:600]">
                  {o.recommendation.kind === "ambiguous"
                    ? language.t("posture.offer.ambiguous")
                    : language.t("posture.offer.recommend", {
                        mode: modeName(o.recommendation.kind === "recommend" ? o.recommendation.mode : "plan"),
                      })}
                </span>
                <span data-part="offer-reason" class={REASON} title={o.recommendation.reason}>
                  {o.recommendation.reason}
                </span>
              </div>
              <div class="flex flex-wrap items-center gap-1" data-part="offer-actions">
                <For each={o.affordances.targets}>
                  {(target, i) => (
                    <button type="button" class={ROW_BTN} data-part={i() === 0 ? "offer-confirm" : "offer-wrong"} onClick={() => switchClick(target)}>
                      {i() === 0
                        ? language.t("posture.offer.switch", { mode: modeName(target) })
                        : language.t("posture.offer.wrong", { mode: modeName(target) })}
                    </button>
                  )}
                </For>
                <Show when={o.affordances.stay}>
                  <button type="button" class={ROW_BTN} data-part="offer-stay" onClick={dismissClick}>
                    {language.t("posture.offer.stay")}
                  </button>
                </Show>
                <Show when={o.affordances.dismiss}>
                  <button type="button" class={ROW_BTN} data-part="offer-dismiss" onClick={dismissClick}>
                    {language.t("posture.offer.dismiss")}
                  </button>
                </Show>
              </div>
            </>
          )}
        </Show>
        <Show when={quiet()} keyed>
          {(q) => (
            <>
              <button type="button" class={QUIET} data-part="quiet-row" onClick={() => setExpanded(!expanded())}>
                <span data-part="quiet-label" class="shrink-0">
                  {language.t("posture.indicator.label")}
                </span>
                <span data-part="quiet-mode" class={REASON}>
                  {language.t("posture.current", { mode: modeName(q.current) })}
                </span>
              </button>
              <Show when={expanded() && q.walkBack}>
                <div class="flex items-center gap-1" data-part="walkback">
                  <button type="button" class={ROW_BTN} data-part="walkback-return" onClick={() => switchClick("plan")}>
                    {language.t("posture.walkback")}
                  </button>
                </div>
              </Show>
            </>
          )}
        </Show>
        <Show when={announcement()} keyed>
          {(a) => (
            <p data-part="announcement" class="m-0 text-v2-text-text-faint">
              {a.kind === "deferred"
                ? language.t("posture.switched.deferred", { mode: modeName(a.mode) })
                : language.t("posture.switched.announce", { mode: modeName(a.mode) })}
            </p>
          )}
        </Show>
      </div>
    </Show>
  )
}
