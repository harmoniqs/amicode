// ============================================================================
// Deck pane model — the pure state machine under the Chat Deck webview
// (dist/deck_shell.js). No DOM, no vscode: groups of tabs in a horizontal row.
// Tabs drag between strips (moveTab), onto a group's left/right edge
// (splitTab → a new group docks there), and a group that loses its last tab
// collapses (merge-back). Every op returns a FRESH Deck — the shell diff-
// renders from the returned value, and tests assert inputs are never mutated.
// ============================================================================

export type DeckTabKind = "home" | "draft" | "session";

export interface DeckTab {
  id: string;
  /** The iframe's current URL — shell-maintained from the route-info bridge. */
  url: string;
  label: string;
  kind: DeckTabKind;
}

export interface DeckGroup {
  id: string;
  tabs: DeckTab[];
  activeTabId?: string;
  /** flex-grow share of the row; proportions are relative across groups. */
  flex: number;
}

export interface Deck {
  groups: DeckGroup[];
}

export function createDeck(): Deck {
  return { groups: [] };
}

const cloneTab = (t: DeckTab): DeckTab => ({ ...t });
const cloneGroup = (g: DeckGroup): DeckGroup => ({ ...g, tabs: g.tabs.map(cloneTab) });
const cloneDeck = (d: Deck): Deck => ({ groups: d.groups.map(cloneGroup) });

/** Locate a tab: its group index, tab index, and the tab itself. */
function locate(deck: Deck, groupId: string, tabId: string): { gi: number; ti: number; tab: DeckTab } | undefined {
  const gi = deck.groups.findIndex((g) => g.id === groupId);
  if (gi === -1) return undefined;
  const ti = deck.groups[gi].tabs.findIndex((t) => t.id === tabId);
  if (ti === -1) return undefined;
  return { gi, ti, tab: deck.groups[gi].tabs[ti] };
}

/** Remove empty groups — the merge-back physics. */
function collapseEmpty(groups: DeckGroup[]): DeckGroup[] {
  return groups.filter((g) => g.tabs.length > 0);
}

export function addTab(deck: Deck, groupId: string, tab: DeckTab): Deck {
  const next = cloneDeck(deck);
  let g = next.groups.find((g) => g.id === groupId);
  if (!g) {
    g = { id: groupId, tabs: [], flex: 1 };
    next.groups.push(g);
  }
  g.tabs.push(tab);
  g.activeTabId = tab.id;
  return next;
}

export function closeTab(deck: Deck, groupId: string, tabId: string): Deck {
  const at = locate(deck, groupId, tabId);
  if (!at) return deck;
  const next = cloneDeck(deck);
  const g = next.groups[at.gi];
  g.tabs.splice(at.ti, 1);
  if (g.activeTabId === tabId) {
    // Prefer the left neighbor (VS Code's habit), else whatever remains first.
    g.activeTabId = (g.tabs[at.ti - 1] ?? g.tabs[0])?.id;
  }
  next.groups = collapseEmpty(next.groups);
  return next;
}

export function activateTab(deck: Deck, groupId: string, tabId: string): Deck {
  const at = locate(deck, groupId, tabId);
  if (!at) return deck;
  const next = cloneDeck(deck);
  next.groups[at.gi].activeTabId = tabId;
  return next;
}

/** Move a tab to `dstIndex` in `dstGroupId` — the index applies to the FINAL
 *  array (after removal), so reordering [a,b,c] moving a→2 yields [b,c,a].
 *  The dragged tab becomes active in the destination; an emptied source group
 *  collapses. */
export function moveTab(deck: Deck, srcGroupId: string, tabId: string, dstGroupId: string, dstIndex: number): Deck {
  const at = locate(deck, srcGroupId, tabId);
  if (!at) return deck;
  const next = cloneDeck(deck);
  const src = next.groups[at.gi];
  const [moving] = src.tabs.splice(at.ti, 1);
  const dst = next.groups.find((g) => g.id === dstGroupId);
  if (!dst) return deck;
  const clamped = Math.max(0, Math.min(dstIndex, dst.tabs.length));
  dst.tabs.splice(clamped, 0, moving);
  dst.activeTabId = moving.id;
  if (src !== dst && src.activeTabId === tabId) {
    src.activeTabId = src.tabs[0]?.id;
  }
  next.groups = collapseEmpty(next.groups);
  return next;
}

/** Split physics: dock `tabId` into a NEW group (`newGroupId`) inserted on
 *  `side` of `targetGroupId`. No-op when the tab already sits alone in the
 *  target group (dragging a lone tab onto its own edge). */
export function splitTab(
  deck: Deck,
  srcGroupId: string,
  tabId: string,
  targetGroupId: string,
  side: "left" | "right",
  newGroupId: string,
): Deck {
  const at = locate(deck, srcGroupId, tabId);
  const targetIndex = deck.groups.findIndex((g) => g.id === targetGroupId);
  if (!at || targetIndex === -1) return deck;
  if (srcGroupId === targetGroupId && deck.groups[at.gi].tabs.length === 1) return deck;
  const next = cloneDeck(deck);
  const src = next.groups[at.gi];
  const [moving] = src.tabs.splice(at.ti, 1);
  if (src.activeTabId === tabId) src.activeTabId = src.tabs[0]?.id;
  const insertAt = targetIndex + (side === "right" ? 1 : 0);
  next.groups.splice(insertAt, 0, { id: newGroupId, tabs: [moving], activeTabId: moving.id, flex: 1 });
  next.groups = collapseEmpty(next.groups);
  return next;
}

export function setTabLabel(deck: Deck, tabId: string, label: string): Deck {
  const next = cloneDeck(deck);
  for (const g of next.groups) {
    const t = g.tabs.find((t) => t.id === tabId);
    if (t) t.label = label;
  }
  return next;
}

/** Sash drag: set two adjacent groups' flexes; everyone else keeps theirs. */
export function resizeGroups(deck: Deck, leftId: string, rightId: string, leftFlex: number, rightFlex: number): Deck {
  const next = cloneDeck(deck);
  const l = next.groups.find((g) => g.id === leftId);
  const r = next.groups.find((g) => g.id === rightId);
  if (l) l.flex = leftFlex;
  if (r) r.flex = rightFlex;
  return next;
}
