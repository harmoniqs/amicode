import { createPromptProjectController } from "@/components/prompt-project-selector"
import { useTitlebarControlMount } from "@/components/titlebar"
import { useSettings } from "@/context/settings"
import { createEffect, createResource, onMount } from "solid-js"
import { useLocation } from "@solidjs/router"
import { createNewSessionDraftController } from "./new-session/new-session-draft-controller"
import { NewSessionStatus, NewSessionView } from "./new-session/new-session-view"
import { createNewSessionWorkspaceController } from "./new-session/new-session-workspace-controller"
import { useNewSessionCommands } from "./new-session/use-new-session-commands"
import { postRouteInfo } from "@/utils/amicode-route-info"
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

  // amicode: register the Amico ops commands here too — the draft page has no
  // palette, so restart/update-memory are reachable via their direct keybinds.
  useAmicodeCommands()

  createEffect(() => {
    if (!draft.prompt.ready()) return
    draft.input.restoreFocus()
  })

  onMount(() => {
    // amicode(deck): label the framing pane tab; the draftId rides the search
    // so the shell can rebuild this pane with its draft text intact.
    postRouteInfo(`${location.pathname}${location.search}`, "New session")
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
      <div class="flex-1 min-h-0 flex flex-col gap-2 p-2">
        <NewSessionView
          input={draft.input}
          project={project}
          workspace={workspace}
        />
      </div>
    </div>
  )
}
