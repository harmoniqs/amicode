import { Popover as Kobalte } from "@kobalte/core/popover"
import { Component, ComponentProps, createEffect, createMemo, For, JSX, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLocal } from "@/context/local"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { Tag } from "@opencode-ai/ui/tag"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { Tag as TagV2 } from "@opencode-ai/ui/v2/badge-v2"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { ModelTooltip } from "./model-tooltip"
// amicode#1999 (#1979 S9): two-line row — the name gets the full width.
import { ModelPickerRow } from "./model-picker-row"
import { useLanguage } from "@/context/language"
import { decode64 } from "@/utils/base64"
import { handleDocumentSearchKeydown } from "@/utils/search-keydown"
import { createMenuDismissController } from "@/utils/menu-dismiss-controller"
import { createEventListener } from "@solid-primitives/event-listener"
// amicode#1986 (#1979 S3): reachability merge — hide dead models, "Show unavailable (N)".
import { createModelReachability, type ModelReachabilityState } from "./dialog-select-model-reachability-source"
import {
  partitionByReachability,
  reachabilityReason,
  type ModelReachabilityView,
} from "./dialog-select-model-reachability"
// amicode#1987 (#1979 S4): short-list view — Favorites → Recommended (by role) → Recent,
// capped; everything else behind search; model.allowlist hard-filters all of it.
import { useModels } from "@/context/models"
import {
  buildModelShortlist,
  isAllowed,
  type ModelShortlist,
  type ShortlistGroup,
} from "./dialog-select-model-shortlist"
import { createModelShortlistConfig } from "./dialog-select-model-shortlist-source"
import { createModelArrivals } from "./model-arrivals-source"
// amicode#1988 (#1979 S5): price / context / tools / measured latency inline,
// full detail in the tooltip; cheapest-that-works order while searching.
import {
  compareCheapestOk,
  effectivePrice,
  formatRowInline,
  latencyOf,
  modelRowMeta,
  searchTier,
  type ModelRowMeta,
} from "./model-row-meta"

const isFree = (provider: string, cost: { input: number } | undefined) =>
  provider === "opencode" && (!cost || cost.input === 0)

type ModelState = ReturnType<typeof useLocal>["model"]
type ModelItem = ReturnType<ModelState["list"]>[number]

const modelKey = (model: ModelItem) => `${model.provider.id}:${model.id}`
const manageKey = "action:manage"

// amicode#1986: reachability helpers shared by both pickers.
const modelRef = (model: ModelItem) => ({ providerID: model.provider.id, modelID: model.id })
const currentRef = (model: ModelState) => {
  const value = model.current()
  return value ? modelRef(value) : undefined
}

// amicode#1999: the reachability reason text — the tag's title, and (for a
// greyed row) the row's line-2 note.
function useReachabilityReason() {
  const language = useLanguage()
  return (view: ModelReachabilityView) => {
    const r = reachabilityReason(view)
    return r ? ("key" in r ? language.t(r.key) : r.text) : undefined
  }
}

/** The reachability tag (trailing, line 1). The greyed reason text moved to
 *  the row's line 2 (amicode#1999) so it never squeezes the name. */
function ReachabilityBadge(props: { view: ModelReachabilityView; v2?: boolean }) {
  const language = useLanguage()
  const reasonOf = useReachabilityReason()
  const reason = () => reasonOf(props.view)
  const label = () => {
    if (props.view.tag === "unchecked") return language.t("dialog.model.reachability.tag.unchecked")
    if (props.view.tag === "rate-limited") return language.t("dialog.model.reachability.tag.rateLimited")
    if (props.view.tag === "selected-dead") return language.t("dialog.model.reachability.tag.selectedDead")
    return undefined
  }
  return (
    <Show when={label()}>
      {(text) =>
        props.v2 ? (
          <TagV2 class="shrink-0" title={reason()}>
            {text()}
          </TagV2>
        ) : (
          <Tag title={reason()}>{text()}</Tag>
        )
      }
    </Show>
  )
}

function ReachabilityControls(props: { state: ModelReachabilityState; hiddenCount: number; class?: string }) {
  const language = useLanguage()
  return (
    <Show when={props.state.snapshot()}>
      <div class={`flex items-center justify-between gap-2 text-12-regular text-text-weak ${props.class ?? ""}`}>
        <Show when={props.hiddenCount > 0} fallback={<span />}>
          <button
            type="button"
            class="truncate hover:text-text-base"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => props.state.setShowUnavailable(!props.state.showUnavailable())}
          >
            {props.state.showUnavailable()
              ? language.t("dialog.model.reachability.hideUnavailable")
              : language.t("dialog.model.reachability.showUnavailable", { count: props.hiddenCount })}
          </button>
        </Show>
        <button
          type="button"
          class="shrink-0 hover:text-text-base disabled:opacity-50"
          disabled={props.state.rechecking()}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => void props.state.recheck()}
        >
          {props.state.rechecking()
            ? language.t("dialog.model.reachability.rechecking")
            : language.t("dialog.model.reachability.recheck")}
        </button>
      </div>
    </Show>
  )
}

// amicode#1987: the shared short-list wiring for both pickers. The allowlist
// filters BEFORE the reachability merge so "Show unavailable (N)" counts only
// allowed models; buildModelShortlist re-applies it (the tested hard filter).
function createModelShortlist(input: { model: ModelState; provider: () => string | undefined }) {
  const models = useModels()
  const language = useLanguage()
  const reachability = createModelReachability()
  const config = createModelShortlistConfig()
  const arrivals = createModelArrivals() // amicode#2000: the 7-day "New" tag
  const byName = (a: ModelItem, b: ModelItem) => a.name.localeCompare(b.name)
  const partition = createMemo(() =>
    partitionByReachability(
      input.model
        .list()
        .filter((m) => input.model.visible({ modelID: m.id, providerID: m.provider.id }))
        .filter((m) => (input.provider() ? m.provider.id === input.provider() : true))
        .filter((m) => isAllowed(modelRef(m), config()?.allowlist)),
      modelRef,
      reachability.snapshot(),
      currentRef(input.model),
    ),
  )
  const sorted = createMemo(() => ({
    shown: [...partition().shown].sort(byName),
    hidden: [...partition().hidden].sort(byName),
  }))
  // amicode#1988: search-only — a dead model never sorts above an ok one.
  const searchSort = compareCheapestOk<ModelItem>({
    tierOf: (item) => searchTier(partition().view(item)),
    priceOf: (item) => effectivePrice(item.cost),
    nameOf: (item) => item.name,
  })
  const labels = () => ({
    free: language.t("model.meta.free"),
    cache: language.t("model.meta.cache"),
    perMtok: language.t("model.meta.perMtok"),
  })
  return {
    reachability,
    partition,
    view: (search: string): ModelShortlist<ModelItem> =>
      buildModelShortlist({
        shown: sorted().shown,
        hidden: sorted().hidden,
        showUnavailable: reachability.showUnavailable(),
        keyOf: modelRef,
        searchText: (item) => [item.name, item.id, item.provider.name],
        favorites: models.favorite.list(),
        recents: models.recent.list(),
        config: config(),
        query: search,
        searchSort,
      }),
    meta: (item: ModelItem): ModelRowMeta =>
      modelRowMeta(item, latencyOf(reachability.snapshot(), modelRef(item)), labels()),
    isNew: (item: ModelItem) => arrivals.isNew(modelRef(item)),
    isFavorite: (item: ModelItem) => models.favorite.has(modelRef(item)),
    toggleFavorite: (item: ModelItem) => models.favorite.toggle(modelRef(item)),
  }
}

type ShortlistLabelKey =
  | "dialog.model.shortlist.favorites"
  | "dialog.model.shortlist.recent"
  | "dialog.model.shortlist.other"
  | "dialog.model.shortlist.role.default"
  | "dialog.model.shortlist.role.fast"
  | "dialog.model.shortlist.role.strong"
  | "dialog.model.shortlist.role.openWeight"

const shortlistLabelKey = (group: ShortlistGroup<ModelItem>): ShortlistLabelKey => {
  if (group.kind === "favorites") return "dialog.model.shortlist.favorites"
  if (group.kind === "recent") return "dialog.model.shortlist.recent"
  if (group.kind === "other") return "dialog.model.shortlist.other"
  if (group.role === "fast") return "dialog.model.shortlist.role.fast"
  if (group.role === "strong") return "dialog.model.shortlist.role.strong"
  if (group.role === "open-weight") return "dialog.model.shortlist.role.openWeight"
  return "dialog.model.shortlist.role.default"
}

/** The group heading; empty when the whole (uncapped) list is one "Other"
 *  group — a lone "Other" header over everything says nothing. */
const shortlistGroupLabel = (
  view: ModelShortlist<ModelItem>,
  group: ShortlistGroup<ModelItem>,
  t: (key: ShortlistLabelKey) => string,
) => (view.mode === "all" && view.groups.length === 1 ? "" : t(shortlistLabelKey(group)))

function FavoriteStar(props: { active: boolean; onToggle: () => void }) {
  const language = useLanguage()
  const stop = (event: Event) => {
    event.preventDefault()
    event.stopPropagation()
  }
  const label = () => language.t(props.active ? "dialog.model.favorite.remove" : "dialog.model.favorite.add")
  return (
    <span
      role="button"
      tabIndex={-1}
      aria-label={label()}
      aria-pressed={props.active}
      title={label()}
      data-slot="model-favorite-toggle"
      class="ml-auto flex size-5 shrink-0 items-center justify-center rounded-sm hover:text-text-strong"
      classList={{ "text-text-weak opacity-60 hover:opacity-100": !props.active, "text-icon-warning-base": props.active }}
      on:pointerdown={stop}
      on:pointerup={stop}
      on:mousedown={stop}
      on:click={(event) => {
        stop(event)
        props.onToggle()
      }}
    >
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
        <path
          d="M8 1.75l1.9 3.85 4.25.62-3.08 3 .73 4.23L8 11.45l-3.8 2 .73-4.23-3.08-3 4.25-.62L8 1.75z"
          fill={props.active ? "currentColor" : "none"}
          stroke="currentColor"
          stroke-linejoin="round"
        />
      </svg>
    </span>
  )
}

function ShortlistMore(props: { count: number; class?: string }) {
  const language = useLanguage()
  return (
    <Show when={props.count > 0}>
      <div class={`truncate text-12-regular text-text-weak ${props.class ?? ""}`}>
        {language.t("dialog.model.shortlist.more", { count: props.count })}
      </div>
    </Show>
  )
}

const ModelList: Component<{
  provider?: string
  class?: string
  onSelect: () => void
  action?: JSX.Element
  model?: ModelState
}> = (props) => {
  const model = props.model ?? useLocal().model
  const language = useLanguage()

  const shortlist = createModelShortlist({ model, provider: () => props.provider })
  const reasonOf = useReachabilityReason()
  const reachability = shortlist.reachability
  const partition = shortlist.partition
  // amicode#1987: the short-list view owns filtering, order and grouping —
  // List's own fuzzy filter is skipped (skipFilter) and its groups follow the
  // view's (group label → view order) for the query List last asked about.
  const [current, setCurrent] = createStore({ view: shortlist.view("") })
  const groupOf = createMemo(() => {
    const view = current.view
    const label = new Map<string, string>()
    const order = new Map<string, number>()
    view.groups.forEach((group, index) => {
      const text = shortlistGroupLabel(view, group, (key) => language.t(key))
      order.set(text, index)
      for (const item of group.items) label.set(modelKey(item), text)
    })
    return { label, order }
  })

  return (
    <>
      <List
        class={`flex-1 px-3 min-h-0 [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:min-h-0 ${props.class ?? ""}`}
        search={{ placeholder: language.t("dialog.model.search.placeholder"), autofocus: true, action: props.action }}
        emptyMessage={language.t("dialog.model.empty")}
        key={(x) => `${x.provider.id}:${x.id}`}
        items={(filter) => {
          const view = shortlist.view(filter)
          setCurrent("view", view)
          return view.items
        }}
        current={model.current()}
        skipFilter={() => true}
        groupBy={(x) => groupOf().label.get(modelKey(x)) ?? ""}
        sortGroupsBy={(a, b) => (groupOf().order.get(a.category) ?? 0) - (groupOf().order.get(b.category) ?? 0)}
        itemWrapper={(item, node) => (
          <Tooltip
            class="w-full"
            placement="right-start"
            gutter={12}
            openDelay={0}
            value={
              <ModelTooltip
                model={item}
                latest={item.latest}
                free={isFree(item.provider.id, item.cost)}
                meta={shortlist.meta(item)}
              />
            }
          >
            {node}
          </Tooltip>
        )}
        onSelect={(x) => {
          model.set(x ? { modelID: x.id, providerID: x.provider.id } : undefined, {
            recent: true,
          })
          props.onSelect()
        }}
      >
        {(i) => (
          <ModelPickerRow
            name={i.name}
            provider={i.provider.name}
            meta={formatRowInline(shortlist.meta(i), {
              omitPrice: isFree(i.provider.id, i.cost),
              noTools: language.t("model.meta.noTools"),
            })}
            metaTitle={shortlist.meta(i).price}
            greyed={partition().view(i).greyed}
            reason={partition().view(i).greyed ? reasonOf(partition().view(i)) : undefined}
            trailing={
              <>
                <Show when={isFree(i.provider.id, i.cost)}>
                  <Tag>{language.t("model.tag.free")}</Tag>
                </Show>
                <Show when={i.latest}>
                  <Tag>{language.t("model.tag.latest")}</Tag>
                </Show>
                <Show when={shortlist.isNew(i)}>
                  <Tag>{language.t("model.tag.new")}</Tag>
                </Show>
                <ReachabilityBadge view={partition().view(i)} />
                <FavoriteStar active={shortlist.isFavorite(i)} onToggle={() => shortlist.toggleFavorite(i)} />
              </>
            }
          />
        )}
      </List>
      <ShortlistMore count={current.view.rest} class="px-4 pt-1" />
      <ReachabilityControls state={reachability} hiddenCount={partition().hiddenCount} class="px-4 pt-1" />
    </>
  )
}

type ModelSelectorTriggerProps = Omit<ComponentProps<typeof Kobalte.Trigger>, "as" | "ref">
type ModelSelectorTrigger = (props: ModelSelectorTriggerProps) => JSX.Element
type Dismiss = "escape" | "outside" | "select" | "manage" | "provider"

export function ModelSelectorPopover(props: {
  provider?: string
  model?: ModelState
  trigger: ModelSelectorTrigger
  onClose?: (cause: "escape" | "select") => void
}) {
  const [store, setStore] = createStore<{
    open: boolean
    dismiss: Dismiss | null
  }>({
    open: false,
    dismiss: null,
  })
  const dialog = useDialog()
  const local = useLocal()
  const directory = () => decode64(local.slug())

  const close = (dismiss: Dismiss) => {
    setStore("dismiss", dismiss)
    setStore("open", false)
  }

  const handleManage = () => {
    close("manage")
    void import("./dialog-manage-models").then((x) => {
      dialog.show(() => <x.DialogManageModels />)
    })
  }

  const handleConnectProvider = () => {
    close("provider")
    void import("./dialog-connect-provider").then((x) => {
      void dialog.show(() => <x.DialogConnectProvider directory={directory} />)
    })
  }
  const language = useLanguage()

  return (
    <Kobalte
      open={store.open}
      onOpenChange={(next) => {
        if (next) setStore("dismiss", null)
        setStore("open", next)
      }}
      modal={false}
      placement="top-start"
      gutter={4}
    >
      <Kobalte.Trigger as={props.trigger} />
      <Kobalte.Portal>
        <Kobalte.Content
          class="w-72 h-[min(420px,60vh)] flex flex-col p-2 rounded-md border border-border-base bg-surface-raised-stronger-non-alpha shadow-md z-50 outline-none overflow-hidden"
          onEscapeKeyDown={(event) => {
            close("escape")
            event.preventDefault()
            event.stopPropagation()
          }}
          onPointerDownOutside={() => close("outside")}
          onFocusOutside={() => close("outside")}
          onCloseAutoFocus={(event) => {
            const dismiss = store.dismiss
            if (dismiss === "outside") event.preventDefault()
            if (dismiss === "escape" || dismiss === "select") {
              event.preventDefault()
              props.onClose?.(dismiss)
            }
            setStore("dismiss", null)
          }}
        >
          <Kobalte.Title class="sr-only">{language.t("dialog.model.select.title")}</Kobalte.Title>
          <ModelList
            provider={props.provider}
            model={props.model}
            onSelect={() => close("select")}
            class="p-1"
            action={
              <div class="flex items-center gap-1">
                <Tooltip placement="top" value={language.t("command.provider.connect")}>
                  <IconButton
                    icon="plus-small"
                    variant="ghost"
                    iconSize="normal"
                    class="size-6"
                    aria-label={language.t("command.provider.connect")}
                    onClick={handleConnectProvider}
                  />
                </Tooltip>
                <Tooltip placement="top" value={language.t("dialog.model.manage")}>
                  <IconButton
                    icon="sliders"
                    variant="ghost"
                    iconSize="normal"
                    class="size-6"
                    aria-label={language.t("dialog.model.manage")}
                    onClick={handleManage}
                  />
                </Tooltip>
              </div>
            }
          />
        </Kobalte.Content>
      </Kobalte.Portal>
    </Kobalte>
  )
}

export function ModelSelectorPopoverV2(props: {
  provider?: string
  model?: ModelState
  trigger: ModelSelectorTrigger
  onClose?: () => void
}) {
  const dialog = useDialog()
  const controller = createModelSelectorController({
    model: props.model,
    provider: () => props.provider,
    onSelect: () => props.onClose?.(),
  })

  return (
    <ModelSelectorPopoverV2View
      trigger={props.trigger}
      view={controller.view}
      favorite={controller.favorite}
      meta={controller.meta}
      isNew={controller.isNew}
      current={controller.current}
      select={controller.select}
      reachability={controller.reachability}
      onManage={() => {
        void import("./dialog-manage-models").then((module) => {
          void dialog.show(() => <module.DialogManageModelsV2 />)
        })
      }}
      onClose={() => props.onClose?.()}
    />
  )
}

function createModelSelectorController(input: {
  provider: () => string | undefined
  model?: ModelState
  onSelect: () => void
}) {
  const model = input.model ?? useLocal().model
  const language = useLanguage()
  const shortlist = createModelShortlist({ model, provider: input.provider })
  const reachability = shortlist.reachability
  const partition = shortlist.partition

  return {
    view: (search: string) => {
      const view = shortlist.view(search)
      return {
        items: view.items,
        rest: view.rest,
        groups: view.groups.map((group) => ({
          category: group.role ?? group.kind,
          label: shortlistGroupLabel(view, group, (key) => language.t(key)),
          items: group.items,
        })),
      }
    },
    favorite: {
      has: shortlist.isFavorite,
      toggle: shortlist.toggleFavorite,
    },
    meta: shortlist.meta,
    isNew: shortlist.isNew,
    current: () => {
      const value = model.current()
      return value ? modelKey(value) : undefined
    },
    select: (item: ModelItem) => {
      model.set({ modelID: item.id, providerID: item.provider.id }, { recent: true })
      input.onSelect()
    },
    reachability: {
      state: reachability,
      view: (item: ModelItem) => partition().view(item),
      hiddenCount: () => partition().hiddenCount,
    },
  }
}

function ModelSelectorPopoverV2View(props: {
  trigger: ModelSelectorTrigger
  view: (search: string) => {
    items: ModelItem[]
    rest: number
    groups: { category: string; label: string; items: ModelItem[] }[]
  }
  favorite?: { has: (item: ModelItem) => boolean; toggle: (item: ModelItem) => void }
  meta?: (item: ModelItem) => ModelRowMeta
  isNew?: (item: ModelItem) => boolean
  current: () => string | undefined
  select: (item: ModelItem) => void
  reachability?: {
    state: ModelReachabilityState
    view: (item: ModelItem) => ModelReachabilityView
    hiddenCount: () => number
  }
  onManage: () => void
  onClose: () => void
}) {
  const language = useLanguage()
  const reasonOf = useReachabilityReason()
  const [store, setStore] = createStore({ open: false, search: "", active: "" })
  let searchRef: HTMLInputElement | undefined
  let contentRef: HTMLDivElement | undefined
  const dismiss = createMenuDismissController(() => contentRef)

  const view = createMemo(() => props.view(store.search))
  const models = createMemo(() => view().items)
  const groups = createMemo(() => view().groups)
  const keys = () => [...models().map(modelKey), manageKey]
  const initialActive = () => {
    const selected = props.current()
    const options = keys()
    if (selected && options.includes(selected)) return selected
    return options[0] ?? ""
  }
  const activeItem = () =>
    store.active ? contentRef?.querySelector<HTMLElement>(`[data-option-key="${CSS.escape(store.active)}"]`) : undefined
  const setOpen = (open: boolean) => {
    if (open) {
      props.reachability?.state.refetch()
      dismiss.allowTriggerRestore()
      setStore({ open: true, active: initialActive() })
      setTimeout(() =>
        requestAnimationFrame(() => {
          searchRef?.focus()
          activeItem()?.scrollIntoView({ block: "nearest" })
        }),
      )
      return
    }
    setStore({ open: false, search: "", active: "" })
  }
  const selectModel = (item: ModelItem) => {
    dismiss.preventTriggerRestore()
    setOpen(false)
    dismiss.afterClose(() => props.select(item))
  }
  const manage = () => {
    dismiss.preventTriggerRestore()
    setOpen(false)
    dismiss.afterClose(props.onManage)
  }
  const selectActive = () => {
    const item = models().find((item) => modelKey(item) === store.active)
    if (item) {
      selectModel(item)
      return
    }
    if (store.active === manageKey) manage()
  }
  const moveActive = (delta: number) => {
    const options = keys()
    if (options.length === 0) return
    const index = options.indexOf(store.active)
    const start = index === -1 ? 0 : index
    setStore("active", options[(start + delta + options.length) % options.length])
    queueMicrotask(() => activeItem()?.scrollIntoView({ block: "nearest" }))
  }
  const setSearch = (value: string) => {
    const first = props.view(value).items[0]
    setStore({ search: value, active: first ? modelKey(first) : manageKey })
  }

  createEffect(() => {
    if (!store.open) return
    createEventListener(
      document,
      "keydown",
      (event: KeyboardEvent) => handleDocumentSearchKeydown(searchRef, event, store.search, setSearch),
      true,
    )
  })

  return (
    <MenuV2 open={store.open} modal={false} placement="top-start" gutter={6} onOpenChange={setOpen}>
      <MenuV2.Trigger as={props.trigger} />
      <MenuV2.Portal>
        <MenuV2.Content
          ref={(element: HTMLDivElement) => (contentRef = element)}
          class="w-[340px] max-w-[calc(100vw-16px)] overflow-hidden rounded-md border-0 bg-v2-background-bg-layer-01 !p-0 shadow-[var(--v2-elevation-floating)] focus:outline-none"
          onPointerDownOutside={dismiss.preventTriggerRestore}
          onFocusOutside={dismiss.preventTriggerRestore}
          onCloseAutoFocus={dismiss.onCloseAutoFocus}
        >
          <div class="flex flex-col p-0.5">
            <div class="flex h-7 items-center gap-2 rounded-sm pl-3 pr-2.5 text-v2-icon-icon-muted">
              <Icon name="magnifying-glass" size="small" class="shrink-0" />
              <input
                ref={(el) => (searchRef = el)}
                value={store.search}
                placeholder={language.t("dialog.model.search.placeholder")}
                class="h-7 min-w-0 flex-1 border-0 bg-transparent text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint"
                spellcheck={false}
                autocorrect="off"
                autocomplete="off"
                autocapitalize="off"
                onInput={(event) => setSearch(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Tab") return
                  event.stopPropagation()
                  if (event.key === "Escape") {
                    event.preventDefault()
                    dismiss.preventTriggerRestore()
                    setOpen(false)
                    dismiss.afterClose(props.onClose)
                    return
                  }
                  if (event.altKey || event.metaKey) return
                  if (event.key === "ArrowDown") {
                    event.preventDefault()
                    moveActive(1)
                    return
                  }
                  if (event.key === "ArrowUp") {
                    event.preventDefault()
                    moveActive(-1)
                    return
                  }
                  if (event.key === "Enter" && !event.isComposing) {
                    event.preventDefault()
                    selectActive()
                  }
                }}
              />
              <Show when={store.search.trim()}>
                <button
                  type="button"
                  class="flex size-5 items-center justify-center rounded-sm text-v2-icon-icon-muted hover:bg-v2-overlay-simple-overlay-hover"
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => setSearch("")}
                  aria-label={language.t("common.clear")}
                >
                  <Icon name="close" size="small" />
                </button>
              </Show>
            </div>
          </div>
          <div class="h-px bg-v2-border-border-muted" />
          <ScrollView data-slot="model-selector-scroll" class="max-h-[min(420px,60vh)] min-h-0">
            <div class="flex flex-col p-0.5 pt-0">
              <Show
                when={models().length > 0}
                fallback={
                  <div class="flex h-12 items-center px-3 text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-faint">
                    {language.t("dialog.model.empty")}
                  </div>
                }
              >
                <For each={groups()}>
                  {(group) => (
                    <MenuV2.Group>
                      <Show when={group.label}>
                        <MenuV2.GroupLabel class="sticky top-0 z-10 gap-2 bg-v2-background-bg-layer-01 px-3">
                          <span class="min-w-0 truncate">{group.label}</span>
                        </MenuV2.GroupLabel>
                      </Show>
                      <MenuV2.RadioGroup value={props.current()}>
                        <For each={group.items}>
                          {(item) => (
                            <TooltipV2
                              class="w-full"
                              placement="right-start"
                              gutter={6}
                              openDelay={0}
                              value={
                                <ModelTooltip
                                  model={item}
                                  latest={item.latest}
                                  free={isFree(item.provider.id, item.cost)}
                                  meta={props.meta?.(item)}
                                  v2
                                />
                              }
                            >
                              <MenuV2.RadioItem
                                value={modelKey(item)}
                                data-option-key={modelKey(item)}
                                data-selected-model={props.current() === modelKey(item) ? true : undefined}
                                class="scroll-my-6 w-full !h-auto min-h-7 !py-1"
                                classList={{
                                  "!bg-v2-overlay-simple-overlay-hover": store.active === modelKey(item),
                                  "opacity-50": props.reachability?.view(item).greyed === true,
                                }}
                                onMouseEnter={() => {
                                  setStore("active", modelKey(item))
                                  setTimeout(() => searchRef?.focus())
                                }}
                                onSelect={() => selectModel(item)}
                              >
                                <ModelPickerRow
                                  v2
                                  name={item.name}
                                  provider={item.provider.name}
                                  meta={(() => {
                                    const meta = props.meta?.(item)
                                    return meta
                                      ? formatRowInline(meta, {
                                          omitPrice: isFree(item.provider.id, item.cost),
                                          noTools: language.t("model.meta.noTools"),
                                        })
                                      : undefined
                                  })()}
                                  metaTitle={props.meta?.(item).price}
                                  reason={(() => {
                                    const view = props.reachability?.view(item)
                                    return view?.greyed ? reasonOf(view) : undefined
                                  })()}
                                  trailing={
                                    <>
                                      <Show when={isFree(item.provider.id, item.cost)}>
                                        <TagV2 class="shrink-0">{language.t("model.tag.free")}</TagV2>
                                      </Show>
                                      <Show when={item.latest}>
                                        <TagV2 class="shrink-0">{language.t("model.tag.latest")}</TagV2>
                                      </Show>
                                      <Show when={props.isNew?.(item)}>
                                        <TagV2 class="shrink-0">{language.t("model.tag.new")}</TagV2>
                                      </Show>
                                      <Show when={props.reachability?.view(item)}>
                                        {(view) => <ReachabilityBadge view={view()} v2 />}
                                      </Show>
                                      <Show when={props.favorite}>
                                        {(favorite) => (
                                          <FavoriteStar
                                            active={favorite().has(item)}
                                            onToggle={() => favorite().toggle(item)}
                                          />
                                        )}
                                      </Show>
                                    </>
                                  }
                                />
                              </MenuV2.RadioItem>
                            </TooltipV2>
                          )}
                        </For>
                      </MenuV2.RadioGroup>
                    </MenuV2.Group>
                  )}
                </For>
              </Show>
            </div>
          </ScrollView>
          <div class="h-px bg-v2-border-border-muted" />
          <ShortlistMore count={view().rest} class="h-7 px-3 leading-7" />
          <Show when={props.reachability}>
            {(r) => <ReachabilityControls state={r().state} hiddenCount={r().hiddenCount()} class="h-7 px-3" />}
          </Show>
          <div class="flex flex-col p-0.5">
            <MenuV2.Item
              data-option-key={manageKey}
              classList={{ "!bg-v2-overlay-simple-overlay-hover": store.active === manageKey }}
              onMouseEnter={() => {
                setStore("active", manageKey)
                setTimeout(() => searchRef?.focus())
              }}
              onSelect={manage}
            >
              <Icon name="outline-sliders" size="small" />
              <span class="min-w-0 flex-1 truncate leading-5">{language.t("dialog.model.manage")}</span>
            </MenuV2.Item>
          </div>
        </MenuV2.Content>
      </MenuV2.Portal>
    </MenuV2>
  )
}

export const DialogSelectModel: Component<{ provider?: string; model?: ModelState }> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const local = useLocal()
  const directory = () => decode64(local.slug())

  const provider = () => {
    void import("./dialog-connect-provider").then((x) => {
      void dialog.show(() => <x.DialogConnectProvider directory={directory} />)
    })
  }

  const manage = () => {
    void import("./dialog-manage-models").then((x) => {
      dialog.show(() => <x.DialogManageModels />)
    })
  }

  return (
    <Dialog
      title={language.t("dialog.model.select.title")}
      action={
        <Button class="h-7 -my-1 text-14-medium" icon="plus-small" tabIndex={-1} onClick={provider}>
          {language.t("command.provider.connect")}
        </Button>
      }
    >
      <ModelList provider={props.provider} model={props.model} onSelect={() => dialog.close()} />
      <Button variant="ghost" class="ml-3 mt-5 mb-6 text-text-base self-start" onClick={manage}>
        {language.t("dialog.model.manage")}
      </Button>
    </Dialog>
  )
}
