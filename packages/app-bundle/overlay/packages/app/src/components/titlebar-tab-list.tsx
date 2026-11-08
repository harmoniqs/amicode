// amicode(#2154): the "all tabs" list — a searchable list of every open tab,
// shown from a chevron at the end of the strip once tabs no longer fit, and
// from the tab.list command (palette + keybind). Same shape as the model
// selector: a MenuV2 with a search field that keeps focus and drives the
// active row with the arrow keys.
import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { createEventListener } from "@solid-primitives/event-listener"
import { handleDocumentSearchKeydown } from "@/utils/search-keydown"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { SessionTabStatusDot, type SessionTabStatus } from "@/pages/layout/session-tab-status"
import { filterTabList } from "./titlebar-tab-arrange"

export type TabListRow = {
  key: string
  title: string
  project?: string
  status?: SessionTabStatus
  pinned: boolean
  depth: 0 | 1
  active: boolean
  draft: boolean
}

export function TabListMenu(props: {
  rows: () => TabListRow[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (key: string) => void
  /** shown in the trigger's tooltip */
  keybind?: string
}) {
  const [search, setSearch] = createSignal("")
  const [activeKey, setActiveKey] = createSignal<string>()
  let searchRef: HTMLInputElement | undefined
  let listRef: HTMLDivElement | undefined

  const filtered = createMemo(() => filterTabList(props.rows(), search()))

  // Opening resets the query and puts the cursor on the current tab.
  createEffect(() => {
    if (!props.open) return
    setSearch("")
    setActiveKey(props.rows().find((row) => row.active)?.key ?? props.rows()[0]?.key)
    // After the menu's own open focus has run (same timing as the model
    // selector), move focus into the search field.
    setTimeout(() =>
      requestAnimationFrame(() => {
        searchRef?.focus()
        scrollActiveIntoView()
      }),
    )
  })

  // While open, the list owns the keyboard wherever focus happens to sit:
  // typing goes to the search, arrows move the cursor, Enter opens the tab.
  createEffect(() => {
    if (!props.open) return
    createEventListener(
      document,
      "keydown",
      (event: KeyboardEvent) => {
        if (event.target === searchRef) return
        if (handleNavigationKey(event)) return
        handleDocumentSearchKeydown(searchRef, event, search(), setSearch)
      },
      true,
    )
  })

  /** Arrow / Enter / Escape for the list; true when the key was handled. */
  const handleNavigationKey = (event: KeyboardEvent) => {
    if (event.altKey || event.metaKey || event.ctrlKey || event.isComposing) return false
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      event.stopPropagation()
      move(event.key === "ArrowDown" ? 1 : -1)
      return true
    }
    if (event.key === "Enter") {
      event.preventDefault()
      event.stopPropagation()
      select(activeKey())
      return true
    }
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      props.onOpenChange(false)
      return true
    }
    return false
  }

  // Keep the cursor on a row that is still listed.
  createEffect(() => {
    const rows = filtered()
    if (rows.some((row) => row.key === activeKey())) return
    setActiveKey(rows[0]?.key)
  })

  const scrollActiveIntoView = () => {
    const key = activeKey()
    if (!key || !listRef) return
    for (const el of listRef.querySelectorAll<HTMLElement>("[data-tab-list-key]")) {
      if (el.dataset.tabListKey === key) el.scrollIntoView({ block: "nearest" })
    }
  }

  const move = (offset: 1 | -1) => {
    const rows = filtered()
    if (rows.length === 0) return
    const index = rows.findIndex((row) => row.key === activeKey())
    const next = rows[(index + offset + rows.length) % rows.length]
    setActiveKey(next.key)
    requestAnimationFrame(scrollActiveIntoView)
  }

  const select = (key: string | undefined) => {
    if (!key) return
    props.onOpenChange(false)
    props.onSelect(key)
  }

  return (
    <MenuV2 open={props.open} modal={false} placement="bottom-end" gutter={6} onOpenChange={props.onOpenChange}>
      <TooltipV2 placement="bottom" value={props.keybind ? `All tabs (${props.keybind})` : "All tabs"}>
        <MenuV2.Trigger
          as={IconButtonV2}
          type="button"
          variant="ghost-muted"
          size="large"
          class="shrink-0"
          data-slot="titlebar-tab-list-trigger"
          icon={<IconV2 name="chevron-down" />}
          aria-label="All tabs"
        />
      </TooltipV2>
      <MenuV2.Portal>
        <MenuV2.Content
          data-slot="titlebar-tab-list"
          class="w-[360px] max-w-[calc(100vw-16px)] overflow-hidden rounded-md border-0 bg-v2-background-bg-layer-01 !p-0 shadow-[var(--v2-elevation-floating)] focus:outline-none"
        >
          <div class="flex flex-col p-0.5">
            <label class="flex h-7 items-center gap-2 rounded-sm pl-3 pr-2.5 text-v2-icon-icon-muted">
              <IconV2 name="magnifying-glass" size="small" class="shrink-0" />
              <input
                ref={(el) => (searchRef = el)}
                value={search()}
                placeholder="Search open tabs"
                aria-label="Search open tabs"
                class="h-7 min-w-0 flex-1 border-0 bg-transparent text-[13px] font-medium leading-5 text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint"
                spellcheck={false}
                autocorrect="off"
                autocomplete="off"
                autocapitalize="off"
                onInput={(event) => setSearch(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Tab") return
                  // Keep the menu's typeahead and the app keybinds out of the field.
                  event.stopPropagation()
                  handleNavigationKey(event)
                }}
              />
            </label>
          </div>
          <div class="h-px bg-v2-border-border-muted" />
          <div ref={(el) => (listRef = el)} class="flex max-h-[min(420px,60vh)] min-h-0 flex-col overflow-y-auto p-0.5">
            <Show
              when={filtered().length > 0}
              fallback={
                <div class="flex h-12 items-center px-3 text-[13px] font-medium text-v2-text-text-faint">
                  No open tab matches “{search().trim()}”
                </div>
              }
            >
              <For each={filtered()}>
                {(row) => (
                  <MenuV2.Item
                    data-tab-list-key={row.key}
                    data-active-row={row.key === activeKey() || undefined}
                    class="w-full !h-auto min-h-7 !py-1"
                    classList={{ "!bg-v2-overlay-simple-overlay-hover": row.key === activeKey() }}
                    onMouseEnter={() => {
                      setActiveKey(row.key)
                      setTimeout(() => searchRef?.focus())
                    }}
                    onSelect={() => select(row.key)}
                  >
                    <span
                      class="flex min-w-0 flex-1 items-center gap-1.5"
                      classList={{ "pl-4": row.depth === 1 && !search().trim() }}
                    >
                      <Show
                        when={!row.draft}
                        fallback={
                          <span class="flex size-4 shrink-0 items-center justify-center text-v2-icon-icon-muted">
                            <IconV2 name="edit" size="small" />
                          </span>
                        }
                      >
                        <SessionTabStatusDot status={row.status ?? "idle"} />
                      </Show>
                      <span class="flex min-w-0 flex-1 flex-col">
                        <span
                          class="truncate text-[13px] leading-5"
                          classList={{
                            "font-semibold text-v2-text-text-base": row.active,
                            "font-medium text-v2-text-text-base": !row.active,
                          }}
                        >
                          {row.title}
                        </span>
                        <Show when={row.project}>
                          <span class="truncate text-[11px] leading-4 text-v2-text-text-muted">{row.project}</span>
                        </Show>
                      </span>
                      <Show when={row.pinned}>
                        <span class="shrink-0 text-[11px] leading-4 text-v2-text-text-faint">Pinned</span>
                      </Show>
                      <Show when={row.active}>
                        <span class="sr-only">(current tab)</span>
                      </Show>
                    </span>
                  </MenuV2.Item>
                )}
              </For>
            </Show>
          </div>
        </MenuV2.Content>
      </MenuV2.Portal>
    </MenuV2>
  )
}
