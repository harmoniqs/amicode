import { describe, expect, test } from "bun:test"
import {
  createPreviewWorkspace,
  movePreviewTab,
  openPreviewPath,
  previewLeafByID,
  previewLeaves,
  previewMinimumExtent,
  reconcilePreviewPaths,
  removePreviewPath,
  setPreviewLeafZoom,
} from "./session-preview-tree"

describe("Preview workspace pane tree", () => {
  test("reorders a tab within its current leaf", () => {
    const workspace = createPreviewWorkspace(["notes/baseline.md", "notes/second.md"])

    const moved = movePreviewTab(workspace, {
      path: "notes/second.md",
      targetLeafID: "root",
      position: "center",
      targetIndex: 0,
    })

    expect(previewLeaves(moved.tree).map(({ tabs }) => tabs)).toEqual([["notes/second.md", "notes/baseline.md"]])
  })

  test("moves a tab into a focused right sibling leaf", () => {
    const workspace = createPreviewWorkspace(["notes/baseline.md", "notes/second.md"])

    const moved = movePreviewTab(workspace, {
      path: "notes/second.md",
      targetLeafID: "root",
      position: "right",
    })

    expect(
      previewLeaves(moved.tree).map(({ id, tabs, selectedPath, zoom }) => ({ id, tabs, selectedPath, zoom })),
    ).toEqual([
      { id: "root", tabs: ["notes/baseline.md"], selectedPath: "notes/baseline.md", zoom: 100 },
      { id: "pane-1", tabs: ["notes/second.md"], selectedPath: "notes/second.md", zoom: 100 },
    ])
    expect(moved.focusedLeafID).toBe("pane-1")
  })

  test("rejects an edge split that would empty a one-tab leaf", () => {
    const workspace = createPreviewWorkspace(["notes/only.md"])

    expect(
      movePreviewTab(workspace, {
        path: "notes/only.md",
        targetLeafID: "root",
        position: "right",
      }),
    ).toBe(workspace)
  })

  test("adds nested leaf minima along the split axis", () => {
    const initial = openPreviewPath(createPreviewWorkspace(["notes/one.md", "notes/two.md"]), "notes/three.md")
    const firstSplit = movePreviewTab(initial, {
      path: "notes/two.md",
      targetLeafID: "root",
      position: "right",
    })
    const nested = movePreviewTab(firstSplit, {
      path: "notes/three.md",
      targetLeafID: "pane-1",
      position: "right",
    })

    expect(previewMinimumExtent(nested.tree, "horizontal")).toBe(450)
    expect(previewMinimumExtent(nested.tree, "vertical")).toBe(150)
  })

  test("inherits source zoom on split and destination zoom on transfer", () => {
    const sourceZoomed = setPreviewLeafZoom(createPreviewWorkspace(["notes/one.md", "notes/two.md"]), "root", 130)
    const split = movePreviewTab(sourceZoomed, {
      path: "notes/two.md",
      targetLeafID: "root",
      position: "right",
    })

    expect(previewLeafByID(split.tree, "pane-1")?.zoom).toBe(130)
    const destinationZoomed = setPreviewLeafZoom(split, "root", 90)
    const transferred = movePreviewTab(destinationZoomed, {
      path: "notes/two.md",
      targetLeafID: "root",
      position: "center",
    })

    expect(previewLeafByID(transferred.tree, "root")?.zoom).toBe(90)
  })
})

// The flat list of open paths is what the session view persists and what the
// SessionPreviewTab restores from on reload/remount. These tests pin the
// round-trip invariant that restore depends on (split-pane layout is
// intentionally NOT persisted — only this flat list + the active tab).
describe("Preview open-paths persistence round-trip", () => {
  const openedPaths = (workspace: ReturnType<typeof createPreviewWorkspace>) =>
    previewLeaves(workspace.tree).flatMap((leaf) => leaf.tabs)

  test("restores the open-paths list in order, activating the last", () => {
    const paths = ["file://paper3.tex", "file://paper3.pdf"]
    const restored = createPreviewWorkspace(paths)
    expect(openedPaths(restored)).toEqual(paths)
    const root = previewLeafByID(restored.tree, restored.focusedLeafID)
    expect(root?.selectedPath).toBe("file://paper3.pdf")
  })

  test("an empty persisted list restores to an empty workspace", () => {
    const restored = createPreviewWorkspace([])
    expect(openedPaths(restored)).toEqual([])
    expect(previewLeafByID(restored.tree, restored.focusedLeafID)?.selectedPath).toBeNull()
  })

  test("re-opening the persisted active path after restore is idempotent (no duplicate)", () => {
    const restored = createPreviewWorkspace(["file://paper3.tex", "file://paper3.pdf"])
    const refocused = openPreviewPath(restored, "file://paper3.tex")
    expect(openedPaths(refocused)).toEqual(["file://paper3.tex", "file://paper3.pdf"])
    expect(previewLeafByID(refocused.tree, refocused.focusedLeafID)?.selectedPath).toBe("file://paper3.tex")
  })

  test("closing a tab shrinks the persisted list", () => {
    const restored = createPreviewWorkspace(["file://paper3.tex", "file://paper3.pdf"])
    const afterClose = removePreviewPath(restored, "file://paper3.pdf")
    expect(openedPaths(afterClose)).toEqual(["file://paper3.tex"])
  })
})

// reconcilePreviewPaths is the merge that restore uses. The first case is the
// exact regression behind "only the active file came back on reload": the
// persisted list has all N, but the previewFile effect has only opened the
// active one when reconcile runs — the union must still be all N.
describe("reconcilePreviewPaths", () => {
  test("restores the full persisted list when only the active file is open (the 1-of-N bug)", () => {
    expect(reconcilePreviewPaths(["a", "b", "c"], ["c"])).toEqual(["a", "b", "c"])
  })

  test("appends currently-open paths that were not persisted", () => {
    expect(reconcilePreviewPaths(["a", "b"], ["b", "d"])).toEqual(["a", "b", "d"])
  })

  test("keeps persisted order and de-duplicates when open is a subset", () => {
    expect(reconcilePreviewPaths(["a", "b", "c"], ["a", "c"])).toEqual(["a", "b", "c"])
  })

  test("an empty persisted list keeps whatever is currently open", () => {
    expect(reconcilePreviewPaths([], ["x"])).toEqual(["x"])
  })
})
