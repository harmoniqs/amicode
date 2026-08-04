import { describe, it, expect } from "vitest";
import {
  createDeck,
  addTab,
  closeTab,
  activateTab,
  moveTab,
  splitTab,
  setTabLabel,
  resizeGroups,
  type Deck,
  type DeckTab,
} from "../src/deck/model";

// ============================================================================
// Deck pane model — the pure state machine under the Chat Deck webview.
// Panes are groups of tabs in a horizontal row; tabs drag between strips
// (move), onto a group's edge (split into a new group), and a group that
// loses its last tab collapses (merge-back). Immutable updates: every op
// returns a fresh Deck so the shell can diff-render.
// ============================================================================

const tab = (id: string, kind: DeckTab["kind"] = "session"): DeckTab => ({
  id,
  url: `http://127.0.0.1:43117/x/${id}`,
  label: id,
  kind,
});

/** Small fixture: two groups — g1[a,b] (a active), g2[c] — flex 2:1. */
function twoGroupDeck(): Deck {
  return {
    groups: [
      { id: "g1", tabs: [tab("a"), tab("b")], activeTabId: "a", flex: 2 },
      { id: "g2", tabs: [tab("c")], activeTabId: "c", flex: 1 },
    ],
  };
}

describe("deck model — tab lifecycle", () => {
  it("createDeck starts empty (the shell owns the first tab)", () => {
    expect(createDeck()).toEqual({ groups: [] });
  });

  it("addTab appends and activates the new tab and its group", () => {
    const d = addTab(createDeck(), "g1", tab("a"));
    expect(d.groups).toHaveLength(1);
    expect(d.groups[0].tabs.map((t) => t.id)).toEqual(["a"]);
    expect(d.groups[0].activeTabId).toBe("a");
  });

  it("addTab creates the group when it doesn't exist yet", () => {
    const d = addTab(createDeck(), "gNew", tab("a", "draft"));
    expect(d.groups[0].id).toBe("gNew");
    expect(d.groups[0].flex).toBe(1);
  });

  it("closeTab activates the left neighbor, then the right", () => {
    let d = closeTab(twoGroupDeck(), "g1", "a");
    expect(d.groups[0].activeTabId).toBe("b");
    d = closeTab(d, "g1", "b");
    // b was g1's last tab — the group collapses, leaving only g2[c].
    expect(d.groups.map((g) => g.id)).toEqual(["g2"]);
  });

  it("closeTab collapses a group that loses its last tab (merge-back)", () => {
    const d = closeTab(twoGroupDeck(), "g2", "c");
    expect(d.groups.map((g) => g.id)).toEqual(["g1"]);
  });

  it("closing the last tab of the last group yields an empty deck, never a negative one", () => {
    let d: Deck = { groups: [{ id: "g1", tabs: [tab("a")], activeTabId: "a", flex: 1 }] };
    d = closeTab(d, "g1", "a");
    expect(d.groups).toEqual([]);
  });

  it("activateTab switches only the target group's active tab", () => {
    const d = activateTab(twoGroupDeck(), "g1", "b");
    expect(d.groups[0].activeTabId).toBe("b");
    expect(d.groups[1].activeTabId).toBe("c");
  });
});

describe("deck model — drag physics", () => {
  it("moveTab reorders within a group (insertion index applies after removal)", () => {
    let d: Deck = {
      groups: [{ id: "g1", tabs: [tab("a"), tab("b"), tab("c")], activeTabId: "a", flex: 1 }],
    };
    d = moveTab(d, "g1", "a", "g1", 2);
    expect(d.groups[0].tabs.map((t) => t.id)).toEqual(["b", "c", "a"]);
    expect(d.groups[0].activeTabId).toBe("a"); // the dragged tab stays active
  });

  it("moveTab carries a tab across groups and collapses the emptied source", () => {
    const d = moveTab(twoGroupDeck(), "g2", "c", "g1", 1);
    expect(d.groups.map((g) => g.id)).toEqual(["g1"]);
    expect(d.groups[0].tabs.map((t) => t.id)).toEqual(["a", "c", "b"]);
    expect(d.groups[0].activeTabId).toBe("c"); // focus follows the dragged tab
  });

  it("splitTab docks the dragged tab into a NEW group on the given side", () => {
    const d = splitTab(twoGroupDeck(), "g1", "b", "g2", "right", "g3");
    expect(d.groups.map((g) => g.id)).toEqual(["g1", "g2", "g3"]);
    expect(d.groups[2].tabs.map((t) => t.id)).toEqual(["b"]);
    expect(d.groups[2].activeTabId).toBe("b");
    expect(d.groups[2].flex).toBe(1);
  });

  it("splitTab left inserts before the target group", () => {
    const d = splitTab(twoGroupDeck(), "g1", "b", "g2", "left", "g3");
    expect(d.groups.map((g) => g.id)).toEqual(["g1", "g3", "g2"]);
  });

  it("splitTab onto the tab's own single-tab group is a no-op (no phantom empty group)", () => {
    const d = splitTab(twoGroupDeck(), "g2", "c", "g2", "right", "g3");
    expect(d).toEqual(twoGroupDeck());
  });

  it("moveTab into a group where the tab already lives only reorders it", () => {
    const d = moveTab(twoGroupDeck(), "g1", "b", "g1", 0);
    expect(d.groups[0].tabs.map((t) => t.id)).toEqual(["b", "a"]);
    expect(d.groups[0].activeTabId).toBe("b");
  });
});

describe("deck model — labels & sizing", () => {
  it("setTabLabel renames a tab in place (route-info bridge)", () => {
    const d = setTabLabel(twoGroupDeck(), "c", "x-gate-transmon");
    expect(d.groups[1].tabs[0].label).toBe("x-gate-transmon");
    expect(d.groups[1].tabs[0].url).toContain("/x/c"); // url untouched
  });

  it("resizeGroups sets the two flexes and leaves other groups alone", () => {
    const d = resizeGroups(twoGroupDeck(), "g1", "g2", 1, 1);
    expect(d.groups[0].flex).toBe(1);
    expect(d.groups[1].flex).toBe(1);
  });

  it("ops never mutate the input deck (shell diff-render depends on it)", () => {
    const before = twoGroupDeck();
    const snapshot = JSON.parse(JSON.stringify(before));
    moveTab(before, "g2", "c", "g1", 0);
    expect(before).toEqual(snapshot);
  });
});
