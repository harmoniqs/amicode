import { createEffect, Suspense, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { TabsInfoPopup } from "@/components/help-button"
import { Titlebar, type TitlebarUpdate } from "@/components/titlebar"
import { SolverSwitchBanner } from "@/components/solver-switch-banner"
import { HarnessSwitchBanner } from "@/components/harness-switch-banner"
import { VaultPanel } from "@/components/vault-panel"
import { usePlatform } from "@/context/platform"
import { setV2Toast, ToastRegion } from "@/utils/toast"
import { useNotificationToasts } from "./layout/notification-toasts"
import { useWorktreeAutoRename } from "./layout/worktree-auto-rename"

export default function NewLayout(props: ParentProps) {
  const platform = usePlatform()
  const [state, setState] = createStore({ debugTools: true })

  useNotificationToasts()
  useWorktreeAutoRename()
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
          under the webview. Speaks only for switches the app requested — unlike
          the removed ConnectionBanner, silence is still the default. */}
      <SolverSwitchBanner />
      {/* amicode#1549: a harness switch restarts the server under the webview
          too — the composer's harness control narrates through the gap. Same
          discipline: speaks only for switches the app requested. */}
      <HarnessSwitchBanner />
      {/* DebugBar removed with the fork's debug-bar deletion (kept during the
          upstream merge) — the debugTools toggle state stays for the titlebar's
          channel indicator. */}
      <TabsInfoPopup />
      <ToastRegion v2 />
    </div>
  )
}
