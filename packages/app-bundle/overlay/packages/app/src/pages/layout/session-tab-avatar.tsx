import type { LocalProject } from "@/context/layout"
import type { ServerConnection } from "@/context/server"
import { useSessionTabAvatarState } from "@/pages/layout/project-avatar-state"
import { SessionTabStatusDot, sessionTabStatus } from "@/pages/layout/session-tab-status"

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
      needsAttention={state.needsAttention()}
      hasError={state.hasError()}
    />
  )
}

export function SessionTabAvatarView(props: {
  project?: LocalProject
  directory: string
  revealProjectOnHover?: boolean
  unread: boolean
  loading: boolean
  needsAttention?: boolean
  hasError?: boolean
}) {
  // The Amico mark used to sit here on every tab — identical on all of them, so
  // it occupied the slot without saying anything. A status dot uses the same
  // space to report what the session is actually doing.
  return (
    <SessionTabStatusDot
      status={sessionTabStatus({
        loading: props.loading,
        needsAttention: props.needsAttention ?? false,
        hasError: props.hasError ?? false,
        unread: props.unread,
      })}
    />
  )
}
