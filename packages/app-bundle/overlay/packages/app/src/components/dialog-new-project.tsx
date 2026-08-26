// amicode#203: New-project creation dialog. Name → slug preview; the server
// owns the location default (~/AmicodeProjects) and the mkdir + best-effort
// git init (POST /amicode/project). Inline, recoverable errors for collision /
// unwritable; a non-blocking git notice is surfaced by the caller (onCreated).
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { TextField } from "@opencode-ai/ui/text-field"
import { useMutation } from "@tanstack/solid-query"
import { createMemo, createSignal, Show } from "solid-js"
import { ServerConnection } from "@/context/server"
import { amicodePost } from "@/utils/amicode-fetch"
import { projectNameToSlug } from "@/pages/home-projects"

type CreateResult =
  | { ok: true; path: string; slug: string; gitInitialized: boolean }
  | { ok: false; error: string; message: string }

export function DialogNewProject(props: {
  server: ServerConnection.Any
  onCreated: (result: { path: string; gitInitialized: boolean }) => void
  onOpenExisting: () => void
}) {
  const dialog = useDialog()
  const [name, setName] = createSignal("")
  const [error, setError] = createSignal<string | undefined>()
  const slug = createMemo(() => projectNameToSlug(name()))

  const createMutation = useMutation(() => ({
    mutationFn: async (): Promise<void> => {
      setError(undefined)
      const result = (await amicodePost(props.server, "/amicode/project", { name: name() }).catch(
        () => undefined,
      )) as CreateResult | undefined
      if (!result) {
        setError("Couldn't reach the server — try again.")
        return
      }
      if (!result.ok) {
        setError(result.message)
        return
      }
      dialog.close()
      props.onCreated({ path: result.path, gitInitialized: result.gitInitialized })
    },
  }))

  function submit(e: SubmitEvent) {
    e.preventDefault()
    if (createMutation.isPending || !slug()) return
    createMutation.mutate()
  }

  return (
    <Dialog title="New project" class="w-full max-w-[460px] mx-auto">
      <form onSubmit={submit} class="flex flex-col gap-5 p-6 pt-0">
        <div class="flex flex-col gap-2">
          <TextField
            autofocus
            type="text"
            label="Project name"
            placeholder="Rydberg MIS"
            value={name()}
            onChange={setName}
          />
          <Show
            when={slug()}
            fallback={<span class="text-12-regular text-text-weak">Creates a new folder in ~/AmicodeProjects.</span>}
          >
            <span class="text-12-regular text-text-weak">
              Creates <span class="font-mono text-text-base">{slug()}</span> in ~/AmicodeProjects, with git for change
              tracking.
            </span>
          </Show>
        </div>

        <Show when={error()}>
          <div class="flex items-center gap-2" role="alert" aria-live="polite" data-slot="new-project-error">
            <div class="size-1.5 rounded-full shrink-0 bg-icon-critical-base" />
            <span class="text-12-regular text-text-weak">{error()}</span>
          </div>
        </Show>

        <div class="flex items-center justify-between gap-3">
          <button
            type="button"
            class="text-12-regular text-text-weak underline underline-offset-2 hover:text-text-base"
            onClick={() => {
              dialog.close()
              props.onOpenExisting()
            }}
          >
            Open existing folder instead…
          </button>
          <Button type="submit" disabled={!slug() || createMutation.isPending}>
            {createMutation.isPending ? "Creating…" : "Create project"}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
