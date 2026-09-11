import { SESSION_PREVIEW_TAB } from "./layout-tabs"

export const SIDE_PANEL_TAB_IDS = ["home", "review", "context", "pulseInspector", SESSION_PREVIEW_TAB] as const

export type SidePanelTabID = (typeof SIDE_PANEL_TAB_IDS)[number]

export const DEFAULT_SIDE_PANEL_TAB_ORDER: SidePanelTabID[] = [...SIDE_PANEL_TAB_IDS]

const isSidePanelTabID = (value: unknown): value is SidePanelTabID =>
  typeof value === "string" && SIDE_PANEL_TAB_IDS.includes(value as SidePanelTabID)

export const normalizeSidePanelTabOrder = (value: unknown): SidePanelTabID[] => {
  const seen = new Set<SidePanelTabID>(["home"])
  const order: SidePanelTabID[] = ["home"]
  const persisted = Array.isArray(value)
    ? value.flatMap((tab) => {
        if (!isSidePanelTabID(tab) || seen.has(tab)) return []
        seen.add(tab)
        return [tab]
      })
    : []

  order.push(...persisted)

  for (const tab of SIDE_PANEL_TAB_IDS) {
    if (!seen.has(tab)) order.push(tab)
  }

  return order
}

export const reorderSidePanelTabs = (
  order: readonly SidePanelTabID[],
  tab: SidePanelTabID,
  toIndex: number,
): SidePanelTabID[] => {
  const next = normalizeSidePanelTabOrder(order)
  const fromIndex = next.indexOf(tab)
  if (fromIndex <= 0) return next

  const target = Math.max(1, Math.min(toIndex, next.length - 1))
  if (fromIndex === target) return next

  next.splice(target, 0, next.splice(fromIndex, 1)[0])
  return next
}
