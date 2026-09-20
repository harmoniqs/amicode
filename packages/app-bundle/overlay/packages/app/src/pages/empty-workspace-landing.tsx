import { MarkDetailed } from "@opencode-ai/ui/logo"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { Portal } from "solid-js/web"
import { Show } from "solid-js"
import { useTitlebarControlMount } from "@/components/titlebar"
import { SessionChatsDropdown } from "@/components/session/session-header"
import { StatusPopoverV2 } from "@/components/status-popover"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { requestAddWorkspaceProject } from "@/utils/amicode-workspace-projects"
import { NEW_SESSION_CONTENT_WIDTH } from "@/pages/session/new-session-layout"

/** Lightweight landing shown when no workspace folder is open.
 *
 *  Renders the Amicode mark + an "Open a folder" prompt in the same visual
 *  frame as the normal new-session view, and populates the titlebar controls
 *  (sessions, status) so the chrome never appears empty. Once a workspace
 *  folder arrives (the extension pushes it via postMessage), the reactive
 *  landing effect in app.tsx creates a proper draft and this component
 *  unmounts automatically. */
export default function EmptyWorkspaceLanding() {
  const settings = useSettings()
  const language = useLanguage()
  const sessionsMount = useTitlebarControlMount("sessions")
  const statusMount = useTitlebarControlMount("status")

  return (
    <div class="relative size-full overflow-hidden flex flex-col">
      {/* Titlebar controls — sessions + status */}
      <Show when={sessionsMount()} keyed>
        {(mount) => (
          <Portal mount={mount}>
            <span class="flex shrink-0" data-tour-target="sessions">
              <SessionChatsDropdown />
            </span>
          </Portal>
        )}
      </Show>
      <Show when={statusMount()} keyed>
        {(mount) => (
          <Portal mount={mount}>
            <span class="flex shrink-0" data-tour-target="status">
              <TooltipV2 placement="bottom" value={language.t("status.popover.trigger")} class="shrink-0">
                <StatusPopoverV2 />
              </TooltipV2>
            </span>
          </Portal>
        )}
      </Show>

      {/* Content — matches the new-session-view layout */}
      <div class="flex-1 min-h-0 flex flex-col gap-2 p-2">
        <div class="@container relative flex flex-col min-h-0 h-full flex-1">
          <div
            data-component="session-new-design"
            class="relative flex-1 min-h-0 overflow-hidden rounded-md bg-v2-background-bg-deep"
          >
            <div class="absolute inset-0 flex items-center justify-center px-6 pb-24">
              <div class={NEW_SESSION_CONTENT_WIDTH}>
                <div class="flex justify-center">
                  <MarkDetailed class="w-24 h-auto" style={{ color: "var(--v2-icon-icon-accent)" }} />
                </div>
                <div class="mt-8 flex flex-col items-center gap-4">
                  <button
                    type="button"
                    class="flex h-9 items-center gap-2 rounded-md border border-v2-border-border-base bg-v2-background-bg-base px-4 text-[13px] text-v2-text-text-muted transition-colors hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-v2-border-border-focus"
                    onClick={() => requestAddWorkspaceProject()}
                  >
                    <IconV2 name="plus" size="small" />
                    <span>Open a folder to get started</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
