import { describe, expect, test } from "bun:test"
import {
  createPreviewWorkspace,
  movePreviewTab,
  openPreviewPath,
  previewLeafByID,
  previewLeaves,
  previewMinimumExtent,
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
