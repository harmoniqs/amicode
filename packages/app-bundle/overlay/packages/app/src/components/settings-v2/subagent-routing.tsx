// The subagent model-routing settings section (S3, spec-20260907-011500 D3,
// amicode#860) — the thin Solid consumer of the subagent-routing view-model.
//
// A settings tab is EXPLICITLY USER-INVOKED: the observability clause's
// full-visibility surface — every row shows its provenance
// (user-set / fleet-locked / tuned / suggested / default), the display-only
// suggestion, and the drift + reset-to-tuned seat. Edits write the user-set
// tier through the service (POST /amicode/model-routing); the opt-in flag is
// the zero-config fold's bridge. When the route does not exist (older
// extension, degraded engine-origin framing) the section renders the
// unavailable note — never a dead table.
import { Show, createSignal, For, onMount } from "solid-js"
import type { Component } from "solid-js"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { amicodeGet, amicodePost } from "@/utils/amicode-fetch"
import { routingBodyView, rowDisplay, type RoutingBodyView, type RoutingRoleRow } from "../subagent-routing"

const ROW =
  "flex items-center gap-3 rounded-sm border border-v2-border-border-base bg-transparent px-2 py-1.5 text-[12px] leading-4 text-v2-text-text-muted"
const CHIP =
  "shrink-0 rounded-xs border border-v2-border-border-base px-1.5 py-0.5 text-[10px] leading-none text-v2-text-text-faint"
const BTN =
  "cursor-pointer rounded-xs border border-v2-border-border-base px-1.5 py-0.5 text-[10px] leading-none text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base"
const INPUT =
  "h-6 w-56 rounded-xs border border-v2-border-border-base bg-transparent px-1.5 text-[11px] text-v2-text-text-base"

export const SettingsSubagentRoutingV2: Component = () => {
  const language = useLanguage()
  const server = useServer()
  const [view, setView] = createSignal<RoutingBodyView | undefined>(undefined)
  const [loaded, setLoaded] = createSignal(false)
  const [editing, setEditing] = createSignal<string | null>(null)
  const [editValue, setEditValue] = createSignal("")
  const [error, setError] = createSignal<string | null>(null)

  const load = async () => {
    try {
      const raw = await amicodeGet(server.current, "/amicode/model-routing")
      setView(routingBodyView(raw))
    } catch {
      setView(routingBodyView({ ok: false })) // route absent → the unavailable note
    } finally {
      setLoaded(true)
    }
  }
  onMount(() => void load())

  const post = async (route: string, body: unknown) => {
    setError(null)
    try {
      const res = (await amicodePost(server.current, route, body)) as { ok?: boolean; error?: string | null }
      if (res && res.ok === false) setError(typeof res.error === "string" ? res.error : "error")
    } catch {
      setError("request failed")
    }
    await load()
  }

  const save = (role: string) => {
    const v = editValue().trim()
    setEditing(null)
    if (v === "") void post("/amicode/model-routing/reset", { role })
    else void post("/amicode/model-routing", { role, model: v })
  }

  const rowLabel = (row: RoutingRoleRow) => {
    const d = rowDisplay(row)
    if (d.label !== "") return d.label
    if (row.handSetModel) return row.handSetModel
    return language.t("settings.subagents.inherit")
  }

  return (
    <div class="settings-v2-tab">
      <header class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("settings.subagents.title")}</h2>
        <p style="margin-top:8px;font-size:13px;color:var(--v2-text-text-muted);">
          {language.t("settings.subagents.description")}
        </p>
      </header>
      <div class="settings-v2-tab-body">
        <Show when={loaded()} fallback={null}>
          <Show
            when={view()?.exists}
            fallback={
              <p style="margin:0;font-size:12px;color:var(--v2-text-text-faint);">
                {language.t("settings.subagents.unavailable")}
              </p>
            }
          >
            <Show when={view()} keyed>
              {(v) => (
                <div class="flex flex-col gap-1.5">
                  <label class="flex items-center gap-2 text-[12px] text-v2-text-text-muted">
                    <input
                      type="checkbox"
                      checked={v.optIn}
                      onChange={(e) => void post("/amicode/model-routing/opt-in", { opt_in: e.currentTarget.checked })}
                    />
                    <span>{language.t("settings.subagents.opt_in")}</span>
                    <span class="text-[11px] text-v2-text-text-faint">{language.t("settings.subagents.opt_in_hint")}</span>
                  </label>
                  <p class="m-0 text-[11px] text-v2-text-text-faint">
                    {v.providers && v.providers.length > 0
                      ? language.t("settings.subagents.providers", { providers: v.providers.join(", ") })
                      : language.t("settings.subagents.providers.unknown")}
                  </p>
                  <Show when={v.roles.length === 0}>
                    <p class="m-0 text-[11px] text-v2-text-text-faint">{language.t("settings.subagents.empty")}</p>
                  </Show>
                  <For each={v.roles}>
                    {(row) => {
                      const d = rowDisplay(row)
                      return (
                        <div data-role={row.role} class={ROW} data-part="role-row">
                          <span data-part="role" class="w-28 shrink-0 truncate text-v2-text-text-base">
                            {row.role}
                          </span>
                          <span data-part="provenance" class={CHIP}>
                            {language.t(d.provenance as Parameters<typeof language.t>[0])}
                          </span>
                          <Show when={!editing() || editing() !== row.role} fallback={
                            <span class="flex items-center gap-1">
                              <input
                                class={INPUT}
                                value={editValue()}
                                placeholder={language.t("settings.subagents.model_hint")}
                                onInput={(e) => setEditValue(e.currentTarget.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") save(row.role)
                                  if (e.key === "Escape") setEditing(null)
                                }}
                              />
                              <button type="button" class={BTN} data-part="save" onClick={() => save(row.role)}>
                                {language.t("settings.subagents.save")}
                              </button>
                              <button type="button" class={BTN} data-part="cancel" onClick={() => setEditing(null)}>
                                {language.t("settings.subagents.cancel")}
                              </button>
                            </span>
                          }>
                            <span data-part="model" class="min-w-0 flex-1 truncate text-v2-text-text-base">
                              {rowLabel(row)}
                            </span>
                            <Show when={row.suggestion}>
                              {(s) => (
                                <span data-part="suggestion" class="text-[11px] text-v2-text-text-faint">
                                  {language.t("settings.subagents.suggestion", { model: s().model })}
                                </span>
                              )}
                            </Show>
                            <Show when={d.showDrift}>
                              <span data-part="drift" class="text-[11px] text-v2-text-text-warning">
                                {language.t("settings.subagents.drift", { model: row.drift.tuned_model ?? "" })}
                              </span>
                              <button
                                type="button"
                                class={BTN}
                                data-part="reset-to-tuned"
                                onClick={() => void post("/amicode/model-routing/reset", { role: row.role })}
                              >
                                {language.t("settings.subagents.reset")}
                              </button>
                            </Show>
                            <button
                              type="button"
                              class={BTN}
                              data-part="edit"
                              onClick={() => {
                                setEditValue(row.effective.model ?? row.handSetModel ?? "")
                                setEditing(row.role)
                              }}
                            >
                              {language.t("settings.subagents.edit")}
                            </button>
                          </Show>
                        </div>
                      )
                    }}
                  </For>
                  <Show when={error()}>
                    <p class="m-0 text-[11px] text-v2-text-text-danger">{error()}</p>
                  </Show>
                </div>
              )}
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  )
}
