import { createMemo, type Accessor } from "solid-js"
import { useGlobal } from "@/context/global"
import { useNotification } from "@/context/notification"
import { usePermission } from "@/context/permission"
import { sessionPermissionRequest, sessionQuestionRequest } from "@/pages/session/composer/session-request-tree"
import { ServerConnection } from "@/context/server"
import { deriveSessionListChip, type SessionListChip } from "@/pages/layout/session-list-chip"

export function useSessionTabAvatarState(
  server: Accessor<ServerConnection.Key>,
  directory: Accessor<string>,
  sessionId: Accessor<string>,
) {
  const global = useGlobal()
  const notification = useNotification()
  const permission = usePermission()
  const connection = createMemo(() => global.servers.list().find((item) => ServerConnection.key(item) === server()))
  const sync = createMemo(() => {
    const conn = connection()
    if (conn) return global.ensureServerCtx(conn).sync
  })
  const hasPermissions = createMemo(() => {
    const serverSync = sync()
    if (!serverSync) return false
    const permissionState = permission.ensureServerState(server())
    const [store] = serverSync.child(directory(), { bootstrap: false })
    return !!sessionPermissionRequest(store.session, serverSync.session.data.permission, sessionId(), (item) => {
      return !permissionState.autoResponds(item, directory())
    })
  })
  const hasQuestions = createMemo(() => {
    const serverSync = sync()
    if (!serverSync) return false
    const [store] = serverSync.child(directory(), { bootstrap: false })
    return !!sessionQuestionRequest(store.session, serverSync.session.data.question, sessionId())
  })
  const needsAttention = createMemo(() => hasPermissions() || hasQuestions())
  const notificationState = createMemo(() => {
    if (!connection()) return
    return notification.ensureServerState(server())
  })
  const unread = createMemo(() => needsAttention() || (notificationState()?.session.unseenCount(sessionId()) ?? 0) > 0)
  // Per-session error: notification.tsx indexes these as
  // index.session.unseenHasError[notification.session] when a notification of
  // type "error" arrives, so it IS session-scoped, not just project-scoped.
  const hasError = createMemo(() => notificationState()?.session.unseenHasError(sessionId()) ?? false)
  const loading = createMemo(() => {
    const serverSync = sync()
    if (!serverSync) return false
    if (needsAttention()) return false
    return serverSync.session.data.session_working(sessionId())
  })
  // needsAttention is surfaced separately so the tab dot can distinguish
  // "blocked, waiting on you" from "finished, unseen output" — folded together
  // they were both just `unread`.
  return { unread, loading, needsAttention, hasError }
}

// amicode#1787 (S1): the session list row's status chip. READ-ONLY derivation
// over the per-server SHARED ServerSession store — the same `data` leaves the
// S2 question inbox derives from (question), the #1617/#1637 floors already
// guard (session_working / session_status), and the existing re-seed seams
// (connected edge, sync-gap frame, visibility-gated self-heal) keep current.
// No new state, no polling; a session with no evidence derives undefined and
// the row renders no chip (#1768 honest absence).
export function useSessionListChipState(
  server: Accessor<ServerConnection.Key>,
  sessionId: Accessor<string>,
  lastActivityAt: Accessor<number | undefined>,
) {
  const global = useGlobal()
  const connection = createMemo(() => global.servers.list().find((item) => ServerConnection.key(item) === server()))
  const sync = createMemo(() => {
    const conn = connection()
    if (conn) return global.ensureServerCtx(conn).sync
  })
  return createMemo<SessionListChip | undefined>(() => {
    const serverSync = sync()
    if (!serverSync) return undefined
    return deriveSessionListChip({
      source: serverSync.session.data,
      sessionID: sessionId(),
      lastActivityAt: lastActivityAt(),
      now: Date.now(),
    })
  })
}
