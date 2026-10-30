// #1249: the ephemeral, in-memory home of unsaved Preview edits.
//
// A session-tab switch remounts the Preview (so one session's workspace can
// never carry into another's). Unsaved editor text must survive that remount —
// and must never be shown to a different session — so drafts live HERE, outside
// any component, keyed by (session, path). The store has no eviction and no
// lifecycle hook: only an explicit Save (matching revision), Discard, or Close
// removes a draft. It never writes to disk.
//
// Alongside the drafts it owns two pieces of cross-remount state the ACs need:
//  - per-file save serialization (a close-save joins an in-flight save of the
//    same content instead of writing twice), and
//  - the session-owned close intent (a cancelable token), so a close request
//    survives a session switch and a second tab cannot replace it.

export type PreviewDraft = { content: string; revision: number }

const SEP = "\u0000"
const draftKey = (session: string, path: string) => `${session}${SEP}${path}`

type SaveEntry = { content: string; promise: Promise<void> }

export const createPreviewDraftStore = () => {
  const drafts = new Map<string, PreviewDraft & { session: string; path: string }>()
  const latestSave = new Map<string, SaveEntry>()
  const closes = new Map<string, { path: string; token: number }>()
  const closedListeners = new Map<string, Set<(path: string) => void>>()
  let counter = 0

  return {
    get: (session: string, path: string): PreviewDraft | undefined => {
      const draft = drafts.get(draftKey(session, path))
      return draft && { content: draft.content, revision: draft.revision }
    },

    /** Record the latest editor text for (session, path); returns its revision. */
    write: (session: string, path: string, content: string): number => {
      const revision = ++counter
      drafts.set(draftKey(session, path), { session, path, content, revision })
      return revision
    },

    /** Dirty paths of one session, in first-edit order. */
    paths: (session: string): string[] => {
      const out: string[] = []
      for (const draft of drafts.values()) if (draft.session === session) out.push(draft.path)
      return out
    },

    /** Remove a draft. With `revision` (a save completing) it clears only if no
     *  newer edit landed and the draft is still the one that was saved; without
     *  it (explicit discard / close) it always clears. True when it cleared. */
    clear: (session: string, path: string, revision?: number): boolean => {
      const key = draftKey(session, path)
      const draft = drafts.get(key)
      if (!draft) return false
      if (revision !== undefined && draft.revision !== revision) return false
      drafts.delete(key)
      return true
    },

    /** A save of `revision` finished: clear the draft if it is still that exact
     *  revision. True when the saved text is now the file's truth (cleared now, or
     *  already cleared by a joined save of the same text); false when a newer edit
     *  (or a reopened draft) exists and the document must stay dirty. */
    settle: (session: string, path: string, revision: number): boolean => {
      const key = draftKey(session, path)
      const draft = drafts.get(key)
      if (!draft) return true
      if (draft.revision !== revision) return false
      drafts.delete(key)
      return true
    },

    /** Serialize writes per file key (server + project + path). A request whose
     *  content equals the latest queued/in-flight one joins it (no second write);
     *  otherwise it runs after it, whether that one succeeded or failed. */
    enqueueSave: (fileKey: string, content: string, run: () => Promise<void>): Promise<void> => {
      const last = latestSave.get(fileKey)
      if (last && last.content === content) return last.promise
      const after = last ? last.promise.catch(() => {}) : Promise.resolve()
      const entry: SaveEntry = { content, promise: Promise.resolve() }
      entry.promise = after.then(run).finally(() => {
        if (latestSave.get(fileKey) === entry) latestSave.delete(fileKey)
      })
      latestSave.set(fileKey, entry)
      return entry.promise
    },

    /** Open the session's close decision. One decision at a time: a request for
     *  another path while one is active is refused (undefined); the same path
     *  rejoins the active token. */
    requestClose: (session: string, path: string): number | undefined => {
      const active = closes.get(session)
      if (active) return active.path === path ? active.token : undefined
      const token = ++counter
      closes.set(session, { path, token })
      return token
    },

    closeRequest: (session: string): { path: string; token: number } | undefined => {
      const active = closes.get(session)
      return active && { ...active }
    },

    /** Cancel the decision (user pressed Cancel). True when it was the current one. */
    cancelClose: (session: string, token: number): boolean => {
      if (closes.get(session)?.token !== token) return false
      closes.delete(session)
      return true
    },

    /** A close-save finished: true (and the decision ends) only when its token is
     *  still the current one — a canceled / superseded request leaves the tab open.
     *  The session's LIVE Preview (possibly a newer mount than the one that asked)
     *  is told to close the path, so a close-save outlives a session switch. */
    resolveClose: (session: string, token: number): boolean => {
      const active = closes.get(session)
      if (active?.token !== token) return false
      closes.delete(session)
      for (const listener of [...(closedListeners.get(session) ?? [])]) listener(active.path)
      return true
    },

    /** Subscribe the live Preview of a session to resolved close decisions. */
    onClosed: (session: string, listener: (path: string) => void): (() => void) => {
      const set = closedListeners.get(session) ?? new Set()
      set.add(listener)
      closedListeners.set(session, set)
      return () => {
        set.delete(listener)
        if (set.size === 0 && closedListeners.get(session) === set) closedListeners.delete(session)
      }
    },
  }
}

/** The app-wide store (module scope = survives Preview remounts). */
export const previewDrafts = createPreviewDraftStore()
