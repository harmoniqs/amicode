import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import {
  DragDropProvider,
  DragDropSensors,
  SortableProvider,
  closestCenter,
  createSortable,
} from "@thisbeyond/solid-dnd"
import type { DragEvent as DndDragEvent } from "@thisbeyond/solid-dnd"
import { WidgetFrame, type WidgetHostCallbacks } from "./widget-frame"
import { WidgetConfigForm } from "./widget-config-form"
import { formModel, type DashboardEntry, type DashboardState, type WidgetInfo } from "./widget-schema"
import type { Density } from "./widget-tokens"

// AMICODE (widget kernel): the dashboard — replaces the hardcoded
// AmicodeHomeCards strip. Renders the state's visible entries as sandboxed
// WidgetFrames: hero widgets in the top auto-fit grid, tiles in the auto-fit
// row below. Each card's ⋯ menu carries its actions (Move, ⚙ Configure,
// × Remove, ＋ Add widget — opens the TRAY, the one place every available
// widget collects: hidden entries restore, never-pinned registry widgets pin,
// "create new widget…" hands off to the chat);
// "Move" flips MOVE MODE (Kate 2026-07-15:
// no control pill, no name overlay — just a light scrim + dashed ring and the
// cards become draggable). Drag is solid-dnd sortables, move mode only — the
// scrims make the whole grid surface host-owned, so no iframe can eat a
// pointermove; arrow keys on a focused card are the invisible keyboard path.
// Hover reorders a local key order and the save lands ONCE on drop, because
// every save (props.onSave → app POST, merged echo fed back) remounts each
// widget iframe. Move and Add are SEPARATE modes (Kate): Move never shows the
// tray, Add never makes cards draggable; a per-mode banner orients + Done exits.

type Bucket = "hero" | "tile"

export function WidgetGrid(props: {
  widgets: WidgetInfo[]
  dashboard: DashboardState
  frameSrcs: Record<string, string> // widget id → /amicode/widget-frame URL
  tokens: Record<string, string>
  density: Density
  context: Record<string, unknown>
  callbacks: WidgetHostCallbacks
  onSave: (state: DashboardState) => void
  /** hands off to the chat with a prefilled "create a widget" prompt —
   *  authoring is a conversation (amicode_author_widget), not a form */
  onNewWidget?: () => void
}) {
  // Grid mode (Kate 2026-07-15: SEPARATE surfaces) — "move" is drag-only
  // (scrim + ring + sortables, no tray); "add" is the tray only (cards stay
  // live and un-draggable). Done exits either.
  const [mode, setMode] = createSignal<"move" | "add" | undefined>(undefined)
  const moving = () => mode() === "move"
  const busyMode = () => mode() !== undefined
  const [configOpen, setConfigOpen] = createSignal<string | undefined>(undefined)
  const [empties, setEmpties] = createSignal<Record<string, boolean>>({})
  // per-card ⋯ menu (customize rethink, Kate 2026-07-15): at most one open,
  // keyed by entry. Editing is initiated FROM a card, not a standing button.
  const [menuOpen, setMenuOpen] = createSignal<string | undefined>(undefined)

  const infoFor = (id: string) => props.widgets.find((w) => w.id === id)
  const bucketOf = (id: string): Bucket => (infoFor(id)?.size === "hero" ? "hero" : "tile")
  const visible = createMemo(() => props.dashboard.widget.filter((e) => !e.hidden))
  const hidden = createMemo(() => props.dashboard.widget.filter((e) => e.hidden))
  const heroes = createMemo(() => visible().filter((e) => bucketOf(e.id) === "hero"))
  const tiles = createMemo(() => visible().filter((e) => bucketOf(e.id) === "tile"))

  const save = (mutate: (entries: DashboardEntry[]) => DashboardEntry[]) => {
    // spread first: reserved top-level keys (views, scope — spec T3.6) survive
    props.onSave({ ...props.dashboard, version: 1, widget: mutate(props.dashboard.widget.map((e) => ({ ...e }))) })
  }
  const setHidden = (key: string, value: boolean) =>
    save((entries) => entries.map((e) => (e.key === key ? { ...e, hidden: value } : e)))
  /** Pin a registry widget that has no dashboard entry yet — the same shape the
   *  chat's "Pin to dashboard" appends (key = id; the server normalizes). */
  const pinWidget = (id: string) => save((entries) => [...entries, { key: id, id, hidden: false, config: {} }])
  /** Registry widgets with no dashboard entry at all (chat-authored, unpinned). */
  const unpinned = createMemo(() => props.widgets.filter((w) => !props.dashboard.widget.some((e) => e.id === w.id)))
  /** Tray candidates among hidden entries: never offer a widget that is already
   *  visible on the board (stale hidden duplicates can exist — the pin flows
   *  append key=id while the server mints hashed keys), and offer each id once. */
  const trayHidden = createMemo(() => {
    const onBoard = new Set(visible().map((e) => e.id))
    const seen = new Set<string>()
    return hidden().filter((e) => {
      if (onBoard.has(e.id) || seen.has(e.id)) return false
      seen.add(e.id)
      return true
    })
  })
  const setConfig = (key: string, field: string, value: unknown) =>
    save((entries) => entries.map((e) => (e.key === key ? { ...e, config: { ...e.config, [field]: value } } : e)))
  const move = (key: string, dir: -1 | 1) =>
    save((entries) => {
      const target = entries.find((x) => x.key === key)
      if (!target) return entries
      const group = entries.filter((e) => !e.hidden && bucketOf(e.id) === bucketOf(target.id))
      const gi = group.findIndex((e) => e.key === key)
      const swapWith = group[gi + dir]
      if (gi < 0 || !swapWith) return entries
      const i = entries.findIndex((e) => e.key === key)
      const j = entries.findIndex((e) => e.key === swapWith.key)
      const next = [...entries]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })

  // ---- drag reorder (move mode) -------------------------------------------
  // The move-mode scrim makes the whole grid surface host-owned (no iframe can
  // eat a pointermove), so drag is safe here. CRITICAL: the rendered list must
  // NOT reorder mid-drag — solid-dnd previews the shuffle purely with
  // transforms (the active card rides the pointer, neighbors slide), and a DOM
  // reorder mid-drag moves the active card's transform origin, detaching it
  // from the pointer. The array commit (one save — each save is a POST that
  // remounts every widget iframe) happens ONCE, at drop.

  /** Persist one bucket's new visible order in a single save: the bucket's
   *  existing flat-array slots are refilled in `keys` order; hidden and
   *  other-bucket entries keep their exact positions. */
  const applyBucketOrder = (bucket: Bucket, keys: string[]) =>
    save((entries) => {
      const slots: number[] = []
      entries.forEach((e, i) => {
        if (!e.hidden && bucketOf(e.id) === bucket) slots.push(i)
      })
      const byKey = new Map(entries.map((e) => [e.key, e]))
      const ordered = keys.map((k) => byKey.get(k))
      if (slots.length !== keys.length || ordered.some((e) => !e)) return entries // drifted mid-drag — bail
      const next = [...entries]
      slots.forEach((slot, idx) => {
        next[slot] = ordered[idx]!
      })
      return next
    })

  const onDragEnd = ({ draggable, droppable }: DndDragEvent) => {
    if (!draggable || !droppable) return
    const key = String(draggable.id)
    const over = String(droppable.id)
    if (key === over) return
    const target = props.dashboard.widget.find((e) => e.key === key)
    if (!target) return
    const bucket = bucketOf(target.id)
    const keys = (bucket === "hero" ? heroes() : tiles()).map((e) => e.key)
    const from = keys.indexOf(key)
    const to = keys.indexOf(over)
    if (from < 0 || to < 0 || from === to) return // cross-bucket drop lands here (to === -1) and is a no-op
    keys.splice(to, 0, ...keys.splice(from, 1))
    applyBucketOrder(bucket, keys)
  }
  const PillButton = (p: { label: string; title: string; onClick: () => void; disabled?: boolean; class?: string }) => (
    <button type="button" title={p.title} disabled={p.disabled} class={p.class} onClick={p.onClick}>
      {p.label}
    </button>
  )

  // Move mode carries NO per-card controls (Kate 2026-07-15: no pill, no name
  // overlay — just scrim + ring + drag). Configure/remove/fork live in the
  // ⋯ menu; arrow keys on a focused card remain the invisible keyboard path.

  // The card's own ⋯ menu — direct actions on the card in hand, plus the two
  // grid-level entries (add / arrange) that open the full edit mode. Reuses the
  // exact operations the edit-mode ControlPill calls.
  const CardMenu = (p: { entry: DashboardEntry; w: WidgetInfo }) => {
    let root: HTMLDivElement | undefined
    const open = () => menuOpen() === p.entry.key
    const hasConfig = createMemo(() => Object.keys(p.w.config).length > 0)
    const onDocPointer = (e: PointerEvent) => {
      if (root && !root.contains(e.target as Node)) setMenuOpen(undefined)
    }
    const onDocKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(undefined)
    }
    createEffect(() => {
      if (!open()) return
      document.addEventListener("pointerdown", onDocPointer, true)
      document.addEventListener("keydown", onDocKey, true)
      onCleanup(() => {
        document.removeEventListener("pointerdown", onDocPointer, true)
        document.removeEventListener("keydown", onDocKey, true)
      })
    })
    const close = () => setMenuOpen(undefined)
    return (
      <div ref={root} class="amc-wg-menuroot">
        <button
          type="button"
          class="amc-wg-more"
          title={`${p.w.name} — options`}
          aria-haspopup="menu"
          aria-expanded={open()}
          onClick={() => setMenuOpen(open() ? undefined : p.entry.key)}
        >
          ⋯
        </button>
        <Show when={open()}>
          <div class="amc-wg-menu" role="menu" aria-label={`${p.w.name} options`}>
            <button
              type="button"
              role="menuitem"
              title="Cards become draggable — drop where you want them, then Done"
              onClick={() => {
                setMode("move")
                close()
              }}
            >
              ⠿ Move
            </button>
            <Show when={hasConfig()}>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMode("move")
                  setConfigOpen(p.entry.key)
                  close()
                }}
              >
                ⚙ Configure
              </button>
            </Show>
            <button
              type="button"
              role="menuitem"
              class="amc-wg-danger"
              title="Hides the widget — bring it back via Add widget"
              onClick={() => {
                setHidden(p.entry.key, true)
                close()
              }}
            >
              × Remove
            </button>
            <div class="amc-wg-menusep" role="separator" />
            <button
              type="button"
              role="menuitem"
              title="Opens the widget tray — every available widget collects there"
              onClick={() => {
                setMode("add")
                close()
              }}
            >
              ＋ Add widget
            </button>
          </div>
        </Show>
      </div>
    )
  }

  // Edit-mode wrapper: the whole scrimmed card is the drag handle (pointer
  // events bubble from the scrim); the pill's buttons stay clickable above it —
  // the sensor's activation threshold disambiguates click from drag (same
  // proof as the close buttons inside sortable session tabs).
  const SortableCell = (p: { entry: DashboardEntry }) => {
    const sortable = createSortable(p.entry.key)
    return (
      <div
        use:sortable
        class="amc-wg-sortable"
        classList={{ "amc-wg-active": sortable.isActiveDraggable }}
        data-span={bucketOf(p.entry.id)}
        aria-roledescription="sortable widget"
        tabIndex={0}
        onKeyDown={(e: KeyboardEvent) => {
          // invisible keyboard path (no visible ↑↓ controls in move mode)
          const dir =
            e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : 0
          if (dir === 0) return
          e.preventDefault()
          move(p.entry.key, dir)
        }}
      >
        <Cell entry={p.entry} />
      </div>
    )
  }

  const Cell = (p: { entry: DashboardEntry }) => {
    const info = createMemo(() => infoFor(p.entry.id))
    const empty = createMemo(() => empties()[p.entry.key] === true)
    // a cell shows a labeled placeholder (rather than the frame) when it has
    // nothing to render but must stay reachable in edit mode
    const asPlaceholder = createMemo(() => moving() && (!info() || empty()))

    // when NOT editing, a cell with nothing to render (missing widget or an
    // empty-state) collapses out of the grid entirely — otherwise it would
    // hold an empty column track. The frame (when present) stays MOUNTED under
    // display:none so its amc:empty signal keeps flowing and the cell can
    // re-appear if the widget later has content (hidden frames have no layout,
    // so emptiness is never inferred from height — it's an explicit signal).
    const collapsed = createMemo(() => !moving() && (!info() || empty()))

    return (
      <div
        data-component="amicode-widget-cell"
        data-widget={p.entry.id}
        data-span={bucketOf(p.entry.id)}
        data-editing={moving() ? "true" : "false"}
        style={{ display: collapsed() ? "none" : undefined }}
      >
        <Show
          when={info()}
          fallback={
            // unknown id (not-yet-synced user widget): reachable only in move mode
            <Show when={moving()}>
              <div class="amc-wg-placeholder">
                <span style={{ flex: "1" }}>{p.entry.id} — not installed</span>
                <div class="amc-wg-pill" style={{ position: "static", "box-shadow": "none" }}>
                  <PillButton
                    label="×"
                    class="amc-wg-danger"
                    title="Remove from dashboard"
                    onClick={() => setHidden(p.entry.key, true)}
                  />
                </div>
              </div>
            </Show>
          }
        >
          {(w) => (
            <>
              <Show when={asPlaceholder()}>
                <div class="amc-wg-framewrap">
                  <div class="amc-wg-placeholder">
                    <span style={{ flex: "1" }}>
                      {w().name} <span class="amc-wg-empty">· nothing to show right now</span>
                    </span>
                    <div class="amc-wg-pill" style={{ position: "static", "box-shadow": "none" }}>
                      <PillButton
                        label="×"
                        class="amc-wg-danger"
                        title="Remove from dashboard"
                        onClick={() => setHidden(p.entry.key, true)}
                      />
                    </div>
                  </div>
                </div>
              </Show>

              <Show when={!asPlaceholder()}>
                <div class="amc-wg-framewrap">
                  <WidgetFrame
                    widget={w()}
                    frameSrc={props.frameSrcs[w().id]}
                    config={p.entry.config}
                    context={props.context}
                    tokens={props.tokens}
                    density={props.density}
                    callbacks={props.callbacks}
                    fill
                    onEmpty={(e) => setEmpties((prev) => ({ ...prev, [p.entry.key]: e }))}
                  />
                  <Show when={moving()}>
                    <div class="amc-wg-scrim" />
                  </Show>
                  <Show when={!busyMode()}>
                    <CardMenu entry={p.entry} w={w()} />
                  </Show>
                </div>
              </Show>

              <Show when={moving() && configOpen() === p.entry.key}>
                <div style={{ "margin-top": "6px" }}>
                  <WidgetConfigForm
                    fields={formModel(w().config, p.entry.config)}
                    onChange={(field, value) => setConfig(p.entry.key, field, value)}
                  />
                </div>
              </Show>
            </>
          )}
        </Show>
      </div>
    )
  }

  // A tray candidate previewed as it will appear on the board — the real
  // sandboxed frame with the board's tokens, plus context.preview = true so
  // data-driven widgets render sample content instead of their empty state.
  // The overlay button is the whole card's click target; nothing inside the
  // preview is interactive. A widget that still reports empty gets a labeled
  // placeholder so the card is never a blank void.
  const TrayCard = (p: {
    w: WidgetInfo | undefined
    name: string
    config: Record<string, unknown>
    onAdd: () => void
  }) => {
    const [empty, setEmpty] = createSignal(false)
    return (
      <div class="amc-wg-traycard" data-span={p.w?.size === "hero" ? "hero" : "tile"}>
        <div class="amc-wg-framewrap">
          <Show when={p.w} fallback={<div class="amc-wg-placeholder">{p.name}</div>}>
            {(w) => (
              <>
                <Show when={empty()}>
                  <div class="amc-wg-placeholder">
                    {p.name} <span class="amc-wg-empty">· no preview — shows once it has data</span>
                  </div>
                </Show>
                <WidgetFrame
                  widget={w()}
                  frameSrc={props.frameSrcs[w().id]}
                  config={p.config}
                  context={{ ...props.context, preview: true }}
                  tokens={props.tokens}
                  density={props.density}
                  callbacks={props.callbacks}
                  fill
                  onEmpty={setEmpty}
                />
              </>
            )}
          </Show>
          <button type="button" class="amc-wg-trayadd" title={`Add ${p.name} to the board`} onClick={() => p.onAdd()}>
            <span>+ {p.name}</span>
          </button>
        </div>
      </div>
    )
  }

  return (
    <div data-component="amicode-widget-grid" style={{ display: "flex", "flex-direction": "column", gap: "12px" }}>
      {/* No standing customize button (rethink, Kate 2026-07-15): editing is
          initiated from any card's ⋯ menu; the edit bar's Done closes it. */}

      <Show when={busyMode()}>
        <div data-component="amicode-widget-editbar">
          <Show
            when={moving()}
            fallback={
              <span>
                <b>Add a widget</b> — pick one from the tray below; removed widgets collect there too.
              </span>
            }
          >
            <span>
              <b>Moving widgets</b> — drag cards where you want them (arrow keys work too). Changes save as you go.
            </span>
          </Show>
          <button
            type="button"
            class="amc-wg-editdone"
            onClick={() => {
              setMode(undefined)
              setConfigOpen(undefined)
            }}
          >
            Done
          </button>
        </div>
      </Show>

      <DragDropProvider onDragEnd={onDragEnd} collisionDetector={closestCenter}>
        <Show when={moving()}>
          <DragDropSensors />
        </Show>

        {/* ONE geometric grid (Kate 2026-07-15): everything occupies fixed
            unit blocks — tiles 1×1, heroes 2×2 — so columns and rows align
            across the whole board. auto-fill (not auto-fit) keeps the unit
            width stable however few widgets exist; heroes render first so
            row-major auto-placement packs without holes. The ghost tile at
            the end is the standing entry point to the tray — it also covers
            the every-widget-hidden case (no cards → no ⋯ menus). The ghost
            yields while EITHER mode is up: move keeps the drag surface clean,
            add gives the tray's library the room (exit via Done). */}
        <Show when={visible().length > 0 || !busyMode()}>
          <div class="amc-wg-grid">
            <Show
              when={moving()}
              fallback={<For each={[...heroes(), ...tiles()]}>{(entry) => <Cell entry={entry} />}</For>}
            >
              <SortableProvider ids={heroes().map((e) => e.key)}>
                <For each={heroes()}>{(entry) => <SortableCell entry={entry} />}</For>
              </SortableProvider>
              <SortableProvider ids={tiles().map((e) => e.key)}>
                <For each={tiles()}>{(entry) => <SortableCell entry={entry} />}</For>
              </SortableProvider>
            </Show>
            <Show when={!busyMode()}>
              <button
                type="button"
                class="amc-wg-ghost"
                title="Opens the widget tray — pick from the library or create a new one"
                onClick={() => setMode("add")}
              >
                <span class="amc-wg-ghostplus" aria-hidden="true">
                  +
                </span>
                <span class="amc-wg-ghostlabel">add widget</span>
              </button>
            </Show>
          </div>
        </Show>
      </DragDropProvider>

      {/* the widget tray — the ONE place every available widget collects
          (⋯ → Add widget lands here): hidden entries restore, never-pinned
          registry widgets pin, and create hands off to the chat. Candidates
          render as live PREVIEWS (Kate 2026-07-15: the widget as it will look
          once added, not just a name) — same frame/tokens as the board, with a
          transparent overlay button as the single click target (the scrim
          trick again: iframes eat clicks). Create-new is a ghost-styled card
          in the same grid. */}
      <Show when={mode() === "add"}>
        <div
          data-component="amicode-widget-tray"
          style={{
            padding: "8px 10px",
            border: "1px dashed var(--v2-border-border-base)",
            "border-radius": "var(--radius-md)",
          }}
        >
          <span class="amc-wg-traylabel">add a widget</span>
          <div class="amc-wg-traygrid">
            <For each={trayHidden()}>
              {(entry) => (
                <TrayCard
                  w={infoFor(entry.id)}
                  name={infoFor(entry.id)?.name ?? entry.id}
                  config={entry.config}
                  onAdd={() => setHidden(entry.key, false)}
                />
              )}
            </For>
            <For each={unpinned()}>{(w) => <TrayCard w={w} name={w.name} config={{}} onAdd={() => pinWidget(w.id)} />}</For>
            <Show when={props.onNewWidget}>
              <button
                type="button"
                class="amc-wg-ghost amc-wg-traycreate"
                title="Opens the chat with a prefilled prompt — describe the widget and amico builds it"
                onClick={() => props.onNewWidget?.()}
              >
                <span class="amc-wg-ghostplus" aria-hidden="true">
                  +
                </span>
                <span class="amc-wg-ghostlabel">create new widget…</span>
              </button>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  )
}
