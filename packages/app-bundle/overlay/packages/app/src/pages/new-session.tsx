import { createPromptProjectController } from "@/components/prompt-project-selector"
import { SessionPreviewTab } from "@/components/session/session-preview-tab"
import { useTitlebarControlMount } from "@/components/titlebar"
import { useSettings } from "@/context/settings"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { createEffect, createResource, createSignal, onCleanup, onMount, Show } from "solid-js"
import { useLocation } from "@solidjs/router"
import { createNewSessionDraftController } from "./new-session/new-session-draft-controller"
import { NewSessionStatus, NewSessionView } from "./new-session/new-session-view"
import { createNewSessionWorkspaceController } from "./new-session/new-session-workspace-controller"
import { useNewSessionCommands } from "./new-session/use-new-session-commands"
import { postRouteInfo } from "@/utils/amicode-route-info"
import { sessionContextMessage } from "@/utils/amicode-session-relay"
import { useAmicodeCommands } from "@/pages/session/use-amicode-commands"

/** The draft-only V2 session page. Submitting promotes the draft into a real session. */
export default function NewSessionPage() {
  const settings = useSettings()
  const sessionsMount = useTitlebarControlMount("sessions")
  const statusMount = useTitlebarControlMount("status")
  const workspace = createNewSessionWorkspaceController()
  const draft = createNewSessionDraftController({
    worktree: workspace.selection.value,
    resetWorktree: workspace.selection.reset,
  })
  const project = createPromptProjectController({
    controls: draft.project.controls,
    onDone: draft.input.restoreFocus,
  })
  useNewSessionCommands({
    restoreFocus: draft.input.restoreFocus,
    project: {
      empty: project.empty,
      open: () => project.setOpen(true),
    },
  })
  const location = useLocation()
  const [previewFile, setPreviewFile] = createSignal<string | null>(null)

  // amicode: register the Amico ops commands here too — the draft page has no
  // palette, so restart/update-memory are reachable via their direct keybinds.
  useAmicodeCommands()

  createEffect(() => {
    if (!draft.prompt.ready()) return
    draft.input.restoreFocus()
  })

  onMount(() => {
    if (window.parent !== window) window.parent.postMessage(sessionContextMessage(), "*")
    // amicode(deck): label the framing pane tab; the draftId rides the search
    // so the shell can rebuild this pane with its draft text intact.
    postRouteInfo(`${location.pathname}${location.search}`, "New session")
    const onPreviewFile = (event: MessageEvent) => {
      const data = event.data as { source?: string; kind?: string; path?: string } | undefined
      if (data?.source === "amicode" && data.kind === "preview-file" && data.path) setPreviewFile(data.path)
    }
    window.addEventListener("message", onPreviewFile)
    onCleanup(() => window.removeEventListener("message", onPreviewFile))
    onCleanup(() => {
      if (window.parent !== window) window.parent.postMessage(sessionContextMessage(), "*")
    })
  })
  const ready = Promise.resolve()
  const [suspendUntilPromptReady] = createResource(
    () => draft.prompt.readyPromise() ?? ready,
    (promise) => promise.then(() => true),
  )

  return (
    <div class="relative size-full overflow-hidden flex flex-col">
      {suspendUntilPromptReady()}
      <NewSessionStatus sessionsMount={sessionsMount} statusMount={statusMount} visible={settings.visibility.status} />
      <div class="flex-1 min-h-0 flex flex-col gap-2 p-2 md:flex-row">
        <NewSessionView
          input={draft.input}
          project={project}
          workspace={workspace}
        />
        <Show when={previewFile()}>
          <aside
            id="review-panel"
            data-draft-preview
            class="relative flex min-h-60 w-full shrink-0 overflow-hidden rounded-lg border border-v2-border-border-base bg-v2-background-bg-base md:w-96"
          >
            <div class="flex min-h-0 flex-1 flex-col">
              <div class="flex h-8 shrink-0 items-center justify-end border-b border-v2-border-border-muted bg-v2-background-bg-layer-01 px-1">
                <button
                  type="button"
                  class="flex size-8 items-center justify-center rounded-md text-v2-icon-icon-muted hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-icon-icon-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-v2-border-border-focus"
                  aria-label="Close Preview"
                  onClick={() => setPreviewFile(null)}
                >
                  <IconV2 name="xmark-small" size="small" />
                </button>
              </div>
              <div class="min-h-0 flex-1">
                <SessionPreviewTab previewFile={previewFile} />
              </div>
            </div>
          </aside>
        </Show>
      </div>
    </div>
  )
}
