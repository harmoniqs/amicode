import { useSearchParams } from "@solidjs/router"
import { createEffect, createSignal, untrack } from "solid-js"
import { usePromptInputV2Controller } from "@/components/prompt-input-v2"
import { useComments } from "@/context/comments"
import { useLocal } from "@/context/local"
import { usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { useServerSync } from "@/context/server-sync"
import { createPromptInputController, createPromptProjectControls } from "@/pages/session/composer"
import { createPromptModelSelection } from "@/pages/session/composer/prompt-model-selection"
import { useSessionKey } from "@/pages/session/session-layout"
import { useComposerCommands } from "@/pages/session/use-composer-commands"

// amicode#363: global flag the navigate bridge sets before creating a draft.
// The draft controller reads + clears it on mount to auto-submit.
const [pendingAutoSend, setPendingAutoSend] = createSignal(false)
export { setPendingAutoSend }

export function createNewSessionDraftController(workspace: { worktree: () => string; resetWorktree: () => void }) {
  const prompt = usePrompt()
  const serverSync = useServerSync()
  const sdk = useSDK()
  const comments = useComments()
  const local = useLocal()
  const route = useSessionKey()
  const [searchParams, setSearchParams] = useSearchParams<{ draftId?: string; prompt?: string; autoSend?: string }>()
  const model = createPromptModelSelection({ agent: () => local.agent.current() })

  useComposerCommands({ model })

  const controls = createPromptInputController({
    sessionKey: route.sessionKey,
    sessionID: () => route.params.id,
    queryOptions: serverSync().queryOptions,
    model,
  })
  const projectControls = createPromptProjectControls()
  const input = usePromptInputV2Controller({
    get controls() {
      return controls()
    },
    get newSessionWorktree() {
      return workspace.worktree()
    },
    onNewSessionWorktreeReset: workspace.resetWorktree,
    onSubmit: comments.clear,
  })

  createEffect(() => {
    if (!prompt.ready()) return
    untrack(() => {
      const text = searchParams.prompt
      if (text) {
        prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
        setSearchParams({ ...searchParams, prompt: undefined, autoSend: undefined })
      }
    })
  })

  // amicode#363: auto-submit when the navigate bridge flagged it.
  // Separated from the text-fill effect so it works even when the draft
  // controller is already mounted (no sessions open → already on /new-session).
  createEffect(() => {
    if (!pendingAutoSend()) return
    if (!prompt.ready()) return
    setPendingAutoSend(false)
    // Retry until model selection is ready and the prompt has content.
    // After onboarding the server just restarted — the provider query can take
    // 10-20s to verify credentials. Only give up once providers have loaded
    // (provider_ready) and model.current() is still undefined (genuine failure),
    // or after 60s hard cap.
    const dir = sdk().directory
    const childStore = dir ? serverSync().child(dir)[0] : undefined
    const trySubmit = (attempts = 0) => {
      if (attempts > 120) return // hard cap ~60s
      const parts = prompt.current()
      const hasContent = Array.isArray(parts) && parts.some((p: any) => p.content && p.content.length > 0)
      if (model.ready() && model.current() && hasContent) {
        input.view.submit.onSubmit()
      } else {
        // Check if providers have finished loading — if so and still no model,
        // give up early (no connected providers = real failure, not timing).
        const providerReady = childStore?.provider_ready ?? false
        if (providerReady && model.ready() && !model.current() && attempts > 10) {
          // Providers loaded but no model resolved — genuine failure
          return
        }
        setTimeout(() => trySubmit(attempts + 1), 500)
      }
    }
    setTimeout(() => trySubmit(), 500)
  })

  return {
    input,
    prompt: {
      ready: prompt.ready,
      readyPromise: () => prompt.ready.promise,
    },
    project: {
      controls: projectControls,
    },
  }
}

export type NewSessionDraftController = ReturnType<typeof createNewSessionDraftController>
