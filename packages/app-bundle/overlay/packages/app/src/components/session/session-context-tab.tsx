import { createEffect, createMemo, createResource, createSignal, on, onCleanup, onMount, For, Show } from "solid-js"
import type { JSX } from "solid-js"
import { useSync } from "@/context/sync"
import { checksum } from "@opencode-ai/core/util/encode"
import { findLast } from "@opencode-ai/core/util/array"
import { same } from "@/utils/same"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Accordion } from "@opencode-ai/ui/accordion"
import { StickyAccordionHeader } from "@opencode-ai/ui/sticky-accordion-header"
import { File } from "@opencode-ai/session-ui/file"
import { Markdown } from "@opencode-ai/session-ui/markdown"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import type { Message, Part, UserMessage } from "@opencode-ai/sdk/v2/client"
import { useLanguage } from "@/context/language"
import { useProviders } from "@/hooks/use-providers"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { useFile } from "@/context/file"
import { useSessionLayout } from "@/pages/session/session-layout"
import { amicodeGet } from "@/utils/amicode-fetch"
import { amicoBrainRef } from "@opencode-ai/ui/brain-ref"
import {
  createContextTreeEngine,
  contextTreeKindColor,
  type ContextTreeEngine,
  type ContextTreeKind,
  type ContextTreeNodeInput,
  type ContextTreeScheme,
  type ContextTreeSelection,
} from "@opencode-ai/ui/context-tree-engine"
import { buildContextTree, vaultRefFromPath, vaultNodeLocked, type VaultMountStatus, type ContextTurn } from "@opencode-ai/ui/context-tree-data"
import { vaultPanel } from "@/context/vault-panel"
import { createOpenSessionFileTab } from "@/pages/session/helpers"
import { getSessionContext } from "./session-context-metrics"
import { estimateSessionContextBreakdown, type SessionContextBreakdownKey } from "./session-context-breakdown"
import { createSessionContextFormatter } from "./session-context-format"

const BREAKDOWN_COLOR: Record<SessionContextBreakdownKey, string> = {
  system: "var(--syntax-info)",
  user: "var(--syntax-success)",
  assistant: "var(--syntax-property)",
  tool: "var(--syntax-warning)",
  other: "var(--syntax-comment)",
}

/** Gate for the graph section: ≥1 committed (non-consider) brain ref in the session. */
export function sessionHasContextItems(
  messages: readonly { id: string; role?: string }[],
  partsFor: (messageID: string) => readonly { type?: string; tool?: string; state?: { input?: unknown } }[],
): boolean {
  for (const m of messages) {
    if (m.role !== "assistant") continue
    for (const p of partsFor(m.id) ?? []) {
      if (p?.type !== "tool" || typeof p.tool !== "string") continue
      const ref = amicoBrainRef(p.tool, (p.state?.input as Record<string, unknown>) ?? {})
      if (ref && !ref.consider) return true
    }
  }
  return false
}

const LEGEND: { kind: ContextTreeKind; label: string }[] = [
  { kind: "note", label: "notes" },
  { kind: "source", label: "source" },
  { kind: "skill", label: "skills" },
  { kind: "agent", label: "agents" },
]

function Stat(props: { label: string; value: JSX.Element }) {
  return (
    <div class="flex flex-col gap-1">
      <div class="text-12-regular text-text-weak">{props.label}</div>
      <div class="text-12-medium text-text-strong">{props.value}</div>
    </div>
  )
}

function RawMessageContent(props: { message: Message; getParts: (id: string) => Part[]; onRendered: () => void }) {
  const file = createMemo(() => {
    const parts = props.getParts(props.message.id)
    const contents = JSON.stringify({ message: props.message, parts }, null, 2)
    return {
      name: `${props.message.role}-${props.message.id}.json`,
      contents,
      cacheKey: checksum(contents),
    }
  })

  return (
    <File
      mode="text"
      file={file()}
      overflow="wrap"
      class="select-text"
      onRendered={() => requestAnimationFrame(props.onRendered)}
    />
  )
}

function RawMessage(props: {
  message: Message
  getParts: (id: string) => Part[]
  onRendered: () => void
  time: (value: number | undefined) => string
}) {
  return (
    <Accordion.Item value={props.message.id}>
      <StickyAccordionHeader>
        <Accordion.Trigger>
          <div class="flex items-center justify-between gap-2 w-full">
            <div class="min-w-0 truncate">
              {props.message.role} <span class="text-text-base">• {props.message.id}</span>
            </div>
            <div class="flex items-center gap-3">
              <div class="shrink-0 text-12-regular text-text-weak">{props.time(props.message.time.created)}</div>
              <Icon name="chevron-grabber-vertical" size="small" class="shrink-0 text-text-weak" />
            </div>
          </div>
        </Accordion.Trigger>
      </StickyAccordionHeader>
      <Accordion.Content class="bg-background-base">
        <div class="p-3">
          <RawMessageContent message={props.message} getParts={props.getParts} onRendered={props.onRendered} />
        </div>
      </Accordion.Content>
    </Accordion.Item>
  )
}

const emptyMessages: Message[] = []
const emptyUserMessages: UserMessage[] = []

export function SessionContextTab() {
  const sync = useSync()
  const language = useLanguage()
  const sdk = useSDK()
  const server = useServer()
  const file = useFile()
  const providers = useProviders(() => sdk().directory)
  const { params, tabs, view } = useSessionLayout()

  const info = createMemo(() => (params.id ? sync().session.get(params.id) : undefined))

  const messages = createMemo(
    () => {
      const id = params.id
      if (!id) return emptyMessages
      return (sync().data.message[id] ?? []) as Message[]
    },
    emptyMessages,
    { equals: same },
  )

  const getParts = (id: string) => (sync().data.part[id] ?? []) as Part[]

  const userMessages = createMemo(
    () => messages().filter((m) => m.role === "user") as UserMessage[],
    emptyUserMessages,
    { equals: same },
  )

  const visibleUserMessages = createMemo(
    () => {
      const revert = info()?.revert?.messageID
      if (!revert) return userMessages()
      return userMessages().filter((m) => m.id < revert)
    },
    emptyUserMessages,
    { equals: same },
  )

  const usd = createMemo(
    () =>
      new Intl.NumberFormat(language.intl(), {
        style: "currency",
        currency: "USD",
      }),
  )

  const ctx = createMemo(() => getSessionContext(messages(), [...providers.all().values()]))
  const formatter = createMemo(() => createSessionContextFormatter(language.intl()))

  const cost = createMemo(() => {
    return usd().format(info()?.cost ?? 0)
  })

  const counts = createMemo(() => {
    const all = messages()
    const user = all.reduce((count, x) => count + (x.role === "user" ? 1 : 0), 0)
    const assistant = all.reduce((count, x) => count + (x.role === "assistant" ? 1 : 0), 0)
    return {
      all: all.length,
      user,
      assistant,
    }
  })

  const systemPrompt = createMemo(() => {
    const msg = findLast(visibleUserMessages(), (m) => !!m.system)
    const system = msg?.system
    if (!system) return
    const trimmed = system.trim()
    if (!trimmed) return
    return trimmed
  })

  const providerLabel = createMemo(() => {
    const c = ctx()
    if (!c) return "—"
    return c.providerLabel
  })

  const modelLabel = createMemo(() => {
    const c = ctx()
    if (!c) return "—"
    return c.modelLabel
  })

  const breakdown = createMemo(
    on(
      () => [ctx()?.message.id, ctx()?.input, messages().length, systemPrompt()],
      () => {
        const c = ctx()
        if (!c?.input) return []
        return estimateSessionContextBreakdown({
          messages: messages(),
          parts: sync().data.part as Record<string, Part[] | undefined>,
          input: c.input,
          systemPrompt: systemPrompt(),
        })
      },
    ),
  )

  const breakdownLabel = (key: SessionContextBreakdownKey) => {
    if (key === "system") return language.t("context.breakdown.system")
    if (key === "user") return language.t("context.breakdown.user")
    if (key === "assistant") return language.t("context.breakdown.assistant")
    if (key === "tool") return language.t("context.breakdown.tool")
    return language.t("context.breakdown.other")
  }

  const stats = [
    { label: "context.stats.session", value: () => info()?.title ?? params.id ?? "—" },
    { label: "context.stats.messages", value: () => counts().all.toLocaleString(language.intl()) },
    { label: "context.stats.provider", value: providerLabel },
    { label: "context.stats.model", value: modelLabel },
    { label: "context.stats.limit", value: () => formatter().number(ctx()?.limit) },
    { label: "context.stats.totalTokens", value: () => formatter().number(ctx()?.total) },
    { label: "context.stats.usage", value: () => formatter().percent(ctx()?.usage) },
    { label: "context.stats.inputTokens", value: () => formatter().number(ctx()?.input) },
    { label: "context.stats.outputTokens", value: () => formatter().number(ctx()?.message.tokens.output) },
    { label: "context.stats.reasoningTokens", value: () => formatter().number(ctx()?.message.tokens.reasoning) },
    {
      label: "context.stats.cacheTokens",
      value: () =>
        `${formatter().number(ctx()?.message.tokens.cache.read)} / ${formatter().number(ctx()?.message.tokens.cache.write)}`,
    },
    { label: "context.stats.userMessages", value: () => counts().user.toLocaleString(language.intl()) },
    { label: "context.stats.assistantMessages", value: () => counts().assistant.toLocaleString(language.intl()) },
    { label: "context.stats.totalCost", value: cost },
    { label: "context.stats.sessionCreated", value: () => formatter().time(info()?.time.created) },
    { label: "context.stats.lastActivity", value: () => formatter().time(ctx()?.message.time.created) },
  ] satisfies { label: string; value: () => JSX.Element }[]

  // ─── Context tree (relocated from the top panel per ADR 0004) ────────────
  // per-mount browsability from GET /amicode/vaults; the wire also carries
  // each mount's DIRECTORY identity (dirName) so a path-derived vault ref —
  // which names the vault by its directory, not its marker-name id —
  // resolves to the right mount instead of failing closed (amicode#447)
  const [vaultsRaw] = createResource(
    () => server.current,
    (conn) => amicodeGet(conn, "/amicode/vaults").catch(() => undefined),
  )
  const vaultMounts = createMemo<readonly VaultMountStatus[] | undefined>(() => {
    const raw = vaultsRaw() as { mounts?: { id?: string; browsable?: boolean; dirName?: string }[] } | undefined
    if (!raw || !Array.isArray(raw.mounts)) return undefined
    return raw.mounts.filter(
      (m): m is VaultMountStatus => typeof m?.id === "string",
    )
  })
  const vaultLocked = (mount: string) => vaultNodeLocked({ mounts: vaultMounts(), vaultDir: mount })

  const busy = createMemo(() => (sync().data.session_status[params.id ?? ""]?.type ?? "idle") !== "idle")

  const turns = createMemo<ContextTurn[]>(() => {
    const byPrompt = new Map<string, ContextTurn>()
    const out: ContextTurn[] = []
    for (const m of messages()) {
      if (m.role !== "assistant") continue
      const key = (m as { parentID?: string }).parentID ?? m.id
      let turn = byPrompt.get(key)
      if (!turn) {
        turn = { id: key, refs: [], busy: false }
        byPrompt.set(key, turn)
        out.push(turn)
      }
      for (const p of getParts(m.id)) {
        if (p.type !== "tool") continue
        const ref = amicoBrainRef((p as { tool: string }).tool, ((p as { state?: { input?: unknown } }).state?.input ?? {}) as Record<string, unknown>)
        if (!ref || ref.consider) continue
        turn.refs.push(ref)
      }
      if (typeof (m as { time?: { completed?: number } }).time?.completed !== "number" && busy()) turn.busy = true
    }
    return out.filter((t) => t.refs.length > 0)
  })

  const treeItemCount = createMemo(() => {
    const seen = new Set<string>()
    for (const t of turns()) for (const r of t.refs) seen.add(r.path ?? r.label.toLowerCase())
    return seen.size
  })

  const hasTreeItems = createMemo(() => treeItemCount() > 0)

  const [engine, setEngine] = createSignal<ContextTreeEngine>()
  const currentScheme = (): ContextTreeScheme =>
    document.documentElement.dataset.colorScheme === "light" ? "light" : "dark"
  const [scheme, setScheme] = createSignal<ContextTreeScheme>(
    typeof document === "undefined" ? "dark" : currentScheme(),
  )

  // node clicks open the real thing
  const openTab = createOpenSessionFileTab({
    normalizeTab: (tab) => (tab.startsWith("file://") ? file.tab(tab) : tab),
    openTab: (tab) => tabs().open(tab),
    pathFromTab: file.pathFromTab,
    loadFile: file.load,
    openReviewPanel: () => {
      if (!view().reviewPanel.opened()) view().reviewPanel.open()
    },
    setActive: (tab) => tabs().setActive(tab),
  })
  const onTreeSelect = (node: ContextTreeSelection) => {
    if (!node.path || node.locked) return
    const vaultRef = vaultRefFromPath(node.path)
    if (vaultRef) {
      vaultPanel.open({ mount: vaultRef.mount, path: vaultRef.rel })
      return
    }
    openTab(file.tab(node.path))
  }

  // theme observer
  const themeObserver = new MutationObserver(() => {
    setScheme(currentScheme())
    engine()?.setTheme(currentScheme())
  })
  onMount(() => {
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-color-scheme"] })
    engine()?.resize()
    engine()?.resume()
  })
  onCleanup(() => {
    themeObserver.disconnect()
    engine()?.destroy()
  })

  // hover glance from tool rows in the log
  const onToolHover = (e: Event) => {
    const d = (e as CustomEvent).detail as { label?: string } | undefined
    if (d?.label) engine()?.highlight(d.label)
  }
  window.addEventListener("amicode:brain-hover", onToolHover)
  onCleanup(() => window.removeEventListener("amicode:brain-hover", onToolHover))

  const tree = createMemo(() => buildContextTree(turns(), { vaultLocked }))
  createEffect(() => {
    const brain = engine()
    if (!brain) return
    brain.setTree(tree())
  })

  // keyboard navigation
  const flatNodes = createMemo(() => {
    const out: ContextTreeSelection[] = []
    const walk = (n: ContextTreeNodeInput) => {
      if (n.kind !== "root")
        out.push({ id: n.id, label: n.label, kind: n.kind, path: n.path, vault: n.vault, locked: n.locked })
      for (const c of n.children ?? []) walk(c)
    }
    walk(tree())
    return out
  })
  const [kbIndex, setKbIndex] = createSignal(-1)
  const [announce, setAnnounce] = createSignal("")
  const kbFocus = (index: number) => {
    const list = flatNodes()
    if (!list.length) return
    const next = Math.min(Math.max(index, 0), list.length - 1)
    setKbIndex(next)
    const node = list[next]
    engine()?.focus(node.id)
    setAnnounce(
      `${node.label} — ${node.kind}${
        node.locked ? ", locked — this vault does not allow browsing" : node.path ? ", press Enter to open" : ""
      }`,
    )
  }
  const onCanvasKeyDown = (e: KeyboardEvent) => {
    const list = flatNodes()
    if (!list.length) return
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        e.preventDefault()
        kbFocus(kbIndex() + 1)
        return
      case "ArrowLeft":
      case "ArrowUp":
        e.preventDefault()
        kbFocus(kbIndex() - 1)
        return
      case "Home":
        e.preventDefault()
        kbFocus(0)
        return
      case "End":
        e.preventDefault()
        kbFocus(list.length - 1)
        return
      case "Enter":
      case " ": {
        if (kbIndex() < 0) return
        e.preventDefault()
        onTreeSelect(list[kbIndex()])
        return
      }
    }
  }
  // ─── End context tree ────────────────────────────────────────────────────

  let scroll: HTMLDivElement | undefined
  let frame: number | undefined
  let pending: { x: number; y: number } | undefined

  const restoreScroll = () => {
    const el = scroll
    if (!el) return

    const s = view().scroll("context")
    if (!s) return

    if (el.scrollTop !== s.y) el.scrollTop = s.y
    if (el.scrollLeft !== s.x) el.scrollLeft = s.x
  }

  const handleScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    pending = {
      x: event.currentTarget.scrollLeft,
      y: event.currentTarget.scrollTop,
    }
    if (frame !== undefined) return

    frame = requestAnimationFrame(() => {
      frame = undefined

      const next = pending
      pending = undefined
      if (!next) return

      view().setScroll("context", next)
    })
  }

  createEffect(
    on(
      () => messages().length,
      () => {
        requestAnimationFrame(restoreScroll)
      },
      { defer: true },
    ),
  )

  onCleanup(() => {
    if (frame === undefined) return
    cancelAnimationFrame(frame)
  })

  return (
    <ScrollView
      class="@container h-full"
      viewportRef={(el) => {
        scroll = el
        restoreScroll()
      }}
      onScroll={handleScroll}
    >
      <div class="px-6 pt-4 pb-10 flex flex-col gap-10">
        {/* Context tree graph — ADR 0004: relocated from the top panel */}
        <Show when={hasTreeItems()}>
          <div data-component="amico-context-tree" class="flex flex-col gap-2">
            <div class="flex items-center gap-2">
              <div class="text-12-medium text-text-base">{language.t("amicode.contextTree.title")}</div>
              <div class="text-12-regular text-text-weak">
                {language.t("amicode.contextTree.count", { count: treeItemCount() })}
              </div>
            </div>
            <div class="flex items-center gap-3">
              <For each={LEGEND}>
                {(item) => (
                  <div class="flex items-center gap-1.5">
                    <span
                      class="inline-block size-2 rounded-full"
                      style={{ background: contextTreeKindColor(scheme(), item.kind) }}
                    />
                    <span class="text-12-regular text-text-weak">{item.label}</span>
                  </div>
                )}
              </For>
              <div class="flex-1" />
              <IconButton
                icon="expand"
                variant="ghost"
                onClick={() => engine()?.fit()}
                aria-label={language.t("amicode.contextTree.fit")}
              />
            </div>
            <div class="overflow-hidden rounded-md border border-border-base bg-background-stronger" style={{ height: "192px" }}>
              <canvas
                ref={(el) =>
                  setEngine(
                    createContextTreeEngine(el, {
                      scheme: currentScheme(),
                      size: { width: 400, height: 192 },
                      onSelect: onTreeSelect,
                    }),
                  )
                }
                role="application"
                aria-roledescription="context tree"
                aria-label={language.t("amicode.contextTree.canvasLabel")}
                tabIndex={0}
                onKeyDown={onCanvasKeyDown}
                onBlur={() => setKbIndex(-1)}
                class="block h-full w-full focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-border-focus-base"
              />
            </div>
            <div aria-live="polite" class="sr-only">
              {announce()}
            </div>
          </div>
        </Show>

        <div class="grid grid-cols-1 @[32rem]:grid-cols-2 gap-4">
          <For each={stats}>
            {(stat) => <Stat label={language.t(stat.label as Parameters<typeof language.t>[0])} value={stat.value()} />}
          </For>
        </div>

        <Show when={breakdown().length > 0}>
          <div class="flex flex-col gap-2">
            <div class="text-12-regular text-text-weak">{language.t("context.breakdown.title")}</div>
            <div class="h-2 w-full rounded-full bg-surface-base overflow-hidden flex">
              <For each={breakdown()}>
                {(segment) => (
                  <div
                    class="h-full"
                    style={{
                      width: `${segment.width}%`,
                      "background-color": BREAKDOWN_COLOR[segment.key],
                    }}
                  />
                )}
              </For>
            </div>
            <div class="flex flex-wrap gap-x-3 gap-y-1">
              <For each={breakdown()}>
                {(segment) => (
                  <div class="flex items-center gap-1 text-11-regular text-text-weak">
                    <div class="size-2 rounded-sm" style={{ "background-color": BREAKDOWN_COLOR[segment.key] }} />
                    <div>{breakdownLabel(segment.key)}</div>
                    <div class="text-text-weaker">{segment.percent.toLocaleString(language.intl())}%</div>
                  </div>
                )}
              </For>
            </div>
            <div class="hidden text-11-regular text-text-weaker">{language.t("context.breakdown.note")}</div>
          </div>
        </Show>

        <Show when={systemPrompt()}>
          {(prompt) => (
            <div class="flex flex-col gap-2">
              <div class="text-12-regular text-text-weak">{language.t("context.systemPrompt.title")}</div>
              <div class="border border-border-base rounded-md bg-surface-base px-3 py-2">
                <Markdown text={prompt()} class="text-12-regular" />
              </div>
            </div>
          )}
        </Show>

        <div class="flex flex-col gap-2">
          <div class="text-12-regular text-text-weak">{language.t("context.rawMessages.title")}</div>
          <Accordion multiple>
            <For each={messages()}>
              {(message) => (
                <RawMessage message={message} getParts={getParts} onRendered={restoreScroll} time={formatter().time} />
              )}
            </For>
          </Accordion>
        </div>
      </div>
    </ScrollView>
  )
}
