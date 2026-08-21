import { createMemo, For, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/core/util/encode"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { useServerSync } from "@/context/server-sync"
import { useLayout, type LocalProject } from "@/context/layout"
import { useSplit } from "@/context/split"
import { sortedRootSessions } from "@/pages/layout/helpers"
import { hiddenProjectWorktree } from "@/utils/amicode-hidden-project"

// amicode(workbench S1): the hideable sessions panel — the left rail of the
// workbench. Lists the focused server's sessions (recent first, the
// extension's scaffold project filtered out); click opens/focuses the session
// in the main view. S1 is hide/show + geometry only — drag sources land in S2.
// Hide/show state rides layout.sidebar (persisted per server), toggled by the
// titlebar's existing "Toggle sidebar" button.

const PANEL_LIMIT = 30

export function WorkbenchPanel() {
  const sync = useServerSync()
  const layout = useLayout()
  const navigate = useNavigate()
  const split = useSplit()

  const directories = createMemo(() =>
    layout.projects
      .list()
      .flatMap((p: LocalProject) => [p.worktree, ...(p.sandboxes ?? [])])
      .filter((d) => d !== hiddenProjectWorktree()),
  )

  const sessions = createMemo(() =>
    directories()
      .flatMap((directory) => sortedRootSessions(sync().child(directory, { bootstrap: false })[0], Date.now()))
      .sort((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created))
      .slice(0, PANEL_LIMIT),
  )

  const open = (s: Session) => navigate(`/${base64Encode(s.directory)}/session/${s.id}`)

  /** amicode(workbench S2): panel entries are drag sources — same drag model
   *  as strip tabs (the parent resolves where they land). */
  const routeOf = (s: Session) => `/${base64Encode(s.directory)}/session/${s.id}`

  return (
    <aside
      data-workbench-panel
      class="flex h-full w-60 flex-none flex-col border-r border-[var(--v2-border-border-base)] bg-[var(--v2-background-bg-deep)]"
      aria-label="Sessions"
    >
      <div class="flex h-8 flex-none items-center px-2 text-[11px] font-medium uppercase tracking-wide text-v2-text-text-muted">
        Sessions
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto px-1 pb-1">
        <For each={sessions()}>
          {(s) => (
            <button
              class="group flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[12px] text-v2-text-text-faint hover:bg-[var(--v2-background-bg-layer-02)] hover:text-v2-text-base"
              onClick={() => open(s)}
              title={s.title}
              // Solid's declarative draggable never lands on this element
              // (probed false in e2e) — set it imperatively like the titlebar.
              ref={(el) => {
                el.draggable = true
              }}
              onDragStart={(e) => {
                e.dataTransfer?.setData("text/plain", routeOf(s))
                split.beginTabDrag(routeOf(s), "panel")
              }}
              onDragEnd={() => split.endDrag()}
            >
              <span class="min-w-0 flex-1 truncate">{s.title || "Untitled session"}</span>
            </button>
          )}
        </For>
        <Show when={sessions().length === 0}>
          <div class="px-2 py-3 text-[12px] text-v2-text-text-muted">No sessions yet</div>
        </Show>
      </div>
    </aside>
  )
}
