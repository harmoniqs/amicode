/** #1291 (durable mirror): an IndexedDB-backed mirror of per-session data.
 *
 *  The sync/session stores are memory-only: on every reload the session
 *  view booted into a wire gap — nothing to hold (the frozen-clone holds
 *  die with the document), so the pane rendered empty until the hub's
 *  first page landed. This mirror persists the most recent message page
 *  per session; on the next boot `sync()` hydrates the store from disk
 *  BEFORE the network load, so the timeline renders instantly and the
 *  wire fetch simply reconciles into truth (background revalidate).
 *
 *  Writes hook the message-load success path — manual opens, tab
 *  switches, AND the bulk warm's prefetch all flow through it, so the
 *  30 most-recent sessions are on disk after the first warm pass.
 *  Reads never block boot: a failed/absent mirror degrades to today's
 *  behavior (the fetch just takes the wire as before).
 *
 *  Everything here is best-effort and side-effect-free on failure — a
 *  private-mode or corrupted IDB must never break the session view. */

import type { SessionMessageInfo } from "@opencode-ai/client/promise"
import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client"

const DB_NAME = "amicode-mirror"
const DB_VERSION = 1
const STORE = "sessions"
const MAX_MIRRORED_SESSIONS = 60
const MAX_MESSAGES_PER_SESSION = 40
const SAVE_DEBOUNCE_MS = 1_000
const PRUNE_DEBOUNCE_MS = 60_000

export interface MirrorRecord {
  v: 1
  savedAt: number
  info: Session | undefined
  /** The most recent messages, oldest first, each with its parts. */
  messages: { info: Message; parts: Part[] }[]
  /** The normalized message-source list the timeline gates on. */
  source: SessionMessageInfo[]
}

let dbPromise: Promise<IDBDatabase | undefined> | undefined

function openDB(): Promise<IDBDatabase | undefined> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(undefined)
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(STORE)) {
          // key: `${scope}\u0000${sessionID}` — the scope string encodes the
          // server; session IDs are unique, so no directory is needed.
          db.createObjectStore(STORE)
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(undefined)
      request.onblocked = () => resolve(undefined)
    } catch {
      resolve(undefined)
    }
  })
  return dbPromise
}

export function mirrorKey(scope: string, sessionID: string) {
  return `${scope}\u0000${sessionID}`
}

/** Per-session trailing debounce: stream updates and load completions
 *  collapse into one small write per settle. */
const pending = new Map<string, ReturnType<typeof setTimeout>>()

/** A stream can complete a mirror save every second. Pruning is full-store
 *  read/write work, so defer one run per scope instead of making its own
 *  hydration reads queue behind every completed save. */
const pendingPrunes = new Map<string, ReturnType<typeof setTimeout>>()

function schedulePrune(scope: string) {
  if (pendingPrunes.has(scope)) return
  pendingPrunes.set(
    scope,
    setTimeout(() => {
      pendingPrunes.delete(scope)
      void pruneMirror(scope)
    }, PRUNE_DEBOUNCE_MS),
  )
}

/** #1287 privacy (CWE-922): keys whose session was deleted. A save that
 *  already fired its timer but has not yet written checks this before its
 *  put, so a deleted session can never be re-persisted after deleteMirror. */
const tombstoned = new Set<string>()

/** #1291 debug: the harness reload test needs to see mirror writes;
 *  bounded ring, harmless in production, removable once trusted. */
export function mirrorDebug(event: string, detail: string) {
  const w = globalThis as { __mirrorDebug?: unknown[] }
  w.__mirrorDebug = w.__mirrorDebug ?? []
  w.__mirrorDebug.push({ event, detail: detail.slice(0, 200), t: Date.now() })
  if (w.__mirrorDebug.length > 20) w.__mirrorDebug.shift()
}

export function saveMirror(scope: string, sessionID: string, record: Omit<MirrorRecord, "v" | "savedAt">) {
  const key = mirrorKey(scope, sessionID)
  const existing = pending.get(key)
  if (existing) clearTimeout(existing)
  pending.set(
    key,
    setTimeout(() => {
      pending.delete(key)
      void (async () => {
        const db = await openDB()
        if (!db) return
        // #1287: the session was deleted after this save's timer fired but
        // before it could write — skip the put so it is never re-persisted.
        if (tombstoned.has(key)) return
        try {
          // Solid store values are PROXIES — IDB's structured clone rejects
          // them (DataCloneError). This data is JSON-origin (API
          // responses), so a JSON round-trip is a faithful deep plain copy.
          const value = JSON.parse(JSON.stringify(record)) as MirrorRecord
          value.v = 1
          value.savedAt = Date.now()
          const tx = db.transaction(STORE, "readwrite")
          const request = tx.objectStore(STORE).put(value, key)
          request.onerror = () => {
            console.warn("[mirror] put failed:", request.error?.message)
            mirrorDebug("put-error", String(request.error ?? ""))
          }
          tx.oncomplete = () => {
            mirrorDebug("saved", key)
            schedulePrune(scope)
          }
        } catch (error) {
          mirrorDebug("sync-error", String(error))
          /* best-effort: a failed mirror write never surfaces */
        }
      })()
    }, SAVE_DEBOUNCE_MS),
  )
}

/** #1287 privacy (CWE-922): drop a session's mirror the moment it is
 *  deleted. Cancels a pending debounced save, tombstones the key so an
 *  already-fired save skips its write, and deletes the persisted record — so
 *  deleted messages/parts never linger in IndexedDB until pruning ages them
 *  out. Best-effort, like the rest of the mirror. */
export function deleteMirror(scope: string, sessionID: string) {
  const key = mirrorKey(scope, sessionID)
  const existing = pending.get(key)
  if (existing) clearTimeout(existing)
  pending.delete(key)
  tombstoned.add(key)
  void (async () => {
    const db = await openDB()
    if (!db) return
    try {
      db.transaction(STORE, "readwrite").objectStore(STORE).delete(key)
      mirrorDebug("deleted", key)
    } catch {
      /* best-effort: a failed mirror delete never surfaces */
    }
  })()
}

export async function loadMirror(scope: string, sessionID: string): Promise<MirrorRecord | undefined> {
  const db = await openDB()
  if (!db) return undefined
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readonly")
      const request = tx.objectStore(STORE).get(mirrorKey(scope, sessionID))
      request.onsuccess = () => {
        const value = request.result as unknown
        if (isValidMirrorRecord(value)) return resolve(value)
        // #1287: a malformed/legacy record would make hydrateFromMirror
        // partially apply then throw (reading item.parts / item.info.id).
        // Drop it and hydrate from nothing so only the wire fills the view.
        if (value !== undefined) {
          try {
            db.transaction(STORE, "readwrite").objectStore(STORE).delete(mirrorKey(scope, sessionID))
          } catch {
            /* best-effort */
          }
        }
        resolve(undefined)
      }
      request.onerror = () => resolve(undefined)
    } catch {
      resolve(undefined)
    }
  })
}

/** #1287: a persisted record is only safe to hydrate if the whole v1 shape
 *  is intact — every messages item needs a string-id `info` and an array of
 *  `parts` (both dereferenced by hydrateFromMirror). `info` (Session) is set
 *  as-is and never read there, so it is not deep-validated. */
function isValidMirrorRecord(value: unknown): value is MirrorRecord {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  if (record.v !== 1 || typeof record.savedAt !== "number") return false
  if (!Array.isArray(record.messages) || !Array.isArray(record.source)) return false
  return record.messages.every((item) => {
    const entry = item as { info?: { id?: unknown }; parts?: unknown } | null
    return (
      !!entry &&
      typeof entry === "object" &&
      !!entry.info &&
      typeof entry.info === "object" &&
      typeof entry.info.id === "string" &&
      Array.isArray(entry.parts)
    )
  })
}

/** Cap the mirror: keep only the MAX_MIRLORED_SESSIONS most recently saved
 *  records for the given scope (stale sessions age out of the disk). */
async function pruneMirror(scope: string) {
  const db = await openDB()
  if (!db) return
  try {
    const tx = db.transaction(STORE, "readwrite")
    const store = tx.objectStore(STORE)
    const prefix = `${scope}\u0000`
    const entries: { key: string; savedAt: number }[] = []
    const cursorRequest = store.openCursor()
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result
      if (!cursor) {
        entries.sort((a, b) => b.savedAt - a.savedAt)
        for (const entry of entries.slice(MAX_MIRRORED_SESSIONS)) store.delete(entry.key)
        return
      }
      const key = String(cursor.key)
      if (key.startsWith(prefix)) {
        const record = cursor.value as MirrorRecord
        entries.push({ key, savedAt: record?.savedAt ?? 0 })
      }
      cursor.continue()
    }
  } catch {
    /* best-effort */
  }
}

/** The store snapshot the mirror persists — capped to the most recent
 *  messages so a long history page doesn't bloat every write. */
export function mirrorSlice(messages: { info: Message; parts: Part[] }[]): { info: Message; parts: Part[] }[] {
  return messages.slice(-MAX_MESSAGES_PER_SESSION)
}
