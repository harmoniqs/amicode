// amicode#1989 (#1979 S6): the composer's dead-pick warning. Two triggers,
// one surface, never silent:
//  - the session's latest assistant turn failed with a reachability-class
//    error (denied / unavailable / invalid) → POST the S2 demotion (once per
//    model per session) and overlay it locally, so the warning shows even if
//    the POST fails or the host serves no reachability route;
//  - the selected model is already dead per the S2 snapshot → warn before
//    the user sends.
// The warning names the model and the reason, with a one-click switch to the
// recommended equivalent (rules in model-dead-pick.ts). Transient failures
// (rate limits, TLS, timeouts, 5xx) never demote and never warn here.
import { type Accessor, Show, createEffect, createMemo } from "solid-js"
import { useLanguage } from "@/context/language"
import { useLocal } from "@/context/local"
import { useServer } from "@/context/server"
import { useSync } from "@/context/sync"
import { amicodePost } from "@/utils/amicode-fetch"
import { createModelReachability } from "./dialog-select-model-reachability-source"
import { createModelShortlistConfig } from "./dialog-select-model-shortlist-source"
import {
  REACHABILITY_DEMOTE_ROUTE,
  applyTurnFailure,
  createDemoteGate,
  deadPickWarning,
  demoteRequest,
  latestTurnFailure,
  recommendedSwitchTargets,
  shouldDemote,
  type DeadPickCandidate,
} from "./model-dead-pick"
import type { ModelRef } from "./dialog-select-model-reachability"

export function ModelDeadPickWarning(props: { sessionID?: Accessor<string | undefined> }) {
  const language = useLanguage()
  const local = useLocal()
  const server = useServer()
  const sync = useSync()
  const reachability = createModelReachability()
  const config = createModelShortlistConfig()
  const gate = createDemoteGate()

  const failure = createMemo(() => {
    const id = props.sessionID?.()
    if (!id) return undefined
    return latestTurnFailure(sync().data.message[id] ?? [])
  })

  createEffect(() => {
    const id = props.sessionID?.()
    const failed = failure()
    if (!id || !failed || reachability.loading()) return
    if (!shouldDemote(failed, reachability.snapshot())) return
    if (!gate.claim(id, failed.ref)) return
    void amicodePost(server.current, REACHABILITY_DEMOTE_ROUTE, demoteRequest(failed))
      .catch(() => {
        // the local overlay below still names the failure — never silent
      })
      .finally(() => reachability.refetch())
  })

  const candidates = createMemo<DeadPickCandidate[]>(() =>
    local.model.list().map((m) => ({
      providerID: m.provider.id,
      modelID: m.id,
      cost: m.cost ? { input: m.cost.input, output: m.cost.output } : undefined,
    })),
  )

  const nameOf = (ref: ModelRef) =>
    local.model.list().find((m) => m.provider.id === ref.providerID && m.id === ref.modelID)?.name ?? ref.modelID

  const warning = createMemo(() => {
    const current = local.model.current()
    return deadPickWarning({
      current: current ? { providerID: current.provider.id, modelID: current.id } : undefined,
      snapshot: applyTurnFailure(reachability.snapshot(), failure()),
      candidates: candidates(),
      // amicode#1988: the S4 deployment config's recommended list (role order,
      // allowlist-filtered); no config ⇒ the cheapest ok same-provider model.
      recommended: recommendedSwitchTargets(config()),
    })
  })

  return (
    <Show when={warning()} keyed>
      {(w) => {
        const reason = w.reason
          ? "key" in w.reason
            ? language.t(w.reason.key)
            : w.reason.text
          : language.t("composer.model.deadPick.reason.unknown")
        return (
          <div
            data-component="amicode-model-dead-pick"
            data-status={w.status}
            role="alert"
            class="mb-2 flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border-weak-base bg-background-base px-3 py-2 text-14-regular"
          >
            <span class="min-w-0 flex-1 text-text-warning">
              {language.t("composer.model.deadPick.warning", { model: nameOf(w.model), reason })}
            </span>
            <Show
              when={w.switchTo}
              fallback={<span class="text-text-weak">{language.t("composer.model.deadPick.noAlternative")}</span>}
            >
              {(target) => (
                <button
                  type="button"
                  data-action="amicode-model-dead-pick-switch"
                  class="shrink-0 text-text-base underline-offset-2 transition-colors hover:text-text-strong hover:underline"
                  onClick={() => local.model.set(target(), { recent: true })}
                >
                  {language.t("composer.model.deadPick.switch", { model: nameOf(target()) })}
                </button>
              )}
            </Show>
          </div>
        )
      }}
    </Show>
  )
}
