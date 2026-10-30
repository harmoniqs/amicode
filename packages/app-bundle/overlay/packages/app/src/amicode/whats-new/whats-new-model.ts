// amicode#2001: the What's-new landing page — the pure half (storage keying,
// the last-seen resolution, the service body parse, the reopen pub/sub). The
// component (whats-new.tsx) renders; the amicode service's
// GET /amicode/releases?since=<v> decides WHICH cards (newest first) and the
// "new for you" model arrivals.
//
// Last-seen version: in VS Code the extension's globalState (per machine) is
// the source — asked over the bridge (whats-new-query → whats-new-state);
// on a hub web client (unframed) — or when the host never answers — it is
// localStorage keyed by the server host.

export interface WhatsNewHighlight {
  title: string
  body: string
}

export interface WhatsNewCard {
  version: string
  date: string
  highlights: WhatsNewHighlight[]
  notes: string | null
  body: string
}

export interface WhatsNewArrival {
  provider: string
  model: string
  first_ok_at: number
}

export interface WhatsNewPayload {
  current: string
  /** The last-seen version the service diffed against; null on a fresh install. */
  since: string | null
  show: boolean
  welcome: boolean
  cards: WhatsNewCard[]
  newForYou: WhatsNewArrival[]
}

export interface KV {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const VERSION_RE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const isVersion = (v: unknown): v is string => typeof v === "string" && v.length <= 64 && VERSION_RE.test(v)
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

export function lastSeenStorageKey(serverUrl: string): string {
  let host = serverUrl
  try {
    host = new URL(serverUrl).host
  } catch {}
  return `amicode.whatsNew.lastSeen:${host}`
}

export function readLastSeenLocal(storage: KV | undefined, serverUrl: string): string | null {
  try {
    const v = storage?.getItem(lastSeenStorageKey(serverUrl))
    return isVersion(v) ? v : null
  } catch {
    return null
  }
}

export function writeLastSeenLocal(storage: KV | undefined, serverUrl: string, version: string): void {
  if (!isVersion(version)) return
  try {
    storage?.setItem(lastSeenStorageKey(serverUrl), version)
  } catch {}
}

/** `query` resolves the host's answer: a version, null (fresh install), or
 *  undefined (no answer — not framed by the chat panel, older extension). */
export async function resolveLastSeen(opts: {
  framed: boolean
  query?: () => Promise<string | null | undefined>
  storage: KV | undefined
  serverUrl: string
}): Promise<string | null> {
  if (opts.framed && opts.query) {
    const answer = await opts.query().catch(() => undefined)
    if (answer === null) return null
    if (isVersion(answer)) return answer
  }
  return readLastSeenLocal(opts.storage, opts.serverUrl)
}

export function releasesRoute(since: string | null): string {
  return since === null ? "/amicode/releases" : `/amicode/releases?since=${encodeURIComponent(since)}`
}

export function parseReleasesBody(body: unknown): WhatsNewPayload | undefined {
  if (!isObj(body) || body.ok !== true || !isVersion(body.current)) return undefined
  const cards: WhatsNewCard[] = []
  for (const c of Array.isArray(body.cards) ? body.cards : []) {
    if (!isObj(c) || !isVersion(c.version) || typeof c.date !== "string" || !Array.isArray(c.highlights)) continue
    const highlights = (c.highlights as unknown[])
      .filter((h): h is Record<string, unknown> => isObj(h) && typeof h.title === "string")
      .map((h) => ({ title: h.title as string, body: typeof h.body === "string" ? h.body : "" }))
    const notes = isObj(c.links) && typeof c.links.notes === "string" ? c.links.notes : null
    cards.push({ version: c.version, date: c.date, highlights, notes, body: typeof c.body === "string" ? c.body : "" })
  }
  const models = isObj(body.new_for_you) && Array.isArray(body.new_for_you.models) ? body.new_for_you.models : []
  const newForYou = (models as unknown[])
    .filter(
      (m): m is WhatsNewArrival =>
        isObj(m) && typeof m.provider === "string" && typeof m.model === "string" && typeof m.first_ok_at === "number",
    )
    .map((m) => ({ provider: m.provider, model: m.model, first_ok_at: m.first_ok_at }))
  const since = isVersion(body.since) ? body.since : null
  return { current: body.current, since, show: body.show === true, welcome: body.welcome === true, cards, newForYou }
}

// ── reopen requests (palette command bridge + status popover entry) ──────────
const listeners = new Set<() => void>()

export function onWhatsNewRequest(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function requestWhatsNew(): void {
  for (const cb of [...listeners]) cb()
}

// ── amicode#2020: the pinned-frame page (expand/collapse, clamp, ordering, keys) ──
// The page is a fixed frame — pinned header, one scrolling card region, pinned
// footer with Continue. The decisions about WHAT the cards show live here so
// they are testable without a DOM; whats-new-view.tsx is plain markup over them.

/** A body past this many characters (or lines) is clamped to ~2 lines + Show more. */
export const CLAMP_CHARS = 140
export const CLAMP_LINES = 2

export function isLongBody(body: string): boolean {
  return body.length > CLAMP_CHARS || body.split("\n").length > CLAMP_LINES
}

/** Immutable toggle of a key in a list (expanded cards, opened bodies). */
export function toggleIn(list: readonly string[], key: string): string[] {
  return list.includes(key) ? list.filter((k) => k !== key) : [...list, key]
}

/** Cards arrive newest first; only the newest starts expanded. */
export function initialExpanded(cards: readonly WhatsNewCard[]): string[] {
  return cards.length > 0 ? [cards[0].version] : []
}

export interface HighlightView {
  /** `<version>:<index>` — the key a "Show more" toggle is stored under. */
  key: string
  title: string
  body: string
  /** The body is long enough to offer Show more / Show less. */
  canToggle: boolean
  /** The body is currently clamped to ~2 lines. */
  clamped: boolean
}

export interface CardView {
  version: string
  date: string
  isNewest: boolean
  expanded: boolean
  /** Collapsed title row: how many highlights are inside. */
  highlightCount: number
  /** "New for you" arrivals — newest card only; rendered ahead of the highlights. */
  newForYou: WhatsNewArrival[]
  highlights: HighlightView[]
  body: string
  bodyKey: string
  bodyCanToggle: boolean
  bodyClamped: boolean
}

/** `expanded` = versions open; `more` = highlight/body keys whose full text is shown. */
export function buildCardViews(
  payload: Pick<WhatsNewPayload, "cards" | "newForYou">,
  expanded: readonly string[],
  more: readonly string[],
): CardView[] {
  return payload.cards.map((card, i) => {
    const bodyKey = `${card.version}:body`
    const bodyCanToggle = isLongBody(card.body)
    return {
      version: card.version,
      date: card.date,
      isNewest: i === 0,
      expanded: expanded.includes(card.version),
      highlightCount: card.highlights.length,
      newForYou: i === 0 ? payload.newForYou : [],
      highlights: card.highlights.map((h, j) => {
        const key = `${card.version}:${j}`
        const canToggle = isLongBody(h.body)
        return { key, title: h.title, body: h.body, canToggle, clamped: canToggle && !more.includes(key) }
      }),
      body: card.body,
      bodyKey,
      bodyCanToggle,
      bodyClamped: bodyCanToggle && !more.includes(bodyKey),
    }
  })
}

/** The one-line summary under the title. */
export function summaryLine(p: Pick<WhatsNewPayload, "current" | "since" | "welcome">): string {
  if (!p.welcome && p.since !== null && p.since !== "0.0.0") return `What changed since ${p.since}`
  return `Version ${p.current}`
}

/** The footer's "Release notes" link: the newest card that has one. */
export function notesLink(p: Pick<WhatsNewPayload, "cards">): string | null {
  return p.cards.find((c) => c.notes)?.notes ?? null
}

export interface KeyTarget {
  tag?: string
  editable?: boolean
  /** The Continue button itself — Enter on it is the same action. */
  continue?: boolean
}

/** Esc always dismisses. Enter dismisses unless focus is in an input or on
 *  another control (which owns its own Enter). */
export function keyAction(e: { key: string; target?: KeyTarget | null }): "dismiss" | null {
  if (e.key === "Escape") return "dismiss"
  if (e.key !== "Enter") return null
  const t = e.target
  if (!t) return "dismiss"
  if (t.continue) return "dismiss"
  if (t.editable) return null
  const tag = (t.tag ?? "").toUpperCase()
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON" || tag === "A") return null
  return "dismiss"
}

interface KeyEventLike {
  key: string
  target: unknown
  preventDefault(): void
  stopPropagation(): void
}

/** Describe a DOM event target for keyAction without importing DOM types. */
function keyTarget(target: unknown): KeyTarget | null {
  const el = target as
    | { tagName?: string; isContentEditable?: boolean; getAttribute?: (n: string) => string | null }
    | null
  if (!el || typeof el !== "object") return null
  return {
    tag: el.tagName,
    editable: el.isContentEditable === true,
    continue: el.getAttribute?.("data-action") === "whats-new-continue",
  }
}

/** The window keydown handler: Enter and Esc both dismiss; the event is swallowed. */
export function whatsNewKeyHandler(dismiss: () => void): (e: KeyEventLike) => void {
  return (e) => {
    if (keyAction({ key: e.key, target: keyTarget(e.target) }) !== "dismiss") return
    e.preventDefault()
    e.stopPropagation()
    dismiss()
  }
}
