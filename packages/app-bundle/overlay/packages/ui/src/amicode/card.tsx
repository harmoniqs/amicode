import { For, Match, Show, Switch, createMemo } from "solid-js"
import { openFileInEditor } from "./bridge"
import { amicodeStage } from "./stage"
import { parseAskInput } from "./ask"
import { AmicodeAskCard } from "./ask-card"
import { parseApprovalInput } from "./approval"
import { AmicodeApprovalCard } from "./approval-card"
import { parseDiffSentinel, receiptParts, INLINE_KINDS } from "./receipt"
import { receiptIsCurrent } from "./receipt-currency"
import { systemReceiptPieces, formulationReceiptPieces } from "./facets"
import { compositeChip, chipText } from "./problem"
import { AmicoMark } from "./spinner"
import {
  openAmicodeEntity,
  amicodeProblemView,
  amicodeRunStatus,
  amicodeDraftPrompt,
  amicodeRefetchProblem,
  amicodeEntityLabels,
} from "./ui-bridge"
import { AmicodeEntityView } from "./entity-view"
import { RunWindow } from "./run-window"
import { parseWidgetSentinel } from "./widget-preview"
import { WidgetPreviewCard } from "./widget-preview-card"

// spec C: when an amicode_solve recorded a run_dir, its sentinel carries the
// path (well under the 120-char truncation cap) — extract lab/run_id from the
// last two segments so the part renders a live run window instead of a chip.
function runRefFromOutput(output: unknown): { run: string; lab?: string } | undefined {
  const sentinel = parseDiffSentinel(output)
  if (!sentinel || sentinel.entity !== "run") return undefined
  for (const [key, entry] of Object.entries(sentinel.diff)) {
    if (!/run_dir$/.test(key)) continue
    const value = entry.to
    if (typeof value !== "string" || value.trim() === "" || value.endsWith("…")) continue
    const parts = value.replace(/\/+$/, "").split("/")
    const run = parts[parts.length - 1]
    const lab = parts[parts.length - 2]
    if (run) return { run, lab }
  }
  return undefined
}

// AMICODE Layer-2 renderer slot: one-line DIFF RECEIPT for amicode_* tool-call
// parts (parsed from the AMICODE_DIFF sentinel — spec B), falling back to the
// legacy status chip when no sentinel parses (old sessions keep rendering);
// amicode_ask still renders the interactive question card. The raw tool return
// is agent-directed text and is deliberately NOT rendered — durable state
// lives in the problem rail (./entity-rail.tsx). Receipt click opens the
// entity view through the ui-bridge (no-op until the rail registers it).
//
// The card carries four states, differentiated in FORM, not just words: the
// H-mark is the spinner while working (running), settles under a green check
// when done with no diff, becomes a structured diff receipt when there is one,
// and turns its rail red on failure. It is a real <button> when it can open the
// entity (keyboard-reachable, focus ring) and a plain <div> otherwise. Styling
// lives in ./amicode.css; data-slot hooks are preserved for the e2e suite.

type DiffPiece = { key: string; from?: string; to?: string }

function Chip(props: { tool: string; status?: string; output?: string; count?: number }) {
  const stage = createMemo(() => amicodeStage(props.tool))
  const running = () => props.status === "pending" || props.status === "running"
  const errored = () => props.status === "error" || props.status === "failed"
  const parts = createMemo(() => {
    if (props.status !== "completed") return undefined
    const sentinel = parseDiffSentinel(props.output)
    return sentinel ? { sentinel, receipt: receiptParts(sentinel) } : undefined
  })
  // Clickable ONLY when an entity view exists for the kind. A receipt carrying a
  // sentinel for a kind entity-view.tsx has no case for (e.g. `recommend`, which
  // emits a sentinel purely so its chip names the param) would otherwise open an
  // empty dialog. Diff detail and openability are separate properties.
  const clickable = () => {
    const entity = parts()?.sentinel.entity
    return entity !== undefined && INLINE_KINDS.has(entity)
  }
  const diffPieces = createMemo<DiffPiece[]>(
    () =>
      parts()?.receipt.changes.map((change) =>
        change.kind === "elision"
          ? { key: "…" }
          : change.kind === "set"
            ? { key: change.key, to: change.to }
            : { key: change.key, from: change.from, to: change.to },
      ) ?? [],
  )
  // Hero entities (system, formulation): a semantic receipt (spec §5) instead of
  // JSON pieces — a post-state chip on creation/large/elided, else a delta.
  const heroReceipt = createMemo(() => {
    const p = parts()
    if (!p) return undefined
    if (p.sentinel.entity === "system") return systemReceiptPieces(p.sentinel.diff)
    if (p.sentinel.entity === "formulation") return formulationReceiptPieces(p.sentinel.diff)
    return undefined
  })
  const heroChip = createMemo(() => {
    const p = parts()
    const sr = heroReceipt()
    if (!p || sr?.kind !== "chip") return undefined
    return p.sentinel.entity === "system"
      ? (compositeChip(sr.entity) ?? "updated")
      : (chipText(p.sentinel.entity, sr.entity) ?? "updated")
  })
  const heroPieces = createMemo(() => {
    const sr = heroReceipt()
    return sr?.kind === "pieces" ? sr.pieces : undefined
  })
  const state = () =>
    errored() ? "error" : running() ? "running" : parts() ? "receipt" : props.status === "completed" ? "done" : "idle"
  const openLabel = () => `Open ${parts()?.receipt.label ?? stage()} details`
  const open = () => {
    const active = parts()
    if (active) openAmicodeEntity(active.sentinel.entity, active.sentinel.seq)
  }

  // Signature / body / trail are shared by the clickable (<button>) and inert
  // (<div>) shells. Split so the shell can be a real button only when there is
  // an entity to open — a bare <button> would inherit type="submit" and fire
  // the composer form; a plain onClick <div> would be invisible to the keyboard.
  // amicode: the "AMICO" wordmark is gone from cards — identity lives in the
  // entity rail now (spec-20260712-amico-third-actor). The H-mark stays as a
  // subtle leading glyph so a de-stamped card still reads as Amico's work.
  const Sig = () => (
    <span class="amc-sig">
      <AmicoMark running={running()} />
    </span>
  )
  const Body = () => (
    <Show
      when={parts()}
      fallback={
        <span class="amc-body">
          <span class="amc-label" data-slot="amicode-card-stage">
            {stage()}
          </span>
          <span class="amc-detail" data-slot="amicode-card-status">
            {running()
              ? "working…"
              : errored()
                ? "couldn’t complete"
                : props.status === "completed"
                  ? "updated"
                  : (props.status ?? "")}
          </span>
        </span>
      }
    >
      {(active) => (
        <span class="amc-body" data-slot="amicode-card-receipt">
          <span class="amc-label">{active().receipt.label}</span>
          <Show
            when={heroReceipt()}
            fallback={
              <For each={diffPieces()}>
                {(piece) => (
                  <span class="amc-diff">
                    <span class="k">{piece.key}</span>
                    <Show when={piece.from !== undefined}>
                      <span class="v from">{piece.from}</span>
                      <span class="arw" aria-hidden="true">
                        →
                      </span>
                    </Show>
                    <Show when={piece.to !== undefined}>
                      <span class="v">{piece.to}</span>
                    </Show>
                  </span>
                )}
              </For>
            }
          >
            <Show
              when={heroChip()}
              fallback={
                <For each={heroPieces()}>
                  {(p) => (
                    <span class="amc-diff" data-tone={p.tone}>
                      <span class="v">{p.text}</span>
                    </span>
                  )}
                </For>
              }
            >
              {(chip) => (
                <span class="amc-diff">
                  <span class="v">{chip()}</span>
                </span>
              )}
            </Show>
          </Show>
          {/* amicode: a run of N consecutive receipts sharing (problem, entity,
              action) collapses to this one card (../components/message-part.tsx,
              ../amicode/receipt-runs.ts) — shown only when N > 1 so a lone
              receipt renders exactly as it always has. */}
          <Show when={(props.count ?? 1) > 1}>
            <span class="amc-detail amc-count" data-slot="amicode-card-count">
              ×{props.count}
            </span>
          </Show>
        </span>
      )}
    </Show>
  )
  const Trail = () => (
    <span class="amc-trail">
      <Switch>
        <Match when={state() === "done"}>
          <svg class="amc-tick" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M3.5 8.5l3 3 6-6.5"
              stroke="currentColor"
              stroke-width="1.75"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </Match>
        <Match when={state() === "running"}>
          <span class="amc-livedot" aria-hidden="true" />
        </Match>
      </Switch>
      <Show when={clickable()}>
        <span class="amc-chev" aria-hidden="true">
          ›
        </span>
      </Show>
    </span>
  )

  return (
    <Show
      when={clickable()}
      fallback={
        <div data-component="amicode-card" data-tool={props.tool} data-state={state()} data-clickable="false">
          <Sig />
          <span class="amc-rule" aria-hidden="true" />
          <Body />
          <Trail />
        </div>
      }
    >
      <button
        type="button"
        data-component="amicode-card"
        data-tool={props.tool}
        data-state={state()}
        data-clickable="true"
        aria-label={openLabel()}
        onClick={open}
      >
        <Sig />
        <span class="amc-rule" aria-hidden="true" />
        <Body />
        <Trail />
      </button>
    </Show>
  )
}

// AMICODE: a skill activation, wearing the Amico chip. Amicode's skills ARE Amico's — its
// repertoire — so activating one is Amico acting, and it earns the same chip the domain
// receipts wear. Reads "<kind> <specific>" like every other chip: the label names the kind,
// the detail names the skill.
//
// Inert by default; when the mount site passes the skill's `path` (the skill tool result
// carries its base dir in metadata) the chip becomes a <button> that opens the SKILL.md in
// the editor via the amicode bridge — the skill IS a file, so its face links to it. The
// expandable instruction body stays with BasicTool at the mount site; this is only the
// trigger's face. Nesting it there is safe because BasicTool declares an `icon` prop and
// never renders it (verified — nothing in basic-tool.tsx reads props.icon), so the H-mark
// is the row's only glyph. The chip's click stops propagation so the tool body's own
// expand/collapse doesn't fire alongside the file open.
//
// A <span>/<button> shell rather than Chip's <div>: this sits inside a trigger's inline
// context, and [data-component="amicode-card"] is already display:inline-flex, so nothing
// is lost.
export function AmicoSkillChip(props: { kind: string; name?: string; status?: string; path?: string }) {
  const running = () => props.status === "pending" || props.status === "running"
  const errored = () => props.status === "error" || props.status === "failed"
  const state = () =>
    errored() ? "error" : running() ? "running" : props.status === "completed" ? "done" : "idle"

  const open = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (props.path) openFileInEditor(props.path)
  }

  const inner = (
    <>
      <span class="amc-sig">
        <AmicoMark running={running()} />
      </span>
      <span class="amc-rule" aria-hidden="true" />
      <span class="amc-body">
        <span class="amc-label" data-slot="amicode-skill-kind">
          {props.kind}
        </span>
        <Show when={props.name}>
          <span class="amc-detail" data-slot="amicode-skill-name">
            {props.name}
          </span>
        </Show>
      </span>
      <span class="amc-trail">
        <Switch>
          <Match when={state() === "done"}>
            <svg class="amc-tick" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M3.5 8.5l3 3 6-6.5"
                stroke="currentColor"
                stroke-width="1.75"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </Match>
          <Match when={state() === "running"}>
            <span class="amc-livedot" aria-hidden="true" />
          </Match>
        </Switch>
      </span>
    </>
  )

  return (
    <Show
      when={props.path}
      fallback={
        <span data-component="amicode-card" data-tool="skill" data-state={state()} data-clickable="false">
          {inner}
        </span>
      }
    >
      <button
        type="button"
        data-component="amicode-card"
        data-tool="skill"
        data-state={state()}
        data-clickable="true"
        title={props.path}
        aria-label={`Open ${props.name ?? "skill"} source`}
        onClick={open}
      >
        {inner}
      </button>
    </Show>
  )
}

// In-transcript entity view (Kate 2026-07-24): the receipt renders the full
// verdict-first entity view inline — no click, no modal. Data comes from the
// rail via the ui bridge (undefined until the rail mounts, exactly like the run
// window). A run with a live run_dir still prefers the richer RunWindow (matched
// earlier in the Switch), so a run only reaches the inline path as its verdict
// when there's no live window.
//
// AMENDED (spec-20260727-164748 §9.4): kind membership is necessary but NO LONGER
// SUFFICIENT. The inline view reads the LIVE problem view, so when every receipt
// of a kind took this path, N updates painted N identical copies of the present —
// and because the transcript fetches the globally-active problem with no ?slug=,
// switching problems mid-chat retroactively rewrote earlier receipts. Only the
// CURRENT receipt for the ACTIVE problem may render live (./receipt-currency.ts);
// the rest fall through to the Chip, which renders from their own captured diff.
function InlineEntityView(props: { kind: string; seq?: number }) {
  const labels = createMemo(() => amicodeEntityLabels())
  return (
    <div data-component="amicode-entity-inline" data-amicode-entity-current={props.kind}>
      <AmicodeEntityView
        view={amicodeProblemView()}
        kind={props.kind}
        runStatus={amicodeRunStatus()}
        anchorSeq={props.seq}
        onDraftPrompt={(text) => amicodeDraftPrompt(text)}
        onRetry={() => amicodeRefetchProblem()}
        retryLabel={labels().retry}
        editLabel={labels().edit}
      />
    </div>
  )
}

export function AmicodeToolCard(props: {
  tool: string
  status?: string
  input?: Record<string, any>
  output?: string // passed by message-part.tsx's Dynamic (already wired)
  messageID?: string
  sessionID?: string
  // amicode: set by message-part.tsx when this part is the surviving (latest)
  // member of a collapsed run of ≥2 identical (problem, entity, action)
  // receipts (../receipt-runs.ts). Only the Chip fallback below reads it —
  // every collapse-eligible receipt renders through Chip by construction
  // (receipt-runs.ts excludes anything that could route elsewhere), so a
  // count reaching ask/approval/run/widget/inline-entity render is not
  // expected; those paths simply ignore the prop.
  count?: number
}) {
  const ask = createMemo(() => (props.tool === "amicode_ask" ? parseAskInput(props.input) : undefined))
  // §9.5: the warrant card, same tool-input pattern as the ask card.
  const approval = createMemo(() =>
    props.tool === "amicode_request_approval" ? parseApprovalInput(props.input) : undefined,
  )
  const runRef = createMemo(() => (props.tool === "amicode_solve" ? runRefFromOutput(props.output) : undefined))
  const authored = createMemo(() =>
    props.tool === "amicode_author_widget" ? parseWidgetSentinel(props.output) : undefined,
  )
  // Any entity receipt surfaces its full view inline. We gate only on having a
  // problem view (the rail is mounted) — NOT on seq or on entities[kind]: a
  // record+update lands as two events but one receipt, and the view can lag a
  // beat, so tighter gates hid the view entirely. The entity view renders
  // whatever the live view holds for that kind. Runs with a live run_dir never
  // reach here (RunWindow matches first); other runs show their verdict.
  const inlineEntity = createMemo(() => {
    if (props.status !== "completed") return undefined
    const sentinel = parseDiffSentinel(props.output)
    if (!sentinel || !INLINE_KINDS.has(sentinel.entity)) return undefined
    const view = amicodeProblemView()
    if (!view) return undefined
    // §9.4: superseded receipts, and receipts captured against a different
    // problem, render from their captured diff via the Chip instead of the live
    // view. Deliberately permissive when currency is ambiguous (a kind with no
    // events yet stays live) — the original note here warns that tighter gates
    // hid the view entirely.
    if (!receiptIsCurrent({ problem: sentinel.problem, entity: sentinel.entity, seq: sentinel.seq }, view))
      return undefined
    return { kind: sentinel.entity, seq: sentinel.seq }
  })

  return (
    <Switch fallback={<Chip tool={props.tool} status={props.status} output={props.output} count={props.count} />}>
      <Match when={ask()}>
        {(value) => <AmicodeAskCard ask={value()} messageID={props.messageID} sessionID={props.sessionID} />}
      </Match>
      <Match when={approval()}>{(req) => <AmicodeApprovalCard request={req()} />}</Match>
      <Match when={runRef()}>{(ref) => <RunWindow run={ref().run} lab={ref().lab} />}</Match>
      <Match when={authored()}>{(preview) => <WidgetPreviewCard preview={preview()} />}</Match>
      <Match when={inlineEntity()}>{(e) => <InlineEntityView kind={e().kind} seq={e().seq} />}</Match>
    </Switch>
  )
}
