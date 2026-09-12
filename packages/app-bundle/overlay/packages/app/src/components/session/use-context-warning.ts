import { createEffect, createMemo, on } from "solid-js"
import { createStore } from "solid-js/store"
import { getSessionContext } from "@/components/session/session-context-metrics"
import { useSync } from "@/context/sync"
import { useProviders } from "@/hooks/use-providers"
import { useSDK } from "@/context/sdk"
import { useSessionLayout } from "@/pages/session/session-layout"

export type WarningLevel = "none" | "warn" | "critical"

export function useContextWarning() {
  const sync = useSync()
  const sdk = useSDK()
  const providers = useProviders(() => sdk().directory)
  const { params } = useSessionLayout()

  const messages = createMemo(() => (params.id ? (sync().data.message[params.id] ?? []) : []))
  const context = createMemo(() => getSessionContext(messages(), [...providers.all().values()]))
  const usage = createMemo(() => context()?.usage ?? 0)

  const [store, setStore] = createStore<{ dismissedWarn: boolean; lastNotifiedWarn: number; lastNotifiedCritical: number }>({
    dismissedWarn: false,
    lastNotifiedWarn: 0,
    lastNotifiedCritical: 0,
  })

  const level = createMemo<WarningLevel>(() => {
    const u = usage()
    if (u >= 90) return "critical"
    if (u >= 75) return "warn"
    return "none"
  })

  createEffect(
    on(usage, (u) => {
      if (u < 75 && store.dismissedWarn) setStore("dismissedWarn", false)
    }),
  )

  const visibleLevel = createMemo<WarningLevel>(() => {
    const l = level()
    if (l === "warn" && store.dismissedWarn) return "none"
    return l
  })

  const dismissWarn = () => setStore("dismissedWarn", true)

  return { usage, context, level, visibleLevel, dismissWarn, store, setStore }
}
