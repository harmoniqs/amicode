import { createEffect, onCleanup, onMount } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { getFilename } from "@opencode-ai/core/util/path"
import { useLanguage } from "@/context/language"
import { usePermission } from "@/context/permission"
import { usePlatform } from "@/context/platform"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { useSettings } from "@/context/settings"
import { decode64 } from "@/utils/base64"
import { playSoundById } from "@/utils/sound"
import { dismissToast, showToast } from "@/utils/toast"
import type { ServerScope } from "@/utils/server-scope"
import { Worktree } from "@/utils/worktree"

type WorktreeLifecycleEvent = {
  name: string
  details?: {
    type?: string
    properties?: unknown
  }
}

export function handleWorktreeLifecycleEvent(
  event: WorktreeLifecycleEvent,
  options: {
    scope: ServerScope
    setBusy?: (directory: string, value: boolean) => void
    fallbackMessage: string
  },
) {
  if (event.details?.type === "worktree.ready") {
    options.setBusy?.(event.name, false)
    Worktree.ready(options.scope, event.name)
    return true
  }
  if (event.details?.type !== "worktree.failed") return false
  options.setBusy?.(event.name, false)
  const properties = event.details.properties
  const message =
    properties && typeof properties === "object" && "message" in properties && typeof properties.message === "string"
      ? properties.message
      : options.fallbackMessage
  Worktree.failed(options.scope, event.name, message)
  return true
}

/**
 * #1948: "you're already there" — the viewed session (the route's params.id)
 * is the asking session itself or one of its ancestors (a subagent's question
 * surfaces in its parent's view). Identity only: session ids are globally
 * unique, so the event's directory and the route's directory may differ (the
 * hub) without changing the answer. `parentOf` resolves a session's parentID
 * from whatever the caller knows; the walk is cycle-safe.
 */
export function isViewingSessionOrAncestor(input: {
  viewedSessionID: string | undefined
  sessionID: string
  parentOf: (sessionID: string) => string | undefined
}): boolean {
  const viewed = input.viewedSessionID
  if (!viewed) return false
  const seen = new Set<string>()
  for (let id: string | undefined = input.sessionID; id && !seen.has(id); id = input.parentOf(id)) {
    if (id === viewed) return true
    seen.add(id)
  }
  return false
}

export function useNotificationToasts(options?: { setBusy?: (directory: string, value: boolean) => void }) {
  const params = useParams()
  const navigate = useNavigate()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const platform = usePlatform()
  const settings = useSettings()
  const permission = usePermission()
  const language = useLanguage()

  const currentDir = () => {
    const dir = decode64(params.dir)
    if (!dir) return ""
    return serverSync().peek(dir, { bootstrap: false })[0].path.directory || dir
  }

  onMount(() => {
    // #1948: keyed by session id alone (globally unique) — never by
    // directory, which differs between the event and the route on the hub.
    const toastBySession = new Map<string, number>()
    const alertedAtBySession = new Map<string, number>()
    const cooldownMs = 5000
    // #1948: sessionID → parentID, learned from the stream's session.created/
    // updated. The stores below are peeked with bootstrap: false, so a
    // subagent child is often absent; question.asked carries no parent info.
    const parentBySession = new Map<string, string>()
    const parentOf = (sessionID: string, directory?: string) => {
      const learned = parentBySession.get(sessionID)
      if (learned) return learned
      for (const dir of [directory, currentDir()]) {
        if (!dir) continue
        const [store] = serverSync().child(dir, { bootstrap: false })
        const found = store.session.find((session) => session.id === sessionID)?.parentID
        if (found) return found
      }
      return undefined
    }

    const dismissSessionAlert = (sessionKey: string) => {
      const toastId = toastBySession.get(sessionKey)
      if (toastId === undefined) return
      dismissToast(toastId)
      toastBySession.delete(sessionKey)
      alertedAtBySession.delete(sessionKey)
    }

    const unsub = serverSDK().event.listen((event) => {
      if (
        handleWorktreeLifecycleEvent(event, {
          scope: serverSDK().scope,
          setBusy: options?.setBusy,
          fallbackMessage: language.t("common.requestFailed"),
        })
      )
        return

      if (event.details?.type === "session.created" || event.details?.type === "session.updated") {
        const info = (event.details.properties as { info?: { id?: unknown; parentID?: unknown } } | undefined)?.info
        if (typeof info?.id === "string" && typeof info.parentID === "string" && info.parentID !== "")
          parentBySession.set(info.id, info.parentID)
        return
      }

      if (
        event.details?.type === "question.replied" ||
        event.details?.type === "question.rejected" ||
        event.details?.type === "permission.replied"
      ) {
        const props = event.details.properties as { sessionID: string }
        dismissSessionAlert(props.sessionID)
        return
      }

      if (event.details?.type !== "permission.asked" && event.details?.type !== "question.asked") return
      const title =
        event.details.type === "permission.asked"
          ? language.t("notification.permission.title")
          : language.t("notification.question.title")
      const icon = event.details.type === "permission.asked" ? ("checklist" as const) : ("bubble-5" as const)
      const directory = event.name
      const props = event.details.properties
      if (event.details.type === "permission.asked" && permission.autoResponds(event.details.properties, directory))
        return

      const [store] = serverSync().child(directory, { bootstrap: false })
      const session = store.session.find((session) => session.id === props.sessionID)
      const sessionKey = props.sessionID

      const sessionTitle = session?.title ?? language.t("command.session.new")
      const projectName = getFilename(directory)
      const description =
        event.details.type === "permission.asked"
          ? language.t("notification.permission.description", { sessionTitle, projectName })
          : language.t("notification.question.description", { sessionTitle, projectName })
      const href = `/${base64Encode(directory)}/session/${props.sessionID}`

      const now = Date.now()
      const lastAlerted = alertedAtBySession.get(sessionKey) ?? 0
      if (now - lastAlerted < cooldownMs) return
      alertedAtBySession.set(sessionKey, now)

      if (event.details.type === "permission.asked") {
        if (settings.sounds.permissionsEnabled()) {
          void playSoundById(settings.sounds.permissions())
        }
        if (settings.notifications.permissions()) {
          void platform.notify(title, description, () => navigate(href))
        }
      }

      if (event.details.type === "question.asked") {
        if (settings.notifications.agent()) {
          void platform.notify(title, description, () => navigate(href))
        }
      }

      // #1948: no toast for the session you're viewing or a descendant of it —
      // identity only, no directory comparison. platform.notify above keeps
      // its own focus guard.
      if (
        isViewingSessionOrAncestor({
          viewedSessionID: params.id,
          sessionID: props.sessionID,
          parentOf: (id) => parentOf(id, directory),
        })
      )
        return

      dismissSessionAlert(sessionKey)

      const toastId = showToast({
        persistent: true,
        icon,
        title,
        description,
        actions: [
          {
            label: language.t("notification.action.goToSession"),
            onClick: () => navigate(href),
          },
          {
            label: language.t("common.dismiss"),
            onClick: "dismiss",
          },
        ],
      })
      toastBySession.set(sessionKey, toastId)
    })
    onCleanup(unsub)

    createEffect(() => {
      const currentSession = params.id
      if (!currentSession) return
      // #1948: navigating onto a session clears its toast and every live
      // toast for a descendant of it, whatever directory raised it.
      for (const sessionID of [...toastBySession.keys()]) {
        if (
          isViewingSessionOrAncestor({
            viewedSessionID: currentSession,
            sessionID,
            parentOf: (id) => parentOf(id),
          })
        )
          dismissSessionAlert(sessionID)
      }
    })
  })
}
