import { createEffect, Suspense, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { TabsInfoPopup } from "@/components/help-button"
import { Titlebar, type TitlebarUpdate } from "@/components/titlebar"
import { SolverSwitchBanner } from "@/components/solver-switch-banner"
import { ConnectionBanner } from "@/components/connection-banner"
import { VaultPanel } from "@/components/vault-panel"
import { usePlatform } from "@/context/platform"
import { setV2Toast, ToastRegion } from "@/utils/toast"

export default function NewLayout(props: ParentProps) {
  const platform = usePlatform()
  const [state, setState] = createStore({ debugTools: true })

  createEffect(() => setV2Toast(true))

  const update: TitlebarUpdate = {
    version: () => {
      const state = platform.updater?.state()
      if (state?.status !== "ready") return
      return state.version
    },
    installing: () => platform.updater?.state().status === "installing",
    install: () => void platform.updater?.install(),
  }

  return (
    <div
      class="relative bg-v2-background-bg-deep flex-1 min-h-0 min-w-0 flex flex-col select-none [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text"
      style={{
        "padding-top": "env(safe-area-inset-top, 0px)",
        "padding-bottom": "env(safe-area-inset-bottom, 0px)",
      }}
    >
      <Titlebar
        update={update}
        debugTools={
          import.meta.env.DEV
            ? { visible: state.debugTools, toggle: () => setState("debugTools", (value) => !value) }
            : undefined
        }
      />
      <main class="flex-1 min-h-0 min-w-0 overflow-x-hidden flex flex-col items-start contain-strict">
        <Suspense>{props.children}</Suspense>
      </main>
      {/* amicode#105: the vault's global host lives in the layout that ACTUALLY
          renders the v2 tree — the workbench/wave merges grafted their chrome
          into layout.tsx's LegacyLayout branch, which newLayoutDesigns never
          reaches (VaultPanel was invisible here). */}
      <VaultPanel />
      {/* opencode#78 follow-up: a solver switch restarts the opencode server
          under the webview. Speaks only for switches the app requested — the
          OLD ConnectionBanner spoke for every drop; its successor speaks only
          after the grace window, with an exit (amicode#653). */}
      <SolverSwitchBanner />
      {/* amicode#653: hub-down truth with a Restart Hub exit. Silent for
          blips and the boot transient; surfaces only a persistent disconnect
          (the 2026-08-30 incidents: panels read a dead hub as an eternal
          loading screen while the journal held the answer). */}
      <ConnectionBanner />
      {/* DebugBar removed with the fork's debug-bar deletion (kept during the
          upstream merge) — the debugTools toggle state stays for the titlebar's
          channel indicator. */}
      <TabsInfoPopup />
      <ToastRegion v2 />
    </div>
  )
}
