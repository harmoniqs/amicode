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
  return { current: body.current, show: body.show === true, welcome: body.welcome === true, cards, newForYou }
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
