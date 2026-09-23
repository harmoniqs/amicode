import { MarkDetailed } from "@opencode-ai/ui/logo"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
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
  // #1458: the titlebar portals (sessions dropdown + status popover) are GONE.
  // They rendered SessionChatsDropdown/StatusPopoverV2 — components that read
  // the per-directory SYNC context — at the "/" route, which never sits inside
  // a SyncProvider. At real-boot timing (workspace projects arrive over the
  // wire AFTER the app mounts) the no-directory window renders this landing
  // for a moment on EVERY boot, and the popover's useSync() throw killed the
  // whole route tree — including the reactive landing effect, so the draft was
  // never created and the app stayed frozen at "/" (caught live by the e2e
  // rig; unit tests mock the contexts and never saw it). The chrome dots are
  // transient niceties on a momentary landing; the content below is the UX.

  return (
    <div class="relative size-full overflow-hidden flex flex-col">
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
