import type { Session } from "@opencode-ai/sdk/v2/client"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { AMICODE_PANE_ID } from "@/utils/amicode-pane"
import { base64Decode } from "@opencode-ai/core/util/encode"
import { createStore, produce } from "solid-js/store"
import { Persist, persisted, removePersisted, draftPersistedKeys } from "@/utils/persist"
import { ServerConnection, useServer } from "./server"
import { createEffect, getOwner, onCleanup, startTransition } from "solid-js"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { usePlatform } from "./platform"
import { uuid } from "@/utils/uuid"
import { SessionTabsRemovedDetail } from "@/components/titlebar-session-events"
import { sessionHref } from "@/utils/session-route"
import { createTabMemory } from "./tab-memory"
import { nextTabAfterClose, pushClosedTab, removeClosedTabs, takeClosedTab, type ClosedTab } from "./closed-tabs"
import { createDraftPromptSession, type PromptModel } from "./prompt-state"
import { migrateTabs } from "./tab-migration"

export type SessionTab = {
  type: "session"
  server: ServerConnection.Key
  sessionId: string
}

export type DraftTab = {
  type: "draft"
  draftID: string
  server: ServerConnection.Key
  directory: string
  worktree?: string
}

export type Tab = SessionTab | DraftTab

export type TabInfo = {
  title?: string
  directory?: string
}

type RecentTab = {
  key?: string
}

export const draftHref = (draftID: string) => `/new-session?draftId=${encodeURIComponent(draftID)}`

export const tabHref = (tab: Tab) =>
  tab.type === "draft" ? draftHref(tab.draftID) : sessionHref(tab.server, tab.sessionId)

export const tabKey = (tab: Tab) => (tab.type === "draft" ? `draft:${tab.draftID}` : `${tab.server}\n${tabHref(tab)}`)

export function sessionHasOpenTab(tabs: Tab[], server: ServerConnection.Key, session: Session) {
  return tabs.some((tab) => tab.type === "session" && tab.server === server && tab.sessionId === session.id)
}

export const { use: useTabs, provider: TabsProvider } = createSimpleContext({
  name: "Tabs",
  gate: false,
  init: () => {
    const server = useServer()
    const platform = usePlatform()
    /** amicode(workbench): TabsProvider sits ABOVE the SDK/Sync providers, so
     *  a draft's project directory comes from the route or the server
     *  context — never from useSDK (there is no provider above us). */
    const draftDirectory = () => {
      if (params.dir) return base64Decode(params.dir) ?? ""
      return server.projects.list()[0]?.worktree ?? ""
    }
    const fallback = server.key
    const [store, setStore, _, ready] = persisted(
      {
        // amicode(split): a pane's tab list is namespaced by its pane id —
        // persisted stores don't live-sync across documents, so a shared key
        // would make the two strips fight last-writer-wins.
        ...Persist.window(AMICODE_PANE_ID ? `tabs:${AMICODE_PANE_ID}` : "tabs"),
        migrate: (value: unknown) => migrateTabs(value, fallback),
      },
      createStore<Tab[]>([]),
    )
    const [recent, setRecent, , recentReady] = persisted(Persist.window("tabs.recent"), createStore<RecentTab>({}))
    const [info, setInfo] = persisted(Persist.window("tabs.info"), createStore<Record<string, TabInfo>>({}))
    const [closed, setClosed, , closedReady] = persisted(Persist.window("tabs.closed"), createStore<ClosedTab[]>([]))

    const params = useParams()
    const navigate = useNavigate()
    const location = useLocation()
    const memory = createTabMemory(getOwner())

    const closing = new Set<string>()
    let recentWrite = 0
    let recentValue: string | undefined

    const recentKey = () => (recentWrite ? recentValue : recent.key)

    const setRecentKey = (key: string | undefined) => {
      const write = ++recentWrite
      recentValue = key
      if (recentReady()) {
        setRecent("key", key)
        return
      }
      void recentReady.promise?.then(() => {
        if (write === recentWrite) setRecent("key", key)
      })
    }

    const updateClosed = (update: (stack: ClosedTab[]) => ClosedTab[]) => {
      const apply = () => setClosed((stack) => update(stack))
      if (closedReady()) {
        apply()
        return
      }
      void closedReady.promise?.then(apply)
    }

    const removeDraftPersisted = (draftID: string) => {
      for (const key of draftPersistedKeys()) {
        const target = Persist.draft(draftID, key)
        removePersisted(key === "prompt" ? Persist.prompt(target) : target, platform)
      }
    }

    const removeInfo = (key: string) => {
      if (!info[key]) return
      setInfo(
        produce((draft) => {
          delete draft[key]
        }),
      )
    }

    onCleanup(memory.dispose)

    createEffect(() => {
      if (!ready() || !recentReady()) return
      const servers = new Set(server.list.map(ServerConnection.key))
      const next = store.filter((tab) => servers.has(tab.server))
      if (next.length !== store.length) {
        for (const tab of store) {
          if (!servers.has(tab.server)) {
            const key = tabKey(tab)
            memory.remove(key)
            removeInfo(key)
          }
        }
        setStore(() => next)
      }
      if (recent.key && !next.some((tab) => tabKey(tab) === recent.key)) setRecentKey(undefined)
      const keys = new Set(next.map(tabKey))
      for (const key of Object.keys(info)) {
        if (!keys.has(key)) removeInfo(key)
      }
    })

    createEffect(() => {
      if (!closedReady()) return
      const servers = new Set(server.list.map(ServerConnection.key))
      const next = closed.filter((entry) => servers.has(entry.tab.server))
      if (next.length !== closed.length) setClosed(() => next)
    })

    const navigateTab = (tab: Tab) => {
      const href = tabHref(tab)
      setRecentKey(tabKey(tab))
      navigate(href)
    }

    const removeTab = (index: number) => {
      const tab = store[index]
      if (!tab) return
      const key = tabKey(tab)
      const draftID = tab.type === "draft" ? tab.draftID : undefined
      const nextTab = nextTabAfterClose(store, index, recentKey() === key && location.pathname !== "/")
      closing.add(key)
      void startTransition(() => {
        setStore(
          produce((tabs) => {
            tabs.splice(index, 1)
          }),
        )
        if (nextTab === null) {
          setRecentKey(undefined)
          navigate("/")
        }
        if (nextTab) navigateTab(nextTab)
      }).finally(() => closing.delete(key))
      memory.remove(key)
      removeInfo(key)
      if (draftID) removeDraftPersisted(draftID)
    }

    // Index of the tab the route currently points at (session by href, draft by
    // draftId), or -1. Used by the bulk-close actions to decide whether the
    // active tab was among those removed and therefore needs re-navigation.
    const currentTabIndex = () => {
      if (location.pathname === "/new-session" && location.query.draftId) {
        return store.findIndex((tab) => tab.type === "draft" && tab.draftID === location.query.draftId)
      }
      if (params.dir && params.id) {
        const href = tabHref({
          type: "session",
          server: server.key,
          sessionId: params.id,
        })
        return store.findIndex((tab) => tab.type === "session" && tab.server === server.key && tabHref(tab) === href)
      }
      return -1
    }

    const actions = {
      addSessionTab: (tab: Omit<SessionTab, "type">) => {
        const next = { type: "session" as const, ...tab }
        const existing = store.find((item) => tabKey(item) === tabKey(next))
        if (existing) return existing
        void startTransition(() => {
          setStore(
            produce((tabs) => {
              if (tabs.some((item) => tabKey(item) === tabKey(next))) return
              tabs.push(next)
            }),
          )
        })
        return next
      },
      reorder(keys: string[]) {
        setStore(
          produce((tabs) => {
            const byKey = new Map(tabs.map((tab) => [tabKey(tab), tab]))
            const next = keys.map((key) => byKey.get(key)).filter((tab): tab is Tab => !!tab)
            if (next.length !== tabs.length) return
            tabs.splice(0, tabs.length, ...next)
          }),
        )
      },
      /** amicode(workbench): open a tab by its ROUTE path (session or draft),
       *  no-op if already open — the bridge command for cross-pane moves.
       *  Navigates only when `activate` is set. Returns true when the tab is
       *  present afterwards (the ack the parent waits on). */
      openPath: (path: string, opts?: { activate?: boolean }): boolean => {
        const session = /^\/([^/]+)\/session\/([^/?]+)/.exec(path)
        if (session) {
          // session tabs are server-scoped (no dirBase64 field post-merge) —
          // the route's dir segment is parsed but not stored.
          const [, , sessionId] = session
          actions.addSessionTab({ server: server.key, sessionId })
          if (opts?.activate) navigate(path)
          return true
        }
        const draft = /^\/new-session\?draftId=([^&]+)/.exec(path)
        if (draft) {
          const draftID = draft[1]
          setStore(
            produce((tabs) => {
              if (tabs.some((item) => item.type === "draft" && item.draftID === draftID)) return
              tabs.push({ type: "draft", draftID, server: server.key, directory: draftDirectory() })
            }),
          )
          if (opts?.activate) navigate(path)
          return true
        }
        return false
      },
      /** amicode(workbench): close a tab by its route path. Re-navigates ONLY
       *  when the closed tab was the active one — a move's close step must
       *  never yank the user's current view. */
      closePath: (path: string): void => {
        const index = store.findIndex((tab) => tabHref(tab) === path || (tab.type === "draft" && draftHref(tab.draftID) === path))
        if (index === -1) return
        const tab = store[index]
        const wasActive = currentTabIndex() === index
        const draftID = tab.type === "draft" ? tab.draftID : undefined
        closing.add(tabKey(tab))
        setStore(
          produce((tabs) => {
            tabs.splice(index, 1)
          }),
        )
        if (draftID) removeDraftPersisted(draftID)
        if (wasActive) {
          const next = store[index] ?? store[index - 1]
          if (next) navigateTab(next)
          else navigate("/")
        }
        closing.delete(tabKey(tab))
      },
      draft(draftID: string) {
        const tab = store.find((item) => item.type === "draft" && item.draftID === draftID)
        if (!tab || tab.type !== "draft") throw new Error(`Draft not found: ${draftID}`)
        return tab
      },
      async newDraft(draft: Omit<DraftTab, "type" | "draftID">, prompt?: string, model?: PromptModel) {
        const draftID = uuid()
        const tab = { type: "draft" as const, draftID, ...draft }
        memory.ensure(tabKey(tab), "prompt", () => createDraftPromptSession(draftID, { prompt, model }))
        await startTransition(() => {
          setStore(
            produce((tabs) => {
              tabs.push(tab)
            }),
          )
          navigate(draftHref(draftID))
        })
        return tab
      },
      updateDraft(draftID: string, draft: Partial<Omit<DraftTab, "type" | "draftID">>) {
        void startTransition(() => {
          setStore(
            (tab) => tab.type === "draft" && tab.draftID === draftID,
            produce((tab) => Object.assign(tab, draft)),
          )
        })
      },
      promoteDraft(draftID: string, session: Omit<SessionTab, "type">) {
        // Keep the replacement and navigation atomic so /new-session never renders
        // after its backing draft tab has been removed from the store.
        const active = location.pathname === "/new-session" && location.query.draftId === draftID
        const next = { type: "session" as const, ...session }
        void startTransition(() => {
          setStore(
            produce((tabs) => {
              const index = tabs.findIndex((tab) => tab.type === "draft" && tab.draftID === draftID)
              if (index !== -1) tabs[index] = next
            }),
          )
          if (recent.key === `draft:${draftID}`) setRecentKey(tabKey(next))
          if (active) navigateTab(next)
        })
        memory.remove(`draft:${draftID}`)
        removeDraftPersisted(draftID)
      },
      removeTab,
      // User-initiated close: records the tab so it can be reopened.
      // Cleanup paths (missing sessions, archive, server removal) go through
      // removeTab and friends directly and are not recorded.
      closeTab(index: number) {
        const tab = store[index]
        if (!tab) return
        if (tab.type === "session") updateClosed((stack) => pushClosedTab(stack, tab, index))
        removeTab(index)
      },
      reopenClosedTab() {
        if (!closedReady()) {
          void closedReady.promise?.then(() => actions.reopenClosedTab())
          return
        }
        const result = takeClosedTab(closed, store)
        if (result.stack.length === closed.length) return
        setClosed(() => result.stack)
        const entry = result.entry
        if (!entry) return
        const index = Math.min(entry.index, store.length)
        void startTransition(() => {
          setStore(
            produce((tabs) => {
              if (tabs.some((item) => tabKey(item) === tabKey(entry.tab))) return
              tabs.splice(index, 0, entry.tab)
            }),
          )
          navigateTab(entry.tab)
        })
      },
      removeSessionTab(input: Omit<SessionTab, "type">) {
        updateClosed((stack) => removeClosedTabs(stack, input.server, [input.sessionId]))
        const index = store.findIndex(
          (tab) => tab.type === "session" && tab.server === input.server && tab.sessionId === input.sessionId,
        )
        if (index !== -1) removeTab(index)
      },
      removeServer(key: ServerConnection.Key) {
        updateClosed((stack) => stack.filter((entry) => entry.tab.server !== key))
        const drafts = store.flatMap((tab) => (tab.type === "draft" && tab.server === key ? [tab.draftID] : []))
        const removed = store.filter((tab) => tab.server === key).map(tabKey)
        setStore((tabs) => tabs.filter((tab) => tab.server !== key))
        for (const key of removed) memory.remove(key)
        for (const key of removed) removeInfo(key)
        if (recent.key && removed.includes(recent.key)) setRecentKey(undefined)
        for (const draftID of drafts) removeDraftPersisted(draftID)
        if (server.key === key) navigate("/")
      },
      removeSessions: (input: SessionTabsRemovedDetail) => {
        const targetServer = input.server ?? server.key
        updateClosed((stack) => removeClosedTabs(stack, targetServer, input.sessionIDs))
        const removed = store
          .filter(
            (tab) => tab.type === "session" && tab.server === targetServer && input.sessionIDs.includes(tab.sessionId),
          )
          .map(tabKey)
        void startTransition(() => {
          setStore(
            produce((tabs) => {
              const sessionIDs = new Set(input.sessionIDs)
              const currentHref =
                targetServer === server.key && params.dir && params.id
                  ? tabHref({
                      type: "session",
                      server: targetServer,
                      sessionId: params.id,
                    })
                  : undefined
              const currentIndex = currentHref
                ? tabs.findIndex(
                    (tab) => tab.type === "session" && tab.server === targetServer && tabHref(tab) === currentHref,
                  )
                : -1
              const currentTab = tabs[currentIndex]
              const removedCurrent =
                currentTab?.type === "session" &&
                currentTab.server === targetServer &&
                sessionIDs.has(currentTab.sessionId)

              for (let i = tabs.length - 1; i >= 0; i--) {
                const tab = tabs[i]
                if (!tab || tab.type !== "session") continue
                if (tab.server !== targetServer) continue
                if (!sessionIDs.has(tab.sessionId)) continue
                tabs.splice(i, 1)
              }

              if (!removedCurrent) return
              const nextTab =
                tabs.slice(currentIndex).find((tab) => tab.type === "session") ??
                tabs.slice(0, currentIndex).findLast((tab) => tab.type === "session")
              if (nextTab) navigateTab(nextTab)
              else navigate("/")
            }),
          )
          if (recent.key && removed.includes(recent.key)) setRecentKey(undefined)
        })
        for (const key of removed) memory.remove(key)
        for (const key of removed) removeInfo(key)
      },
      rememberSessionInfo(tab: SessionTab, session: Session) {
        const key = tabKey(tab)
        const next = { title: session.title, directory: session.directory }
        const current = info[key]
        if (current?.title === next.title && current.directory === next.directory) return
        setInfo(key, next)
      },
      select: navigateTab,
      remember(tab: Tab) {
        const key = tabKey(tab)
        if (recentKey() !== key) setRecentKey(key)
      },
      toggleHome(input: { home: boolean; current?: Tab }) {
        if (input.home) {
          const tab = store.find((tab) => tabKey(tab) === recentKey())
          if (tab) navigateTab(tab)
          return
        }
        if (input.current) {
          setRecentKey(tabKey(input.current))
          navigate("/")
          return
        }
        navigate("/")
      },
      state<T>(tab: Tab, name: string, init: () => T) {
        return memory.ensure(tabKey(tab), name, init)
      },
      stateValue<T>(tab: Tab, name: string) {
        return memory.get<T>(tabKey(tab), name)
      },
      // Close every tab except the one at `index`. The kept tab always becomes
      // active (all others, including whatever was active, are gone).
      closeOthers: (index: number) => {
        const keep = store[index]
        if (!keep || store.length <= 1) return
        const draftIDs = store.flatMap((tab, i) => (i !== index && tab.type === "draft" ? [tab.draftID] : []))
        void startTransition(() => {
          setStore(
            produce((tabs) => {
              const kept = tabs[index]
              if (kept) tabs.splice(0, tabs.length, kept)
            }),
          )
          navigateTab(keep)
        })
        for (const draftID of draftIDs) removeDraftPersisted(draftID)
      },
      // Close all tabs after `index`. Re-navigate to the anchor only if the
      // active tab was one of the removed (mirrors editor "close to the right").
      closeToRight: (index: number) => {
        const anchor = store[index]
        if (!anchor || index >= store.length - 1) return
        const draftIDs = store.slice(index + 1).flatMap((tab) => (tab.type === "draft" ? [tab.draftID] : []))
        const removedActive = currentTabIndex() > index
        void startTransition(() => {
          setStore(
            produce((tabs) => {
              tabs.splice(index + 1)
            }),
          )
          if (removedActive) navigateTab(anchor)
        })
        for (const draftID of draftIDs) removeDraftPersisted(draftID)
      },
      // Close all tabs before `index`. Re-navigate to the anchor only if the
      // active tab was one of the removed (mirrors editor "close to the left").
      closeToLeft: (index: number) => {
        const anchor = store[index]
        if (!anchor || index <= 0) return
        const draftIDs = store.slice(0, index).flatMap((tab) => (tab.type === "draft" ? [tab.draftID] : []))
        const active = currentTabIndex()
        const removedActive = active >= 0 && active < index
        void startTransition(() => {
          setStore(
            produce((tabs) => {
              tabs.splice(0, index)
            }),
          )
          if (removedActive) navigateTab(anchor)
        })
        for (const draftID of draftIDs) removeDraftPersisted(draftID)
      },
    }

    return { ...actions, store, info, ready, recentReady }
  },
})
