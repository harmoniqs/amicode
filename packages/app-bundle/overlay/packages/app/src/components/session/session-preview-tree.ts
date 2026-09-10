export type PreviewLeaf = {
  kind: "leaf"
  id: string
  tabs: string[]
  selectedPath: string | null
  zoom: number
}

export type PreviewSplit = {
  kind: "split"
  id: string
  direction: "horizontal" | "vertical"
  ratio: number
  first: PreviewPane
  second: PreviewPane
}

export type PreviewPane = PreviewLeaf | PreviewSplit

export type PreviewWorkspace = {
  tree: PreviewPane
  focusedLeafID: string
  nextPaneID: number
}

export type PreviewDropPosition = "center" | "left" | "right" | "top" | "bottom"

export const PREVIEW_LEAF_MIN_SIZE = 150

export const createPreviewWorkspace = (paths: readonly string[] = []): PreviewWorkspace => ({
  tree: {
    kind: "leaf",
    id: "root",
    tabs: [...paths],
    selectedPath: paths.at(-1) ?? null,
    zoom: 100,
  },
  focusedLeafID: "root",
  nextPaneID: 1,
})

export const previewLeaves = (tree: PreviewPane): PreviewLeaf[] => {
  if (tree.kind === "leaf") return [tree]
  return [...previewLeaves(tree.first), ...previewLeaves(tree.second)]
}

export const previewTabCount = (tree: PreviewPane): number => previewLeaves(tree).reduce((count, leaf) => count + leaf.tabs.length, 0)

export const previewLeafByID = (tree: PreviewPane, leafID: string): PreviewLeaf | undefined =>
  previewLeaves(tree).find((leaf) => leaf.id === leafID)

export const previewLeafContaining = (tree: PreviewPane, path: string): PreviewLeaf | undefined =>
  previewLeaves(tree).find((leaf) => leaf.tabs.includes(path))

export const previewMinimumExtent = (tree: PreviewPane, axis: "horizontal" | "vertical"): number => {
  if (tree.kind === "leaf") return PREVIEW_LEAF_MIN_SIZE
  const first = previewMinimumExtent(tree.first, axis)
  const second = previewMinimumExtent(tree.second, axis)
  return tree.direction === axis ? first + second : Math.max(first, second)
}

const mapLeaf = (tree: PreviewPane, leafID: string, map: (leaf: PreviewLeaf) => PreviewPane): PreviewPane => {
  if (tree.kind === "leaf") return tree.id === leafID ? map(tree) : tree
  return {
    ...tree,
    first: mapLeaf(tree.first, leafID, map),
    second: mapLeaf(tree.second, leafID, map),
  }
}

const mapSplit = (tree: PreviewPane, splitID: string, map: (split: PreviewSplit) => PreviewSplit): PreviewPane => {
  if (tree.kind === "leaf") return tree
  return {
    ...tree,
    ...(tree.id === splitID ? map(tree) : {}),
    first: mapSplit(tree.first, splitID, map),
    second: mapSplit(tree.second, splitID, map),
  }
}

export const resizePreviewSplit = (workspace: PreviewWorkspace, splitID: string, ratio: number): PreviewWorkspace => ({
  ...workspace,
  tree: mapSplit(workspace.tree, splitID, (split) => ({ ...split, ratio: Math.min(Math.max(ratio, 0), 1) })),
})

const leafWithRemovedPath = (leaf: PreviewLeaf, path: string): PreviewLeaf => {
  const index = leaf.tabs.indexOf(path)
  if (index === -1) return leaf
  const tabs = leaf.tabs.filter((tab) => tab !== path)
  return {
    ...leaf,
    tabs,
    selectedPath: leaf.selectedPath === path ? tabs[index - 1] ?? tabs[index] ?? null : leaf.selectedPath,
  }
}

const collapseEmptyLeaves = (tree: PreviewPane): PreviewPane => {
  if (tree.kind === "leaf") return tree
  const first = collapseEmptyLeaves(tree.first)
  const second = collapseEmptyLeaves(tree.second)
  if (first.kind === "leaf" && first.tabs.length === 0) return second
  if (second.kind === "leaf" && second.tabs.length === 0) return first
  return { ...tree, first, second }
}

const reorderTabs = (tabs: readonly string[], path: string, toIndex: number): string[] => {
  const next = [...tabs]
  const fromIndex = next.indexOf(path)
  if (fromIndex === -1) return next
  const target = Math.max(0, Math.min(toIndex, next.length - 1))
  if (fromIndex === target) return next
  next.splice(target, 0, next.splice(fromIndex, 1)[0])
  return next
}

export const openPreviewPath = (workspace: PreviewWorkspace, path: string): PreviewWorkspace => {
  const existing = previewLeafContaining(workspace.tree, path)
  if (existing)
    return {
      ...workspace,
      focusedLeafID: existing.id,
      tree: mapLeaf(workspace.tree, existing.id, (leaf) => ({ ...leaf, selectedPath: path })),
    }

  const focused = previewLeafByID(workspace.tree, workspace.focusedLeafID) ?? previewLeaves(workspace.tree)[0]
  if (!focused) return workspace
  return {
    ...workspace,
    focusedLeafID: focused.id,
    tree: mapLeaf(workspace.tree, focused.id, (leaf) => ({ ...leaf, tabs: [...leaf.tabs, path], selectedPath: path })),
  }
}

export const selectPreviewPath = (workspace: PreviewWorkspace, leafID: string, path: string): PreviewWorkspace => {
  const leaf = previewLeafByID(workspace.tree, leafID)
  if (!leaf || !leaf.tabs.includes(path)) return workspace
  return {
    ...workspace,
    focusedLeafID: leafID,
    tree: mapLeaf(workspace.tree, leafID, (current) => ({ ...current, selectedPath: path })),
  }
}

export const setPreviewLeafZoom = (workspace: PreviewWorkspace, leafID: string, zoom: number, maximum = 500): PreviewWorkspace => ({
  ...workspace,
  tree: mapLeaf(workspace.tree, leafID, (leaf) => ({ ...leaf, zoom: Math.round(Math.min(Math.max(zoom, 50), Math.min(Math.max(maximum, 50), 1000))) })),
})

export const removePreviewPath = (workspace: PreviewWorkspace, path: string): PreviewWorkspace => {
  const source = previewLeafContaining(workspace.tree, path)
  if (!source) return workspace
  const tree = collapseEmptyLeaves(mapLeaf(workspace.tree, source.id, (leaf) => leafWithRemovedPath(leaf, path)))
  const focusedLeaf = previewLeafByID(tree, workspace.focusedLeafID) ?? previewLeaves(tree)[0]
  return { ...workspace, tree, focusedLeafID: focusedLeaf?.id ?? "root" }
}

export const movePreviewTab = (
  workspace: PreviewWorkspace,
  input: { path: string; targetLeafID: string; position: PreviewDropPosition; targetIndex?: number },
): PreviewWorkspace => {
  const source = previewLeafContaining(workspace.tree, input.path)
  const target = previewLeafByID(workspace.tree, input.targetLeafID)
  if (!source || !target) return workspace

  if (input.position === "center") {
    if (source.id === target.id)
      return {
        ...workspace,
        focusedLeafID: target.id,
        tree: mapLeaf(workspace.tree, target.id, (leaf) => ({
          ...leaf,
          tabs: input.targetIndex === undefined ? leaf.tabs : reorderTabs(leaf.tabs, input.path, input.targetIndex),
          selectedPath: input.path,
        })),
      }

    const withoutSource = collapseEmptyLeaves(mapLeaf(workspace.tree, source.id, (leaf) => leafWithRemovedPath(leaf, input.path)))
    return {
      ...workspace,
      focusedLeafID: target.id,
      tree: mapLeaf(withoutSource, target.id, (leaf) => ({
        ...leaf,
        tabs: [
          ...leaf.tabs.slice(0, Math.max(0, Math.min(input.targetIndex ?? leaf.tabs.length, leaf.tabs.length))),
          input.path,
          ...leaf.tabs.slice(Math.max(0, Math.min(input.targetIndex ?? leaf.tabs.length, leaf.tabs.length))),
        ],
        selectedPath: input.path,
      })),
    }
  }

  // A one-tab leaf cannot split itself: that would manufacture an empty sibling.
  if (source.id === target.id && source.tabs.length === 1) return workspace

  const withoutSource = collapseEmptyLeaves(mapLeaf(workspace.tree, source.id, (leaf) => leafWithRemovedPath(leaf, input.path)))
  const targetAfterRemoval = previewLeafByID(withoutSource, input.targetLeafID)
  if (!targetAfterRemoval) return workspace

  const newLeaf: PreviewLeaf = {
    kind: "leaf",
    id: `pane-${workspace.nextPaneID}`,
    tabs: [input.path],
    selectedPath: input.path,
    zoom: source.zoom,
  }
  const direction = input.position === "left" || input.position === "right" ? "horizontal" : "vertical"
  const newPaneBeforeTarget = input.position === "left" || input.position === "top"
  const split: PreviewSplit = {
    kind: "split",
    id: `split-${workspace.nextPaneID}`,
    direction,
    ratio: 0.5,
    first: newPaneBeforeTarget ? newLeaf : targetAfterRemoval,
    second: newPaneBeforeTarget ? targetAfterRemoval : newLeaf,
  }

  return {
    tree: mapLeaf(withoutSource, targetAfterRemoval.id, () => split),
    focusedLeafID: newLeaf.id,
    nextPaneID: workspace.nextPaneID + 1,
  }
}
