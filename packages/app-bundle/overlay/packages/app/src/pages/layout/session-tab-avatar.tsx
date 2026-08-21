import type { LocalProject } from "@/context/layout"
import type { ServerConnection } from "@/context/server"
import { useSessionTabAvatarState } from "@/pages/layout/project-avatar-state"
import { Mark } from "@opencode-ai/ui/logo"
import { AmicoMark } from "@opencode-ai/ui/amico-spinner"
import { Show } from "solid-js"

export function SessionTabAvatar(props: {
  project?: LocalProject
  directory: string
  sessionId: string
  server: ServerConnection.Key
  revealProjectOnHover?: boolean
}) {
  const state = useSessionTabAvatarState(
    () => props.server,
    () => props.directory,
    () => props.sessionId,
  )
  return (
    <SessionTabAvatarView
      project={props.project}
      directory={props.directory}
      revealProjectOnHover={props.revealProjectOnHover}
      unread={state.unread()}
      loading={state.loading()}
    />
  )
}

export function SessionTabAvatarView(props: {
  project?: LocalProject
  directory: string
  revealProjectOnHover?: boolean
  unread: boolean
  loading: boolean
}) {
  return (
    <Show
      when={props.loading}
      fallback={
        <span class="relative inline-flex size-4 shrink-0 items-center justify-center">
          <Mark class="size-4" />
          <Show when={props.unread}>
            <span
              aria-hidden="true"
              class="absolute -top-0.5 -right-0.5 size-1.5 rounded-full"
              style={{ background: "var(--v2-icon-icon-accent)" }}
            />
          </Show>
        </span>
      }
    >
      <span class="relative block size-4 shrink-0">
        <span class="absolute inset-0 flex items-center justify-center tab-mark-running">
          <AmicoMark running />
        </span>
      </span>
    </Show>
  )
}
