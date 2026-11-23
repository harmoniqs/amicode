// #2158: the new chat's "Starting session" notice. On a busy engine the create
// and the navigation to the new session can take many seconds; without this
// the composer still showed the text and nothing moved, which read as dead
// and invited a second Enter. Shown from the moment Enter is pressed until the
// session page replaces this view, driven by the new-chat gate for this draft.
import { Show } from "solid-js"
import { useSearchParams } from "@solidjs/router"
import { Spinner } from "@opencode-ai/ui/spinner"
import { isNewSessionStarting, newSessionKey } from "@/components/prompt-input/new-session-gate"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"

export function NewSessionStartingNotice() {
  const language = useLanguage()
  const sdk = useSDK()
  const [search] = useSearchParams<{ draftId?: string }>()
  const starting = () => isNewSessionStarting(newSessionKey(sdk().scope, sdk().directory, search.draftId))

  // `contents`: the live region is always mounted (so the change is announced)
  // but takes no space in the composer column until the notice shows.
  return (
    <div role="status" aria-live="polite" class="contents">
      <Show when={starting()}>
        <span
          data-component="amicode-new-session-starting"
          class="flex items-center justify-center gap-2 text-12-regular text-v2-text-text-muted"
        >
          <Spinner class="size-3.5 text-v2-icon-icon-muted" />
          {language.t("prompt.newSession.starting")}
        </span>
      </Show>
    </div>
  )
}
