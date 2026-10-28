// amicode#1987 (#1979 S4): the model picker's short-list view. PURE — no
// SolidJS, no fetch — so ordering, dedupe, the cap, the allowlist hard-filter
// and search reach are unit-tested. The config fetch lives in
// dialog-select-model-shortlist-source.ts; favorites persist in
// context/models.tsx (`user[].favorite`, pure seam context/models-favorites.ts).
//
// Rules (the issue's):
//  - Default view (empty query): Favorites → Recommended (grouped by role, in
//    ROLE_ORDER) → Recent; deduped (a model shows once, at its first section);
//    capped at SHORTLIST_CAP entries. Everything else is behind search.
//  - Search (non-empty query): across ALL shown models (and the reachability-
//    hidden ones only when "show unavailable" is on), uncapped, grouped by the
//    recommended role; a model with no recommended role goes under "Other".
//    The role ALWAYS comes from config — no heuristic.
//  - `model.allowlist` (["provider/id" | "provider/*"]) hard-filters
//    everything, search included. Absent or empty ⇒ no filter.
//  - No favorites, no recommended, no recents ⇒ mode "all": every candidate,
//    exactly as the uncapped list (nothing is invented to fill the short list).
//  - Default `model.recommended` with no config: none.
import { matchesModelSearch } from "./dialog-select-model-search"
import type { ModelRef } from "./dialog-select-model-reachability"

export const SHORTLIST_CAP = 12

export const ROLE_ORDER = ["default", "fast", "strong", "open-weight"] as const
export type ModelRole = (typeof ROLE_ORDER)[number]

export type RecommendedEntry = { ref: ModelRef; role: ModelRole }
export type ShortlistConfig = {
  recommended: RecommendedEntry[]
  /** undefined ⇒ no allowlist (every model allowed). */
  allowlist: string[] | undefined
}

export const SHORTLIST_CONFIG_ROUTE = "/amicode/model-picker"

export type ShortlistGroup<T> = {
  kind: "favorites" | "recommended" | "recent" | "other"
  /** set for kind "recommended" */
  role?: ModelRole
  items: T[]
}

export type ModelShortlist<T> = {
  mode: "shortlist" | "search" | "all"
  groups: ShortlistGroup<T>[]
  /** the groups' items, flattened in display order (keyboard navigation) */
  items: T[]
  /** candidates not in the view (reachable through search); 0 outside "shortlist" */
  rest: number
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

/** "provider/id" → ref; the id keeps everything after the FIRST slash. */
export function parseModelRef(value: string): ModelRef | undefined {
  const slash = value.indexOf("/")
  if (slash <= 0 || slash === value.length - 1) return undefined
  return { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) }
}

/** Parse the GET /amicode/model-picker body. undefined ⇒ no config. */
export function parseShortlistConfig(raw: unknown): ShortlistConfig | undefined {
  if (!isObj(raw) || raw.ok !== true) return undefined
  const model = isObj(raw.model) ? raw.model : {}
  const recommended = (Array.isArray(model.recommended) ? model.recommended : []).flatMap((entry) => {
    if (!isObj(entry) || typeof entry.model !== "string") return []
    if (!ROLE_ORDER.includes(entry.role as ModelRole)) return []
    const ref = parseModelRef(entry.model)
    return ref ? [{ ref, role: entry.role as ModelRole }] : []
  })
  const allowlist = Array.isArray(model.allowlist)
    ? model.allowlist.filter((x): x is string => typeof x === "string" && parseModelRef(x) !== undefined)
    : undefined
  return { recommended, allowlist }
}

/** The allowlist hard filter. Absent or empty ⇒ everything allowed. */
export function isAllowed(ref: ModelRef, allowlist: readonly string[] | undefined) {
  if (!allowlist || allowlist.length === 0) return true
  return allowlist.some((pattern) => {
    const p = parseModelRef(pattern)
    if (!p || p.providerID !== ref.providerID) return false
    return p.modelID === "*" || p.modelID === ref.modelID
  })
}

const refKey = (ref: ModelRef) => `${ref.providerID}\u0000${ref.modelID}`

export function buildModelShortlist<T>(input: {
  /** reachability-shown models (already visibility-filtered) */
  shown: readonly T[]
  /** reachability-hidden models */
  hidden: readonly T[]
  showUnavailable: boolean
  keyOf: (item: T) => ModelRef
  /** the strings a search query matches against (name, id, provider name) */
  searchText: (item: T) => string[]
  favorites: readonly ModelRef[]
  recents: readonly ModelRef[]
  config: ShortlistConfig | undefined
  query: string
  cap?: number
}): ModelShortlist<T> {
  const allowlist = input.config?.allowlist
  const candidates = [...input.shown, ...(input.showUnavailable ? input.hidden : [])].filter((item) =>
    isAllowed(input.keyOf(item), allowlist),
  )
  const byKey = new Map(candidates.map((item) => [refKey(input.keyOf(item)), item] as const))
  const roleOf = new Map<string, ModelRole>()
  for (const entry of input.config?.recommended ?? []) {
    const k = refKey(entry.ref)
    if (!roleOf.has(k)) roleOf.set(k, entry.role)
  }

  const query = input.query.trim()
  if (query) {
    const matched = candidates.filter((item) => matchesModelSearch(query, input.searchText(item)))
    return byRole("search", matched, (item) => roleOf.get(refKey(input.keyOf(item))))
  }

  const cap = input.cap ?? SHORTLIST_CAP
  const taken = new Set<string>()
  const groups: ShortlistGroup<T>[] = []
  let count = 0
  const take = (refs: readonly ModelRef[]) =>
    refs.flatMap((ref) => {
      const k = refKey(ref)
      const item = byKey.get(k)
      if (!item || taken.has(k) || count >= cap) return []
      taken.add(k)
      count++
      return [item]
    })
  const push = (group: ShortlistGroup<T>) => {
    if (group.items.length > 0) groups.push(group)
  }

  push({ kind: "favorites", items: take(input.favorites) })
  const recommended = input.config?.recommended ?? []
  for (const role of ROLE_ORDER) {
    push({
      kind: "recommended",
      role,
      items: take(recommended.filter((entry) => entry.role === role).map((entry) => entry.ref)),
    })
  }
  push({ kind: "recent", items: take(input.recents) })

  if (groups.length === 0) return byRole("all", candidates, (item) => roleOf.get(refKey(input.keyOf(item))))
  return { mode: "shortlist", groups, items: groups.flatMap((g) => g.items), rest: candidates.length - count }
}

function byRole<T>(mode: "search" | "all", items: readonly T[], role: (item: T) => ModelRole | undefined): ModelShortlist<T> {
  const groups: ShortlistGroup<T>[] = [
    ...ROLE_ORDER.map((r): ShortlistGroup<T> => ({ kind: "recommended", role: r, items: items.filter((x) => role(x) === r) })),
    { kind: "other" as const, items: items.filter((x) => role(x) === undefined) },
  ].filter((g) => g.items.length > 0)
  return { mode, groups, items: groups.flatMap((g) => g.items), rest: 0 }
}
