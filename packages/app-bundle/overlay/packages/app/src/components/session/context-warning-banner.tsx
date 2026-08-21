import { Show, createEffect, on } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { useContextWarning } from "./use-context-warning"

export function ContextWarningBanner() {
  const language = useLanguage()
  const command = useCommand()
  const warning = useContextWarning()

  // toasts once per level per session
  createEffect(
    on(
      () => warning.level(),
      (level) => {
        if (level === "warn" && warning.store.lastNotifiedWarn === 0) {
          warning.setStore("lastNotifiedWarn", Date.now())
          showToast({ variant: "default", title: language.t("context.warning.toast.warn.title"), description: language.t("context.warning.toast.warn.description") })
        }
        if (level === "critical" && warning.store.lastNotifiedCritical === 0) {
          warning.setStore("lastNotifiedCritical", Date.now())
          showToast({ variant: "error", title: language.t("context.warning.toast.critical.title"), description: language.t("context.warning.toast.critical.description") })
        }
      },
    ),
  )

  const compact = () => command.trigger("session.compact", "palette")

  return (
    <>
      <Show when={warning.visibleLevel() === "warn"}>
        <div class="flex h-7 items-center justify-between gap-3 border-b border-[var(--v2-border-border-warning)] bg-[var(--v2-background-bg-warning-subtle)] px-3 text-12-regular" role="status" aria-live="polite" data-component="context-warning-banner" data-level="warn">
          <span class="truncate">{language.t("context.warning.banner.warn", { percent: warning.usage() })}</span>
          <span class="flex shrink-0 items-center gap-1">
            <ButtonV2 size="small" variant="neutral" onClick={compact}>{language.t("command.session.compact")}</ButtonV2>
            <ButtonV2 size="small" variant="ghost" onClick={warning.dismissWarn} aria-label={language.t("common.dismiss")}>×</ButtonV2>
          </span>
        </div>
      </Show>
      <Show when={warning.visibleLevel() === "critical"}>
        <div class="flex h-7 items-center justify-between gap-3 border-b border-[var(--v2-border-border-danger)] bg-[var(--v2-background-bg-danger-subtle)] px-3 text-12-regular" role="alert" data-component="context-warning-banner" data-level="critical">
          <span class="truncate">{language.t("context.warning.banner.critical", { percent: warning.usage() })}</span>
          <ButtonV2 size="small" variant="danger" onClick={compact}>{language.t("command.session.compact")}</ButtonV2>
        </div>
      </Show>
    </>
  )
}
