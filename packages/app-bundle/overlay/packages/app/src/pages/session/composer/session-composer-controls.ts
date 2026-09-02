import { base64Encode } from "@opencode-ai/core/util/encode"
import { createQuery } from "@tanstack/solid-query"
import { useNavigate, useSearchParams } from "@solidjs/router"
import { type Accessor, createMemo } from "solid-js"
import type { PromptInputControls } from "@/components/prompt-input/contracts"
import type { PromptProjectControls } from "@/components/prompt-project-selector"
import { hiddenProjectWorktree } from "@/utils/amicode-hidden-project"
import { workspaceProjects, requestAddWorkspaceProject, notifyProjectSelected } from "@/utils/amicode-workspace-projects"
import { useDirectoryPicker } from "@/components/directory-picker"
import { useGlobal } from "@/context/global"
import { useLayout } from "@/context/layout"
import { useLocal, type ModelSelection } from "@/context/local"
import type { QueryOptionsApi } from "@/context/server-sync"
import { useServerSDK } from "@/context/server-sdk"
import { serverName, ServerConnection, useServer } from "@/context/server"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useTabs } from "@/context/tabs"
import { useProviders } from "@/hooks/use-providers"
import { pathKey } from "@/utils/path-key"

export function createPromptInputController(input: {
  sessionKey: Accessor<string>
  sessionID: Accessor<string | undefined>
  queryOptions: Pick<QueryOptionsApi, "agents" | "providers">
  model?: ModelSelection
}) {
  const layout = useLayout()
  const local = useLocal()
  const sdk = useSDK()
  const sync = useSync()
  const providers = useProviders(() => sdk().directory)
  const view = layout.view(input.sessionKey)
  const agentsQuery = createQuery(() => input.queryOptions.agents(pathKey(sdk().directory)))
  const globalProvidersQuery = createQuery(() => input.queryOptions.providers(null))
  const providersQuery = createQuery(() => input.queryOptions.providers(pathKey(sdk().directory)))

  return createMemo<PromptInputControls>(() => {
    return {
      agents: {
        available: sync().data.agent,
        options: local.agent.list().map((agent) => agent.name),
        current: local.agent.current()?.name ?? "",
        loading: agentsQuery.isLoading,
        visible: local.agent.visible(),
        select: local.agent.set,
      },
      model: {
        selection: input.model ?? local.model,
        paid: providers.paid().length > 0,
        loading:
          (local.agent.visible() && agentsQuery.isLoading) ||
          providersQuery.isLoading ||
          globalProvidersQuery.isLoading,
      },
      session: {
        id: input.sessionID(),
        tabs: layout.tabs(input.sessionKey),
        reviewPanel: view.reviewPanel,
      },
    }
  })
}

export function createPromptProjectControls() {
  const navigate = useNavigate()
  const layout = useLayout()
  const server = useServer()
  const serverSDK = useServerSDK()
  const sdk = useSDK()
  const tabs = useTabs()
  const global = useGlobal()
  const pickDirectory = useDirectoryPicker()
  const [search] = useSearchParams<{ draftId?: string }>()
  const projectServer = () => serverSDK().server
  const projectServerCtx = createMemo(() => global.ensureServerCtx(projectServer()))
  const projects = createMemo(() => {
    // amicode#663: when the extension host pushes workspace folder data, use
    // it as the canonical project list (workspace-backed, type-grouped).
    const wsProjects = workspaceProjects()
    if (wsProjects.length > 0) {
      return wsProjects.map((p) => ({
        name: p.name,
        worktree: p.worktree,
        type: p.type as "research" | "dev",
        status: p.status,
      }))
    }
    // Fallback: opencode-native project discovery (standalone / no extension).
    const list =
      server.list.length <= 1
        ? search.draftId
          ? projectServerCtx().projects.list()
          : layout.projects.list()
        : server.list.flatMap((conn) => {
            const item = { key: ServerConnection.key(conn), name: serverName(conn) }
            return global
              .ensureServerCtx(conn)
              .projects.list()
              .map((project) => ({ ...project, server: item }))
          })
    const hidden = hiddenProjectWorktree()
    return hidden ? list.filter((p) => p.worktree !== hidden) : list
  })
  const selectProject = (worktree: string, serverKey?: string) => {
    // #673: toggle — re-clicking the already-selected project deselects it.
    // Reset to the hidden scaffold dir so current() returns undefined.
    // Notify the extension with the non-matching path so the sidebar clears.
    if (pathKey(worktree) === pathKey(sdk().directory)) {
      const fallback = hiddenProjectWorktree()
      if (search.draftId && fallback) {
        notifyProjectSelected(fallback, true)
        tabs.updateDraft(search.draftId, { directory: fallback })
      }
      return
    }
    // #663: tell the extension host so the sidebar can focus this project
    // (collapse others, expand selected). Fire-and-forget — the sidebar update
    // is cosmetic and must never block selection.
    notifyProjectSelected(worktree)
    const conn = serverKey ? server.list.find((conn) => ServerConnection.key(conn) === serverKey) : projectServer()
    if (search.draftId) {
      if (!conn) return
      const target = global.ensureServerCtx(conn)
      target.projects.open(worktree)
      target.projects.touch(worktree)
      tabs.updateDraft(search.draftId, { server: ServerConnection.key(conn), directory: worktree })
      return
    }

    if (!serverKey) {
      layout.projects.open(worktree)
      server.projects.touch(worktree)
      navigate(`/${base64Encode(worktree)}/session`)
      return
    }

    if (!conn) return
    const target = global.ensureServerCtx(conn)
    target.projects.open(worktree)
    target.projects.touch(worktree)
    server.setActive(ServerConnection.key(conn))
    navigate(`/${base64Encode(worktree)}/session`)
  }

  const addProject = (title: string, serverKey?: string) => {
    // amicode#663: delegate to the extension host for the native folder picker.
    if (hiddenProjectWorktree()) {
      requestAddWorkspaceProject()
      return
    }
    const conn = serverKey ? server.list.find((conn) => ServerConnection.key(conn) === serverKey) : projectServer()
    if (!conn) return
    pickDirectory({
      server: conn,
      title,
      onSelect: (result) => {
        const directory = Array.isArray(result) ? result[0] : result
        if (directory) selectProject(directory, serverKey)
      },
    })
  }

  return createMemo<PromptProjectControls>(() => ({
    available: projects(),
    directory: sdk().directory,
    server: server.list.length > 1 ? ServerConnection.key(projectServer()) : undefined,
    select: selectProject,
    add: addProject,
  }))
}
