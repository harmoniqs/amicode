// amicode(#2154): the session tab strip's DISPLAY order and its bulk-close
// selectors, kept pure so they are tested without a DOM.
//
// The persisted tab list stays the source of truth for order; the strip only
// derives how to show it:
//   - pinned tabs first (stored order among themselves);
//   - then every unpinned tab, with tabs spawned by another open tab pulled
//     in right after that tab (their "group"), siblings in stored order.
// Dragging rewrites the stored order and this arrangement is re-derived, so a
// dragged parent carries its group and a pinned/unpinned crossing snaps back.

import type { SessionTabStatus } from "@/pages/layout/session-tab-status"

export type ArrangeItem = {
  key: string
  pinned?: boolean
  /** tab key of the tab this one was spawned from, when that tab is open */
  parentKey?: string
}

export type ArrangedTab = {
  key: string
  pinned: boolean
  /** 0 = a top-level tab, 1 = spawned from the group's root */
  depth: 0 | 1
  /** root tab key of the spawned-session group, when the tab is in one */
  group?: string
  groupEdge?: "start" | "middle" | "end"
}

export function arrangeTabs(items: ArrangeItem[]): ArrangedTab[] {
  const byKey = new Map(items.map((item) => [item.key, item]))

  // Walk up through open, unpinned ancestors. A pinned tab never takes part in
  // a group — pinning is the stronger organisation.
  const rootOf = (item: ArrangeItem) => {
    if (item.pinned) return item.key
    let current = item
    const seen = new Set([item.key])
    while (current.parentKey) {
      const parent = byKey.get(current.parentKey)
      if (!parent || parent.pinned || seen.has(parent.key)) break
      seen.add(parent.key)
      current = parent
    }
    return current.key
  }

  const pinned: ArrangedTab[] = []
  const roots: ArrangeItem[] = []
  const children = new Map<string, ArrangeItem[]>()
  for (const item of items) {
    if (item.pinned) {
      pinned.push({ key: item.key, pinned: true, depth: 0 })
      continue
    }
    const root = rootOf(item)
    if (root === item.key) {
      roots.push(item)
      continue
    }
    const list = children.get(root)
    if (list) list.push(item)
    else children.set(root, [item])
  }

  // A cycle leaves no root for its members — surface them as top-level tabs
  // rather than dropping them.
  const placed = new Set([...pinned.map((tab) => tab.key), ...roots.map((item) => item.key)])
  for (const [root, list] of children) {
    if (placed.has(root)) continue
    children.delete(root)
    roots.push(...list)
  }

  const out = [...pinned]
  for (const root of roots) {
    const kids = children.get(root.key) ?? []
    if (kids.length === 0) {
      out.push({ key: root.key, pinned: false, depth: 0 })
      continue
    }
    out.push({ key: root.key, pinned: false, depth: 0, group: root.key, groupEdge: "start" })
    kids.forEach((kid, index) =>
      out.push({
        key: kid.key,
        pinned: false,
        depth: 1,
        group: root.key,
        groupEdge: index === kids.length - 1 ? "end" : "middle",
      }),
    )
  }
  return out
}

/** Every unpinned tab except the anchor. */
export function closeOtherKeys(arranged: ArrangedTab[], anchor: string) {
  return arranged.filter((tab) => !tab.pinned && tab.key !== anchor).map((tab) => tab.key)
}

/** Unpinned tabs displayed after the anchor. */
export function closeRightKeys(arranged: ArrangedTab[], anchor: string) {
  const index = arranged.findIndex((tab) => tab.key === anchor)
  if (index === -1) return []
  return arranged
    .slice(index + 1)
    .filter((tab) => !tab.pinned)
    .map((tab) => tab.key)
}

/** Unpinned tabs whose session is done and already seen ("idle"); never the
 *  active tab, never one that is working, waiting on you, errored, unread, or
 *  whose status is not known yet. */
export function closeFinishedKeys(
  arranged: ArrangedTab[],
  statusOf: (key: string) => SessionTabStatus | undefined,
  active?: string,
) {
  return arranged
    .filter((tab) => !tab.pinned && tab.key !== active && statusOf(tab.key) === "idle")
    .map((tab) => tab.key)
}

/** The spawned-session group the tab belongs to (root first), or nothing. */
export function closeGroupKeys(arranged: ArrangedTab[], key: string) {
  const group = arranged.find((tab) => tab.key === key)?.group
  if (!group) return []
  return arranged.filter((tab) => tab.group === group).map((tab) => tab.key)
}

export type TabListEntry = { key: string; title: string; project?: string }

/** The overflow list's search: every whitespace-separated word must appear in
 *  the title or the project name, case-insensitively. */
export function filterTabList<T extends TabListEntry>(entries: T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return entries
  return entries.filter((entry) => {
    const haystack = `${entry.title} ${entry.project ?? ""}`.toLowerCase()
    return words.every((word) => haystack.includes(word))
  })
}

/** The session-spawn stamp (`metadata.spawned_by`) the amicode_session tool
 *  writes on every child it creates. */
export function readSpawnedBy(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== "object") return undefined
  const value = (metadata as { spawned_by?: unknown }).spawned_by
  return typeof value === "string" && value.length > 0 ? value : undefined
}
