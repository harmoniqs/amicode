// amicode#1786 (S2) — the question inbox: every pending question, answerable
// without opening the session. A client-side consumer of the shared pending
// rows (#1760 P2): entries DERIVE from the ServerSession store's question map
// — the same map the in-session dock renders — so a question asked by a
// session this client has never opened lists here the moment its live
// question.asked event (or a bootstrap /question seed) lands in the store.
// No engine change, no new state ownership; the store's question lifecycle
// (asked/replied/rejected) settles entries everywhere by itself.
//
// Liveness beyond the events: the engine heartbeats live rows every 5s and
// its TTL (15s) prunes a dead owner's rows silently — no terminal event ever
// fires for a crashed owner. The inbox therefore keeps per-request evidence
// (first seen, last seen alive) refreshed by periodic reads of the engine's
// /question list (the shared rows seam — live-heartbeat rows only, any
// owner): presence refreshes, a read that covers the entry's directory and
// omits it proves the row dead and clears it (#1768/#1766 reconcile
// semantics: recency-guarded, honest absence keeps current value). Entries
// the reads cannot cover (unknown directory, unreachable owner) read
// honestly as stale after the stale window and clear by TTL — an
// unreachable owner never wedges the inbox.
import type { QuestionRequest } from "@opencode-ai/sdk/v2/client"
import { createEffect, createRoot, createSignal } from "solid-js"

/** No liveness evidence for this long → the entry reads honestly as stale
 *  (the engine row TTL is 15s; the reconcile cadence is 10s, so a live row's
 *  evidence is at most one missed cadence old — see INBOX_RECONCILE_MS). */
export const INBOX_STALE_MS = 30_000
/** No liveness evidence for this long → the entry clears by TTL. Only bites
 *  when the reconcile cannot cover the entry (unknown directory, a failing
 *  read); a covered live row refreshes every cadence and never ages out. */
export const INBOX_TTL_MS = 10 * 60_000
/** The reconcile cadence: one /question read per involved directory while
 *  the inbox holds entries. Above the engine's 15s row TTL so a dead owner's
 *  row is gone before the next read observes its absence. */
export const INBOX_RECONCILE_MS = 10_000

/** Per-request liveness evidence, keyed by request id. */
export type InboxEvidence = { firstSeenAt: number; lastLiveAt: number }
export type InboxState = {
  evidence: Map<string, InboxEvidence>
  /** ids cleared by TTL while their store row still lingers (the dock keeps
   *  its own view of the same store; the inbox just stops listing them). */
  tombstones: Set<string>
}

export function createInboxState(): InboxState {
  return { evidence: new Map(), tombstones: new Set() }
}

export type InboxEntry = {
  readonly id: string
  readonly sessionID: string
  readonly request: QuestionRequest
  /** The session's title from the shared info store, when warmed. */
  readonly title: string | undefined
  /** The session's directory — the reply's location scope and the read's
   *  coverage key. Undefined until the info store learns the session. */
  readonly directory: string | undefined
  /** When this client first saw the request. */
  readonly askedAt: number
  /** How long since the last liveness evidence. */
  readonly ageMs: number
  readonly stale: boolean
}

type InboxInfo = Record<string, { title?: string; directory?: string } | undefined>

/** The store's question map, generalized so tests and plain records fit. */
export type InboxQuestionMap = Record<string, readonly QuestionRequest[] | undefined>

const cmpID = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Derive the inbox from the store. Idempotent-ish: first-seen evidence is
 * stamped here (at `now`), TTL clears tombstone entries, and tracking state
 * for ids no longer in the store is swept — so calling this on every store
 * change is the whole wiring story.
 */
export function collectQuestionInbox(input: {
  question: InboxQuestionMap
  info?: InboxInfo
  state: InboxState
  now: number
}): InboxEntry[] {
  const present = new Set<string>()
  for (const rows of Object.values(input.question)) for (const row of rows ?? []) present.add(row.id)
  // Sweep tracking state for settled/evicted rows — keeps the maps bounded
  // and lets a TTL tombstone die once its row finally leaves the store.
  for (const id of input.state.evidence.keys()) if (!present.has(id)) input.state.evidence.delete(id)
  for (const id of input.state.tombstones) if (!present.has(id)) input.state.tombstones.delete(id)

  const entries: InboxEntry[] = []
  for (const [sessionID, rows] of Object.entries(input.question).sort(([a], [b]) => cmpID(a, b))) {
    for (const request of rows ?? []) {
      if (input.state.tombstones.has(request.id)) continue
      const seen = input.state.evidence.get(request.id)
      const firstSeenAt = seen?.firstSeenAt ?? input.now
      if (!seen) input.state.evidence.set(request.id, { firstSeenAt, lastLiveAt: firstSeenAt })
      const lastLiveAt = seen?.lastLiveAt ?? firstSeenAt
      // Clears by TTL: an unreachable owner never wedges the inbox. (The read
      // timeout bounds a read's readAt within ~30s of now, and the tombstone
      // needs 10 min without evidence, so a read issued before the ask cannot
      // arrive after the tombstone — no recency guard is needed here.)
      if (input.now - lastLiveAt > INBOX_TTL_MS) {
        input.state.evidence.delete(request.id)
        input.state.tombstones.add(request.id)
        continue
      }
      const info = input.info?.[sessionID]
      entries.push({
        id: request.id,
        sessionID,
        request,
        title: info?.title,
        directory: info?.directory,
        askedAt: firstSeenAt,
        ageMs: input.now - lastLiveAt,
        stale: input.now - lastLiveAt > INBOX_STALE_MS,
      })
    }
  }
  return entries.sort((a, b) => a.askedAt - b.askedAt || cmpID(a.id, b.id))
}

export type InboxClear = { sessionID: string; id: string }

export type InboxReadOutcome = {
  kind: "ok" | "failed"
  refreshed: string[]
  cleared: InboxClear[]
}

/**
 * One reconcile read: the engine's /question list for one directory is the
 * shared pending rows (live-heartbeat only, any owner) — presence is the
 * freshest liveness truth, absence proves the row dead. The #1768 semantics:
 * a read issued BEFORE the last local evidence is stale for that entry and
 * cannot clear it (recency guard); a read that does not cover the entry's
 * directory changes nothing (honest absence keeps current value); a failed
 * read changes nothing. The read is stamped BEFORE it is issued, like the
 * fleet session-status read.
 */
export async function runInboxRead(deps: {
  directory: string
  read: () => Promise<readonly QuestionRequest[]>
  question: InboxQuestionMap
  info?: InboxInfo
  state: InboxState
  now: () => number
}): Promise<InboxReadOutcome> {
  const readAt = deps.now()
  let rows: readonly QuestionRequest[]
  try {
    rows = await deps.read()
  } catch {
    return { kind: "failed", refreshed: [], cleared: [] }
  }
  const present = new Set(rows.map((row) => row.id))
  const refreshed: string[] = []
  const cleared: InboxClear[] = []
  for (const [sessionID, rows] of Object.entries(deps.question)) {
    // Coverage: only sessions whose directory is this read's directory. The
    // engine's per-directory instance list is authoritative for them.
    if (deps.info?.[sessionID]?.directory !== deps.directory) continue
    for (const row of rows ?? []) {
      const evidence = deps.state.evidence.get(row.id)
      const tombstoned = deps.state.tombstones.has(row.id)
      if (!evidence && !tombstoned) continue
      if (present.has(row.id)) {
        // Alive per the freshest truth — even a TTL tombstone revives.
        deps.state.tombstones.delete(row.id)
        if (evidence) evidence.lastLiveAt = Math.max(evidence.lastLiveAt, readAt)
        refreshed.push(row.id)
        continue
      }
      // Recency guard: a read issued before the ask (or before newer local
      // evidence) cannot clear what it predates.
      if (evidence && (evidence.firstSeenAt > readAt || evidence.lastLiveAt > readAt)) continue
      deps.state.evidence.delete(row.id)
      deps.state.tombstones.delete(row.id)
      cleared.push({ sessionID, id: row.id })
    }
  }
  return { kind: "ok", refreshed, cleared }
}

/** Remove cleared rows from the store's question map (safe inside a solid
 *  `produce` draft; a session left with no rows is dropped entirely). */
export function applyInboxClears(question: InboxQuestionMap & Record<string, QuestionRequest[]>, clears: readonly InboxClear[]) {
  for (const clear of clears) {
    const rows = question[clear.sessionID]
    if (!rows?.some((row) => row.id === clear.id)) continue
    const next = rows.filter((row) => row.id !== clear.id)
    if (next.length === 0) delete question[clear.sessionID]
    else question[clear.sessionID] = next
  }
}

// ── the answer action ────────────────────────────────────────────────────────

export type InboxAnswerInput = {
  sessionID: string
  requestID: string
  directory: string | undefined
  answers: ReadonlyArray<ReadonlyArray<string>>
}

export type InboxAnswerDeps = {
  /** The reply request, scoped to the REQUESTING session's directory
   *  (amicode#117/#249: the registry is instance-per-directory). */
  reply: (input: InboxAnswerInput) => Promise<unknown>
  /** Is the row still in the shared store? (Answers a failed reply: a
   *  question that left the store was settled elsewhere — the goal state.) */
  hasQuestion: (sessionID: string, requestID: string) => boolean
  /** Remove the entry locally once the reply is accepted (the engine's
   *  question.replied event also settles the store; both are idempotent). */
  settle: (input: { sessionID: string; requestID: string }) => void
  /** The telemetry sink (postClientLog). */
  telemetry?: (body: string) => void
}

/** The live dist's diagnostic reply captures (question-reply-attempt / ok /
 *  failed) were built from an unbranched tree — #1786 absorbs them here as
 *  the inbox's own telemetry floor, so the markers keep the same capture
 *  shape in source, owned by the reply path this slice ships. */
function emitReplyTelemetry(post: ((body: string) => void) | undefined, capture: Record<string, unknown>) {
  if (!post) return
  try {
    post(JSON.stringify(capture))
  } catch {
    // Telemetry must never break the reply.
  }
}

function replyErrorText(error: unknown) {
  return error instanceof Error ? `${error.message} | ${String(error.stack).slice(0, 400)}` : String(error)
}

/**
 * The inbox's answer action. Single-flight per request (a retry while the
 * reply is in flight rides the same promise — never double-submit), tolerant
 * of a late "already settled" (the question left the store while the reply
 * was in flight → answered elsewhere → the goal state, reads as success),
 * and the settle is idempotent against the engine's own idempotent
 * settlePending.
 */
export function createInboxAnswerAction(deps: InboxAnswerDeps) {
  const inflight = new Map<string, Promise<void>>()
  return {
    pending: (requestID: string) => inflight.has(requestID),
    submit(input: InboxAnswerInput): Promise<void> {
      const existing = inflight.get(input.requestID)
      if (existing) return existing
      const task = (async () => {
        emitReplyTelemetry(deps.telemetry, {
          kind: "question-reply-attempt",
          requestID: input.requestID,
          directory: input.directory,
          sessionID: input.sessionID,
        })
        try {
          await deps.reply(input)
          emitReplyTelemetry(deps.telemetry, { kind: "question-reply-ok", requestID: input.requestID })
        } catch (error) {
          // A late "already settled" is the goal state: the settle event (or
          // the engine's own row expiry) removed the store row before this
          // failure landed. The question was answered — never wedge on it.
          if (!deps.hasQuestion(input.sessionID, input.requestID)) {
            emitReplyTelemetry(deps.telemetry, {
              kind: "question-reply-ok",
              requestID: input.requestID,
              alreadySettled: true,
            })
          } else {
            emitReplyTelemetry(deps.telemetry, {
              kind: "question-reply-failed",
              requestID: input.requestID,
              error: replyErrorText(error),
            })
            throw error
          }
        } finally {
          if (inflight.get(input.requestID) === task) inflight.delete(input.requestID)
        }
        deps.settle({ sessionID: input.sessionID, requestID: input.requestID })
      })()
      inflight.set(input.requestID, task)
      return task
    },
  }
}

// ── the per-window inbox controller (module singleton) ──────────────────────
// One inbox per window (the vault-panel pattern): the layout that owns the
// active server's provider scope initializes it with narrow deps over the
// shared store + SDK; the titlebar badge and the panel both read
// `questionInbox()`. Uninitialized reads degrade to an empty inbox so chrome
// rendered outside an init scope (a titlebar before the layout mounts) stays
// silent instead of throwing.

export type QuestionInboxDeps = {
  /** The shared store's question map (a reactive read — the effect tracks it). */
  question: () => InboxQuestionMap
  /** The shared store's session-info map (reactive; may be undefined). */
  info: () => InboxInfo | undefined
  /** Remove cleared rows from the shared store (idempotent). */
  removeQuestion: (clears: readonly InboxClear[]) => void
  /** Is the row still in the shared store? */
  isLive: (sessionID: string, requestID: string) => boolean
  /** The engine's /question list for one directory (the shared rows seam). */
  listQuestions: (directory: string) => Promise<readonly QuestionRequest[]>
  /** The reply request, scoped to the requesting session's directory. */
  reply: (input: InboxAnswerInput) => Promise<unknown>
  telemetry?: (body: string) => void
  /** Only read while this says true (the live event stream is connected). */
  connected?: () => boolean
  /** Test seam for the reconcile cadence. */
  reconcileMs?: number
}

export type QuestionInboxHandle = {
  entries: () => readonly InboxEntry[]
  opened: () => boolean
  open: () => void
  close: () => void
  toggle: () => void
  submit: ReturnType<typeof createInboxAnswerAction>["submit"]
  pending: (requestID: string) => boolean
  dispose: () => void
}

let handle: QuestionInboxHandle | undefined

export function questionInbox(): QuestionInboxHandle {
  return (
    handle ?? {
      entries: () => [],
      opened: () => false,
      open: () => {},
      close: () => {},
      toggle: () => {},
      // Unreachable in practice: the panel only renders submit controls for
      // listed entries, and an uninitialized inbox lists none.
      submit: () => Promise.resolve(),
      pending: () => false,
      dispose: () => {},
    }
  )
}

export function initQuestionInbox(deps: QuestionInboxDeps): QuestionInboxHandle {
  handle?.dispose()
  const state = createInboxState()
  const [entries, setEntries] = createSignal<readonly InboxEntry[]>([])
  const [opened, setOpened] = createSignal(false)
  const answer = createInboxAnswerAction({
    reply: deps.reply,
    hasQuestion: deps.isLive,
    settle: (input) => deps.removeQuestion([{ sessionID: input.sessionID, id: input.requestID }]),
    telemetry: deps.telemetry,
  })
  const collect = () =>
    setEntries(collectQuestionInbox({ question: deps.question(), info: deps.info(), state, now: Date.now() }))
  // Freshness: one read per involved directory per cadence. A read only runs
  // while the event stream is connected (offline reads are pointless — their
  // failure would be honest absence, but the retry storm buys nothing).
  const reconcile = async () => {
    if (deps.connected?.() === false) return
    const directories = new Set(entries().flatMap((entry) => (entry.directory ? [entry.directory] : [])))
    for (const directory of directories) {
      const out = await runInboxRead({
        directory,
        read: () => deps.listQuestions(directory),
        question: deps.question(),
        info: deps.info(),
        state,
        now: () => Date.now(),
      })
      // An absence the read proves dead removes the dead store row — the
      // same settle the engine's replied/rejected events drive.
      if (out.cleared.length > 0) deps.removeQuestion(out.cleared)
      collect()
    }
  }
  const cleanup = createRoot((disposeRoot) => {
    // In the browser this effect tracks the shared store's question + info
    // maps — every ask, settle, and session-info warm lands there and
    // re-derives the inbox instantly. Under the app test runner solid
    // resolves to the non-reactive server build, where this is inert and
    // the cadence collect below is what drives the same derivation.
    createEffect(() => {
      deps.question()
      deps.info()
      collect()
    })
    const timer = setInterval(
      () => {
        collect() // the staleness read re-evaluates on the clock
        void reconcile()
      },
      deps.reconcileMs ?? INBOX_RECONCILE_MS,
    )
    return () => {
      clearInterval(timer)
      disposeRoot()
    }
  })
  const inbox: QuestionInboxHandle = {
    entries: () => entries(),
    opened: () => opened(),
    open: () => setOpened(true),
    close: () => setOpened(false),
    toggle: () => setOpened((x) => !x),
    submit: answer.submit,
    pending: answer.pending,
    dispose() {
      if (handle === inbox) handle = undefined
      cleanup()
    },
  }
  handle = inbox
  return inbox
}
