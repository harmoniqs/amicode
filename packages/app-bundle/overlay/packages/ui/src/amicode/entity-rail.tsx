import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup } from "solid-js"
import { hasUserReplyAfter } from "./ask"
import { registerAmicodeAskBridge } from "./ask-bridge"
import { registerAmicodeApprovalBridge } from "./approval-bridge"
import { railWarrantChip, type ApprovalRequest, type Warrant } from "./approval"
import { Icon } from "../components/icon"
import { registerAmicodeUiBridge, type AmicodeWidgetHost } from "./ui-bridge"
import {
  type ProblemView,
  type RunStatusView,
  mergeChips,
  parseProblemResponse,
  parseRunStatusResponse,
  railState,
} from "./problem"

// AMICODE problem-header rail (spec B). One compact sticky row per session
// view, bound to the ACTIVE problem workspace via GET /amicode/problem —
// AMICO · <name> ▾ │ <entity chips> │ <pending chips> │ <live run chip>.
// Session gate: renders only when the session contains ≥ 1 amicode_* tool
// part (fresh + non-amicode sessions stay stock; the active pointer is global
// but the rail is session-scoped — no empty chrome). The app supplies
// transport (fetchProblem/fetchRunStatus, per-active-server auth) + ring-2
// actions; this component owns parsing, refetch triggers, run polling, and
// failure states. It also hosts the ask bridge (existing) and the ui bridge
// (receipt clicks → entity view). Refetch triggers, scoped per spec: the
// completed-part counter below; "section open" has no analog for an
// always-visible rail (dialogs fetch on open, app side); server switch is
// handled per-call because fetchProblem resolves the active connection on
// every invocation.

// The session gate + refetch key now live in rail-gate.ts (pure, tested): the
// gate also recognises a SHELL-driven amicode session, which used to show no
// chips at all despite having real entities to describe.
export { countAmicodeParts, sessionHasAmicodeParts } from "./rail-gate"
import { countAmicodeParts as countParts, type GatePartLike } from "./rail-gate"

type RailPart = GatePartLike

const RUN_POLL_MS = 2500

// Pending chips are placeholders, not buttons — say WHY they aren't clickable
// (Kate 2026-07-27: an unexplained dead chip reads as a bug).
function pendingHint(kind: string): string {
  switch (kind) {
    case "pulse":
      return "No pulse banked yet — a completed run produces one"
    case "device_session":
      return "No device session yet — appears when a pulse targets hardware"
    case "run":
      return "No run yet — solve the formulation to create one"
    case "formulation":
      return "No formulation yet — amico writes one from the problem"
    case "system":
      return "No system picked yet"
    default:
      return "Not created yet"
  }
}

// One line-icon per entity kind (glyphs live in the shared family — icon.tsx).
function chipIcon(kind: string) {
  switch (kind) {
    case "system":
      return "target"
    case "formulation":
      return "sliders"
    case "run":
      return "archive"
    case "pulse":
      return "activity"
    case "device_session":
      return "status"
    default:
      return "dot-grid"
  }
}

export function AmicodeEntityRail(props: {
  messages: readonly { id: string; role?: string }[]
  partsFor: (messageID: string) => readonly RailPart[] | undefined
  fetchProblem: () => Promise<unknown>
  fetchRunStatus: () => Promise<unknown>
  fetchRunSeries?: (run: string, lab?: string) => Promise<unknown>
  // Stage 2: transport for the in-chat widget preview (frame src + host
  // callbacks + pin). Optional so hosts that can't render widgets omit it.
  widgetHost?: AmicodeWidgetHost
  onOpenEntity: (kind: string, seq?: number) => void
  onAsk?: (text: string) => void
  // Warrant transport (spec-20260727-164748 §9.5). DELIBERATELY NOT onAsk: routing an
  // approval through the chat would leave the ledger's only provenance reading "the
  // agent says the user approved". The app wires these to GET /amicode/warrants and
  // POST /amicode/approve; omitting them leaves the approval card non-actionable,
  // which is the correct read-only-surface behaviour.
  warrants?: () => readonly Warrant[]
  onApprove?: (request: ApprovalRequest) => void
  // Bridge-agnostic: fired when the user clicks the pulse chip (the rail's one
  // inspector entry). The app wires it to the host (postAmicode →
  // amicode.openInspector) and passes it only when framed in Amicode, so the
  // chip falls back to dialog/inert behavior everywhere else.
  onInspectRun?: () => void
  retryLabel: string
  unavailableLabel: string
  // Inline entity views: the composer draft target for the ✎ affordance and the
  // edit label — the rail forwards both to the ui bridge for the in-chat view.
  onDraftPrompt?: (text: string) => void
  editLabel?: string
  // When true, the rail is completely hidden. Used to prevent the rail from
  // showing in unrelated chat sessions (issue #272).
  disabled?: boolean
}) {
  if (props.onAsk) {
    const dispose = registerAmicodeAskBridge({
      send: (text) => props.onAsk?.(text),
      hasUserReplyAfter: (messageID) => hasUserReplyAfter(props.messages, messageID),
    })
    onCleanup(dispose)
  }
  // Registered only when BOTH halves are present: a card that could approve but not
  // read back its own warrant would show "pending" forever after a successful press.
  if (props.onApprove && props.warrants) {
    const disposeApproval = registerAmicodeApprovalBridge({
      approve: (request) => props.onApprove?.(request),
      warrants: () => props.warrants?.() ?? [],
    })
    onCleanup(disposeApproval)
  }
  // The ui bridge (openEntity + the in-transcript entity-view transport) is
  // registered below, once the live problem view, run statuses, and refetch it
  // exposes are all in scope.

  // Session gate + refetch key: completed amicode parts bump the counter → refetch.
  const amicodeParts = createMemo(() => countParts(props.messages, props.partsFor))

  const [problemRaw, { refetch }] = createResource(
    () => (amicodeParts().any > 0 ? amicodeParts().completed + 1 : undefined),
    () => props.fetchProblem(),
  )
  const [lastGood, setLastGood] = createSignal<ProblemView | undefined>(undefined)
  const current = createMemo<ProblemView | undefined>(() => {
    if (problemRaw.error)
      return { ok: false, entities: {}, scoreStages: [], events: [], runs: [], error: "fetch failed" }
    const raw = problemRaw.latest
    if (raw === undefined) return undefined
    return parseProblemResponse(raw)
  })
  createEffect(() => {
    const view = current()
    if (view?.ok) setLastGood(view)
  })
  const state = createMemo(() => railState(current(), lastGood()))

  // Run chip live state: poll run-status while any referenced run is unfinished.
  // Feeds ONLY the run chip — never other chips, never a problem refetch.
  const [runStatuses, setRunStatuses] = createSignal<RunStatusView[]>([])
  let timer: ReturnType<typeof setInterval> | undefined
  const stopPolling = () => {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
  }
  createEffect(() => {
    const snapshot = state()
    const hasRuns = snapshot.kind === "ready" && snapshot.view.runs.length > 0
    const unfinished =
      hasRuns && !runStatuses().length ? true : runStatuses().some((status) => status.status === "solving")
    if (hasRuns && unfinished && timer === undefined) {
      timer = setInterval(async () => {
        const statuses = parseRunStatusResponse(await props.fetchRunStatus().catch(() => undefined))
        setRunStatuses(statuses)
        if (statuses.length > 0 && statuses.every((status) => status.status !== "solving")) stopPolling()
      }, RUN_POLL_MS)
    }
    if (!hasRuns) stopPolling()
  })
  onCleanup(stopPolling)

  // Register the ui bridge now that current()/runStatuses()/refetch exist. The
  // rail chips still open the current-version modal via openEntity; the added
  // transport lets the in-transcript receipt cards render the full entity view
  // inline (Kate 2026-07-24) without a second fetch path.
  const disposeUiBridge = registerAmicodeUiBridge({
    openEntity: (kind, seq) => props.onOpenEntity(kind, seq),
    fetchRunSeries: props.fetchRunSeries,
    widgetHost: props.widgetHost,
    problemView: () => current(),
    runStatus: () => runStatuses(),
    draftPrompt: props.onDraftPrompt,
    refetchProblem: () => void refetch(),
    retryLabel: props.retryLabel,
    editLabel: props.editLabel,
  })
  onCleanup(disposeUiBridge)

  // Recomputed on any warrant change; no ticker, so an expiry crossing resolves on
  // the next refetch rather than needing a timer per rail.
  const warrantChip = createMemo(() => railWarrantChip(props.warrants?.() ?? [], Date.now()))
  // Whether there is a run to inspect — gates the "Inspect Run" button so it
  // appears alongside the live run chip, not before any solve has started.
  const hasRun = createMemo(() => {
    const snapshot = state()
    return snapshot.kind === "ready" && snapshot.view.runs.length > 0
  })
  const chips = createMemo(() => {
    const snapshot = state()
    if (snapshot.kind !== "ready") return []
    return mergeChips(snapshot.view.entities, snapshot.view.scoreStages)
  })
  // Which chips hand off to the Pulse Inspector instead of the entity dialog.
  // Only the pulse chip, and only when the host actually wired an inspector —
  // standalone opencode has none, so there the chip keeps its dialog behavior.
  // The pulse chip is the ONLY inspector entry on the rail — the separate
  // "Inspect Run" button was redundant chrome next to it (Kate 2026-07-28).
  const opensInspector = (kind: string) => kind === "pulse" && props.onInspectRun !== undefined

  // Don't render if disabled (issue #272: prevents rail in unrelated sessions)
  if (props.disabled) return null

  return (
    <Show when={amicodeParts().any > 0}>
      <div data-component="amicode-entity-rail">
        <Show
          when={state().kind !== "unavailable"}
          fallback={
            <div class="amc-rail-chips">
              <span style={{ color: "var(--v2-text-text-muted)" }}>{props.unavailableLabel}</span>
              <button
                type="button"
                data-slot="amicode-rail-retry"
                style={{
                  color: "var(--v2-text-text-base)",
                  "text-decoration": "underline",
                  background: "none",
                  border: "none",
                  padding: "0",
                  font: "inherit",
                  cursor: "pointer",
                }}
                onClick={() => void refetch()}
              >
                {props.retryLabel}
              </button>
            </div>
          }
        >
          {/* Static entity chips (Kate 2026-07-24): label ONLY — no value, no
              chevron / + icon. A recorded (clickable) chip carries the soft-yellow
              fill as its affordance and opens its current version; a not-yet-
              recorded chip is inert with a dotted border. The problem name sits in
              the bottom-right corner as a thin, low-contrast watermark. */}
          <div class="amc-rail-chips">
            <For each={chips()}>
              {(chip) => (
                <Show
                  // The pulse chip is the one exception to "pending chips are
                  // inert": it opens the Pulse Inspector, which is exactly where a
                  // not-yet-banked pulse will appear, so the click is useful
                  // BEFORE the pulse exists. It keeps the dotted not-recorded
                  // look — the chip still tells the truth about state — and its
                  // tooltip says both things. Everything else stays a placeholder.
                  when={!chip.pending || opensInspector(chip.kind)}
                  fallback={
                    <span
                      class="amc-rail-chip is-empty"
                      data-slot="amicode-rail-chip"
                      data-stage={chip.kind}
                      data-pending="true"
                      title={pendingHint(chip.kind)}
                      aria-label={`${chip.label} — ${pendingHint(chip.kind)}`}
                    >
                      <Icon name={chipIcon(chip.kind)} size="small" />
                      {chip.label}
                    </span>
                  }
                >
                  <button
                    type="button"
                    class={chip.pending ? "amc-rail-chip is-empty" : "amc-rail-chip"}
                    data-slot="amicode-rail-chip"
                    data-stage={chip.kind}
                    data-pending={chip.pending ? "true" : undefined}
                    title={chip.pending ? `${pendingHint(chip.kind)} — opens the Pulse Inspector` : undefined}
                    aria-label={
                      // The pulse chip's subject IS a run's pulse, so it opens the
                      // Pulse Inspector — where the pulse is actually plotted — rather
                      // than the entity dialog. Saves a hop to the thing users click
                      // it to see. Falls back to the entity dialog if the host didn't
                      // wire an inspector (standalone opencode).
                      opensInspector(chip.kind)
                        ? `Open the Pulse Inspector for ${chip.label}`
                        : `Open current ${chip.label}`
                    }
                    onClick={() =>
                      opensInspector(chip.kind) ? props.onInspectRun?.() : props.onOpenEntity(chip.kind)
                    }
                  >
                    <Icon name={chipIcon(chip.kind)} size="small" />
                    {chip.label}
                    {/* At-rest chevron on the pending-but-clickable chip: the dotted
                        border alone reads "inert" (that's what it means on every
                        other pending chip), so the shape — not hover — carries the
                        "this goes somewhere" signal (Kate 2026-07-28). */}
                    <Show when={chip.pending}>
                      <span class="amc-chev" aria-hidden="true">
                        ›
                      </span>
                    </Show>
                  </button>
                </Show>
              )}
            </For>
            {/* Warrant status (spec §9.6 / G-6): the ACTIVE warrant's consumption, so a
                researcher mid-campaign sees remaining authorization without opening
                anything. Inert by design — it reports a ledger fact, and whether the
                next launch passes is the gate's verdict, not this chip's. Absent when
                there is no live warrant or it declares no bounds, so it never implies
                an authorization the gate would refuse. */}
            <Show when={warrantChip()}>
              {(text) => (
                <span
                  class="amc-rail-chip is-empty"
                  data-slot="amicode-rail-warrant"
                  title={`Active capability warrant — ${text()}`}
                >
                  <Icon name="archive" size="small" />
                  {text()}
                </span>
              )}
            </Show>
            <Show when={props.onInspectRun && hasRun()}>
              <button
                type="button"
                data-slot="amicode-rail-inspect"
                style={{
                  display: "inline-flex",
                  "align-items": "center",
                  "flex-shrink": "0",
                  gap: "4px",
                  border: "1px solid var(--v2-border-border-base)",
                  "border-radius": "var(--radius-md)",
                  background: "none",
                  color: "var(--v2-text-text-accent)",
                  padding: "2px 8px",
                  font: "inherit",
                  "font-weight": "600",
                  cursor: "pointer",
                }}
                title="Open the Pulse Inspector panel"
                onClick={() => props.onInspectRun?.()}
              >
                Inspect Run
              </button>
            </Show>
          </div>
        </Show>
      </div>
    </Show>
  )
}
