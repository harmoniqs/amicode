/**
 * The Preview workspace owns tab placement only. Renderer hosts remain a flat,
 * retained pool and are relocated between leaf slots without being recreated.
 */

import { createEffect, createSignal, For, on, onCleanup, onMount, Show, type Accessor, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { Portal } from "solid-js/web"
import { Icon } from "@opencode-ai/ui/icon"
import { Tabs } from "@opencode-ai/ui/tabs"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { usePlatform } from "@/context/platform"
import { PreviewFileView } from "./preview-file-view"
import { FileVisual } from "./session-sortable-tab"
import {
  createPreviewWorkspace,
  movePreviewTab,
  openPreviewPath,
  previewLeafContaining,
  previewLeaves,
  previewMinimumExtent,
  previewTabCount,
  removePreviewPath,
  resizePreviewSplit,
  selectPreviewPath,
  setPreviewLeafZoom,
  type PreviewDropPosition,
  type PreviewLeaf,
  type PreviewPane,
  type PreviewSplit,
} from "./session-preview-tree"

const MAX_PREVIEW_TABS = 8
const DROP_EDGE_PX = 32

type PreviewDrop = {
  leafID: string
  position: PreviewDropPosition
  targetIndex?: number
  sourceOffset?: number
  kind: "rail" | "pane"
}

type PreviewDrag = {
  path: string
  sourceLeafID: string
  width: number
  x: number
  y: number
  drop?: PreviewDrop
}

type PreviewRailReorder = {
  direction: "source" | "source-remote" | "left" | "right"
  width: number
  offset?: number
}

type PreviewLeafEdges = {
  top: boolean
  right: boolean
  bottom: boolean
  left: boolean
}

export function SessionPreviewTab(props: { previewFile: Accessor<string | null> }) {
  const platform = usePlatform()
  const [dirtyPaths, setDirtyPaths] = createStore<Record<string, boolean>>({})
  const [saveRequests, setSaveRequests] = createStore<Record<string, number>>({})
  const [workspace, setWorkspace] = createSignal(createPreviewWorkspace())
  const [capacityMessage, setCapacityMessage] = createSignal<string | null>(null)
  const [closingPath, setClosingPath] = createSignal<string | null>(null)
  const [previewDrag, setPreviewDrag] = createSignal<PreviewDrag | null>(null)
  const [dragProxy, setDragProxy] = createSignal<{ path: string; x: number; y: number; leaving: boolean } | null>(null)
  const [resizingSplitID, setResizingSplitID] = createSignal<string | null>(null)
  const [tabContextMenu, setTabContextMenu] = createSignal<{ path: string; x: number; y: number } | null>(null)

  const leafElements = new Map<string, HTMLElement>()
  const [hostMounts, setHostMounts] = createStore<Record<string, HTMLDivElement | undefined>>({})
  let stopPreviewDrag: (() => void) | undefined
  let dragProxyTimer: ReturnType<typeof setTimeout> | undefined

  const openedPaths = () => previewLeaves(workspace().tree).flatMap((leaf) => leaf.tabs)

  const openPath = (path: string) => {
    const current = workspace()
    if (!previewLeafContaining(current.tree, path) && previewTabCount(current.tree) === MAX_PREVIEW_TABS) {
      setCapacityMessage("Close an existing Preview tab before opening another file.")
      return
    }
    setWorkspace(openPreviewPath(current, path))
    setCapacityMessage(null)
  }

  createEffect(
    on(
      () => props.previewFile(),
      (path) => {
        if (path) openPath(path)
      },
    ),
  )

  onMount(() => {
    const handlePreviewFile = (event: MessageEvent) => {
      const data = event.data as { source?: string; kind?: string; path?: string } | undefined
      if (data?.source === "amicode" && data.kind === "preview-file" && data.path) openPath(data.path)
    }
    const focusLeafFromPointer = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return
      for (const [leafID, element] of leafElements) {
        if (!element.contains(event.target)) continue
        setWorkspace((current) => (current.focusedLeafID === leafID ? current : { ...current, focusedLeafID: leafID }))
        return
      }
    }
    window.addEventListener("message", handlePreviewFile)
    document.addEventListener("pointerdown", focusLeafFromPointer, true)
    onCleanup(() => {
      window.removeEventListener("message", handlePreviewFile)
      document.removeEventListener("pointerdown", focusLeafFromPointer, true)
    })
  })
  onCleanup(() => {
    stopPreviewDrag?.()
    if (dragProxyTimer) clearTimeout(dragProxyTimer)
  })

  const zoomForPath = (path: string) => previewLeafContaining(workspace().tree, path)?.zoom ?? 100
  const setZoomForPath = (path: string, value: number, maximum = 500) => {
    const leaf = previewLeafContaining(workspace().tree, path)
    if (leaf) setWorkspace((current) => setPreviewLeafZoom(current, leaf.id, value, maximum))
  }

  const removePath = (path: string) => {
    setWorkspace((current) => removePreviewPath(current, path))
    setDirtyPaths(path, false)
    setHostMounts(path, undefined)
  }

  const closePath = (path: string) => {
    if (dirtyPaths[path]) {
      setClosingPath(path)
      return
    }
    removePath(path)
  }

  const copyPreviewPath = async (value: string) => {
    if (platform.writeClipboardText && (await platform.writeClipboardText(value))) return
    try {
      await navigator.clipboard?.writeText(value)
    } catch {}
  }

  const openTabContextMenu = (event: MouseEvent, path: string) => {
    event.preventDefault()
    setTabContextMenu({ path, x: event.clientX, y: event.clientY })
  }

  const dropTargetAt = (
    clientX: number,
    clientY: number,
    path: string,
    sourceLeafID: string,
    sourceStartX: number,
    sourceGrabOffset: number,
  ): PreviewDrop | undefined => {
    for (const leaf of previewLeaves(workspace().tree)) {
      const element = leafElements.get(leaf.id)
      const rect = element?.getBoundingClientRect()
      if (
        !element ||
        !rect ||
        clientX < rect.left ||
        clientX > rect.right ||
        clientY < rect.top ||
        clientY > rect.bottom
      )
        continue

      const tabsList = element.querySelector<HTMLElement>('[data-slot="tabs-list"]')
      const tabsRect = tabsList?.getBoundingClientRect()
      if (
        tabsList &&
        tabsRect &&
        clientX >= tabsRect.left &&
        clientX <= tabsRect.right &&
        clientY >= tabsRect.top &&
        clientY <= tabsRect.bottom
      ) {
        const tabs = Array.from(element.querySelectorAll<HTMLElement>("[data-preview-tab]"))
        const sourceLeaf = previewLeaves(workspace().tree).find((candidate) => candidate.id === sourceLeafID)
        const insertionTabs = sourceLeaf?.id === leaf.id ? tabs.filter((tab) => tab.dataset.previewTab !== path) : tabs
        const targetIndex = insertionTabs.findIndex((tab) => {
          const midpoint = tabsRect.left + tab.offsetLeft - tabsList.offsetLeft + tab.offsetWidth / 2
          return clientX < midpoint
        })
        const insertionIndex = targetIndex === -1 ? insertionTabs.length : targetIndex
        const sourceOffset = sourceLeaf?.id === leaf.id ? clientX - sourceGrabOffset - sourceStartX : undefined
        return {
          leafID: leaf.id,
          position: "center",
          targetIndex: insertionIndex,
          sourceOffset,
          kind: "rail",
        }
      }

      const content = element.querySelector<HTMLElement>(".preview-pane-content")
      const contentRect = content?.getBoundingClientRect()
      if (!contentRect) return undefined

      const position: PreviewDropPosition =
        clientX - contentRect.left < DROP_EDGE_PX
          ? "left"
          : contentRect.right - clientX < DROP_EDGE_PX
            ? "right"
            : clientY - contentRect.top < DROP_EDGE_PX
              ? "top"
              : contentRect.bottom - clientY < DROP_EDGE_PX
                ? "bottom"
                : "center"

      if (position !== "center" && sourceLeafID === leaf.id && leaf.tabs.length === 1) return undefined

      if (position !== "center") return { leafID: leaf.id, position, kind: "pane" }

      const tabs = Array.from(element.querySelectorAll<HTMLElement>("[data-preview-tab]"))
      const targetIndex = tabs.findIndex((tab) => {
        const tabRect = tab.getBoundingClientRect()
        return clientX < tabRect.left + tabRect.width / 2
      })
      return { leafID: leaf.id, position, targetIndex: targetIndex === -1 ? tabs.length : targetIndex, kind: "pane" }
    }
    return undefined
  }

  const startPreviewDrag = (event: PointerEvent, path: string, sourceLeafID: string) => {
    event.stopPropagation()
    if (
      event.button !== 0 ||
      (event.target instanceof Element && event.target.closest('[data-slot="tabs-trigger-close-button"]'))
    )
      return

    const activeElement = document.activeElement
    const focusTarget =
      activeElement instanceof HTMLElement &&
      activeElement.closest("[data-preview-host]")?.getAttribute("data-preview-host") === path
        ? activeElement
        : undefined
    const focusScroller = focusTarget?.closest<HTMLElement>(".cm-scroller")
    const focusScrollTop = focusScroller?.scrollTop
    const origin = { x: event.clientX, y: event.clientY }
    let active = false
    const source = event.currentTarget as HTMLElement
    const sourceRect =
      source.closest<HTMLElement>("[data-preview-tab]")?.getBoundingClientRect() ?? source.getBoundingClientRect()
    const sourceWidth = sourceRect.width
    const sourceGrabOffset = event.clientX - sourceRect.left
    source.setPointerCapture?.(event.pointerId)
    const setDocumentDrag = (dragging: boolean) =>
      document.documentElement.toggleAttribute("data-preview-tab-dragging", dragging)

    const clearDragProxy = (fade: boolean) => {
      const proxy = dragProxy()
      if (!proxy) return
      if (!fade) {
        if (dragProxyTimer) clearTimeout(dragProxyTimer)
        dragProxyTimer = undefined
        setDragProxy(null)
        return
      }
      setDragProxy({ ...proxy, leaving: true })
      if (dragProxyTimer) clearTimeout(dragProxyTimer)
      dragProxyTimer = setTimeout(() => {
        setDragProxy(null)
        dragProxyTimer = undefined
      }, 160)
    }
    const stop = (fadeProxy = false) => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", onCancel)
      if (source.hasPointerCapture?.(event.pointerId)) source.releasePointerCapture(event.pointerId)
      stopPreviewDrag = undefined
      setPreviewDrag(null)
      setDocumentDrag(false)
      clearDragProxy(fadeProxy)
    }
    const onMove = (moveEvent: PointerEvent) => {
      if (!active) {
        if (Math.hypot(moveEvent.clientX - origin.x, moveEvent.clientY - origin.y) < 4) return
        active = true
        setDocumentDrag(true)
      }
      moveEvent.preventDefault()
      if (dragProxyTimer) clearTimeout(dragProxyTimer)
      dragProxyTimer = undefined
      const next = {
        path,
        sourceLeafID,
        width: sourceWidth,
        x: moveEvent.clientX,
        y: moveEvent.clientY,
        drop: dropTargetAt(moveEvent.clientX, moveEvent.clientY, path, sourceLeafID, sourceRect.left, sourceGrabOffset),
      }
      setPreviewDrag(next)
      setDragProxy(next.drop?.kind === "rail" ? null : { path, x: next.x, y: next.y, leaving: false })
    }
    const onUp = (upEvent: PointerEvent) => {
      const drop = active
        ? dropTargetAt(upEvent.clientX, upEvent.clientY, path, sourceLeafID, sourceRect.left, sourceGrabOffset)
        : undefined
      stop(!drop)
      if (!drop) return
      setWorkspace((current) =>
        movePreviewTab(current, {
          path,
          targetLeafID: drop.leafID,
          position: drop.position,
          targetIndex: drop.targetIndex,
        }),
      )
      requestAnimationFrame(() => {
        if (focusTarget?.isConnected) focusTarget.focus({ preventScroll: true })
        requestAnimationFrame(() => {
          if (focusScroller?.isConnected && focusScrollTop !== undefined) focusScroller.scrollTop = focusScrollTop
        })
      })
    }
    const onCancel = () => stop(true)

    stopPreviewDrag?.()
    stopPreviewDrag = stop
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", onCancel)
  }

  const isSelected = (path: string) => previewLeafContaining(workspace().tree, path)?.selectedPath === path

  const railReorder = (leaf: PreviewLeaf, path: string): PreviewRailReorder | undefined => {
    const drag = previewDrag()
    const drop = drag?.drop
    if (!drag || !drop || drop.kind !== "rail") return undefined

    const source = previewLeaves(workspace().tree).find((candidate) => candidate.id === drag.sourceLeafID)
    if (!source) return undefined
    const sourceIndex = source.tabs.indexOf(drag.path)
    if (sourceIndex === -1) return undefined

    if (leaf.id === source.id && path === drag.path) {
      const direction: PreviewRailReorder["direction"] = drop.leafID === source.id ? "source" : "source-remote"
      return {
        direction,
        width: drag.width,
        offset: drop.sourceOffset,
      }
    }

    const index = leaf.tabs.indexOf(path)
    if (index === -1) return undefined

    if (source.id === drop.leafID && leaf.id === source.id) {
      const targetIndex = Math.max(0, Math.min(drop.targetIndex ?? source.tabs.length - 1, source.tabs.length - 1))
      if (sourceIndex > targetIndex && index >= targetIndex && index < sourceIndex)
        return { direction: "right" as const, width: drag.width }
      if (sourceIndex < targetIndex && index > sourceIndex && index <= targetIndex)
        return { direction: "left" as const, width: drag.width }
      return undefined
    }

    return undefined
  }

  const startDividerResize = (event: PointerEvent, split: PreviewSplit) => {
    event.preventDefault()
    event.stopPropagation()
    const divider = event.currentTarget as HTMLElement
    const container = divider.parentElement
    if (!container) return
    const rect = container.getBoundingClientRect()
    const axis = split.direction
    const extent = axis === "horizontal" ? rect.width : rect.height
    const start = axis === "horizontal" ? rect.left : rect.top
    const firstMinimum = previewMinimumExtent(split.first, axis)
    const secondMinimum = previewMinimumExtent(split.second, axis)
    if (extent <= 0 || firstMinimum + secondMinimum > extent) return

    setResizingSplitID(split.id)
    divider.setPointerCapture?.(event.pointerId)
    const stop = () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", stop)
      if (divider.hasPointerCapture?.(event.pointerId)) divider.releasePointerCapture(event.pointerId)
      setResizingSplitID((current) => (current === split.id ? null : current))
    }
    const onMove = (moveEvent: PointerEvent) => {
      moveEvent.preventDefault()
      const coordinate = axis === "horizontal" ? moveEvent.clientX : moveEvent.clientY
      const ratio = Math.min(Math.max((coordinate - start) / extent, firstMinimum / extent), 1 - secondMinimum / extent)
      setWorkspace((current) => resizePreviewSplit(current, split.id, ratio))
    }
    const onUp = () => stop()

    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", stop)
  }

  const paneBranchStyle = (pane: PreviewPane, ratio: number) => ({
    flex: `${ratio} 1 0`,
    "--preview-branch-min-width": `${previewMinimumExtent(pane, "horizontal")}px`,
    "--preview-branch-min-height": `${previewMinimumExtent(pane, "vertical")}px`,
  })

  const renderPane = (
    pane: PreviewPane,
    edges: PreviewLeafEdges = { top: true, right: true, bottom: true, left: true },
  ): JSX.Element => {
    if (pane.kind === "leaf") return renderLeaf(pane, edges)
    const firstEdges = pane.direction === "horizontal" ? { ...edges, right: false } : { ...edges, bottom: false }
    const secondEdges = pane.direction === "horizontal" ? { ...edges, left: false } : { ...edges, top: false }
    return (
      <div data-preview-split data-direction={pane.direction} class="preview-pane-split">
        <div class="preview-pane-branch" style={paneBranchStyle(pane.first, pane.ratio)}>
          {renderPane(pane.first, firstEdges)}
        </div>
        <div
          role="separator"
          aria-label="Resize Preview panes"
          aria-orientation={pane.direction === "horizontal" ? "vertical" : "horizontal"}
          tabIndex={0}
          data-preview-divider={pane.id}
          data-resizing={resizingSplitID() === pane.id || undefined}
          data-direction={pane.direction}
          class="preview-pane-divider"
          onPointerDown={(event) => startDividerResize(event, pane)}
        />
        <div class="preview-pane-branch" style={paneBranchStyle(pane.second, 1 - pane.ratio)}>
          {renderPane(pane.second, secondEdges)}
        </div>
      </div>
    )
  }

  const renderLeaf = (leaf: PreviewLeaf, edges: PreviewLeafEdges): JSX.Element => {
    const activeDrop = () => {
      const drop = previewDrag()?.drop
      return drop?.kind === "pane" ? drop : undefined
    }
    const railGhost = () => {
      const drag = previewDrag()
      const drop = drag?.drop
      if (!drag || !drop || drop.kind !== "rail" || drop.leafID !== leaf.id || drag.sourceLeafID === leaf.id)
        return undefined
      return { path: drag.path, index: Math.max(0, Math.min(drop.targetIndex ?? leaf.tabs.length, leaf.tabs.length)) }
    }
    const RailGhost = () => {
      const ghost = railGhost()
      if (!ghost) return null
      return (
        <div data-preview-rail-drag-tab class="h-full flex items-center pointer-events-none" aria-hidden="true">
          <Tabs.Trigger value={ghost.path} tabIndex={-1}>
            <FileVisual path={ghost.path} active={false} explorerIconTheme />
          </Tabs.Trigger>
        </div>
      )
    }
    return (
      <section
        ref={(element) => leafElements.set(leaf.id, element)}
        data-preview-leaf={leaf.id}
        data-preview-edge-top={edges.top || undefined}
        data-preview-edge-right={edges.right || undefined}
        data-preview-edge-bottom={edges.bottom || undefined}
        data-preview-edge-left={edges.left || undefined}
        data-focused={workspace().focusedLeafID === leaf.id || undefined}
        class="preview-pane-leaf"
      >
        <Tabs
          value={leaf.selectedPath ?? undefined}
          onChange={(path) => setWorkspace((current) => selectPreviewPath(current, leaf.id, path))}
          class="shrink-0"
          classList={{ "preview-tab-strip": true }}
        >
          <Tabs.List aria-label="Open previews">
            <For each={leaf.tabs}>
              {(path, index) => {
                const reorder = () => railReorder(leaf, path)
                return (
                  <>
                    <Show when={railGhost()?.index === index()}>
                      <RailGhost />
                    </Show>
                    <div
                      data-preview-tab={path}
                      data-preview-reorder={reorder()?.direction}
                      class="h-full flex items-center"
                      style={
                        reorder()
                          ? {
                              "--preview-drag-width": `${reorder()!.width}px`,
                              "--preview-drag-offset": `${reorder()!.offset ?? 0}px`,
                            }
                          : undefined
                      }
                    >
                      <Tabs.Trigger
                        value={path}
                        onPointerDown={(event) => startPreviewDrag(event, path, leaf.id)}
                        onContextMenu={(event: MouseEvent) => openTabContextMenu(event, path)}
                        closeButton={
                          <button
                            type="button"
                            class="h-5 w-5 flex items-center justify-center text-text-weak hover:text-text-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-border-focus"
                            aria-label={`Close ${path.split("/").pop()}`}
                            onClick={() => closePath(path)}
                          >
                            <Show when={dirtyPaths[path]} fallback={<Icon name="close-small" size="small" />}>
                              <span
                                data-preview-unsaved
                                role="status"
                                aria-label="Unsaved changes"
                                class="w-2 h-2 rounded-full bg-v2-text-text-faint"
                              />
                            </Show>
                          </button>
                        }
                        hideCloseButton
                        onMiddleClick={() => closePath(path)}
                      >
                        <FileVisual path={path} active={leaf.selectedPath === path} explorerIconTheme />
                      </Tabs.Trigger>
                    </div>
                  </>
                )
              }}
            </For>
            <Show when={railGhost()?.index === leaf.tabs.length}>
              <RailGhost />
            </Show>
          </Tabs.List>
        </Tabs>

        <div
          ref={(element) => {
            for (const path of leaf.tabs) setHostMounts(path, element)
          }}
          class="preview-pane-content"
        />

        <Show when={activeDrop()?.leafID === leaf.id}>
          <div data-preview-drop-preview={activeDrop()!.position} class="preview-pane-drop-preview" />
        </Show>
      </section>
    )
  }

  return (
    <>
      <div class="h-full flex flex-col overflow-hidden">
        <Show when={dragProxy()}>
          {(proxy) => (
            <Portal>
              <div
                data-preview-tab-drag-proxy
                data-leaving={proxy().leaving || undefined}
                class="preview-tab-drag-proxy"
                aria-hidden="true"
                style={{
                  "--preview-drag-x": `${proxy().x}px`,
                  "--preview-drag-y": `${proxy().y}px`,
                }}
              >
                <FileVisual path={proxy().path} active={false} explorerIconTheme />
              </div>
            </Portal>
          )}
        </Show>
        <Show when={capacityMessage()}>
          <div class="shrink-0 px-3 py-2 text-12-regular text-text-weak" role="alert">
            {capacityMessage()}
          </div>
        </Show>

        <Show when={closingPath()}>
          {(path) => (
            <div
              class="shrink-0 mx-3 mb-3 p-3 border border-border-base rounded-md bg-background-base"
              role="dialog"
              aria-modal="true"
              aria-label="Unsaved changes"
            >
              <p class="text-12-regular text-text-base">Save changes to {path().split("/").pop()} before closing?</p>
              <div class="mt-2 flex justify-end gap-2">
                <button
                  type="button"
                  class="px-2 py-1 text-12-regular text-text-weak hover:text-text-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-border-focus"
                  onClick={() => setClosingPath(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  class="px-2 py-1 text-12-regular text-text-weak hover:text-text-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-border-focus"
                  onClick={() => {
                    removePath(path())
                    setClosingPath(null)
                  }}
                >
                  Discard
                </button>
                <button
                  type="button"
                  class="px-2 py-1 text-12-regular text-text-base border border-border-strong rounded-md hover:bg-background-stronger focus-visible:outline focus-visible:outline-2 focus-visible:outline-border-focus"
                  onClick={() => setSaveRequests(path(), (request) => (request ?? 0) + 1)}
                >
                  Save
                </button>
              </div>
            </div>
          )}
        </Show>

        <div data-preview-workspace class="flex-1 min-h-0 overflow-auto">
          <Show
            when={previewTabCount(workspace().tree) > 0}
            fallback={
              <div class="h-full flex flex-col items-center justify-center gap-3 text-text-weak p-6">
                <Icon name="open-file" class="w-8 h-8 text-v2-text-text-faint" />
                <p class="text-13-regular text-center">Select a file from the sidebar</p>
              </div>
            }
          >
            <div class="preview-workspace-canvas" data-preview-dragging={previewDrag()?.path}>
              <For each={[workspace().tree]}>{(pane) => renderPane(pane)}</For>
              <For each={openedPaths()}>
                {(path) => (
                  <Show when={hostMounts[path]}>
                    {(mount) => (
                      <Portal
                        mount={mount()}
                        ref={(container) => container.classList.add("preview-pane-renderer-mount")}
                      >
                        <div
                          data-preview-host={path}
                          class="h-full min-h-0"
                          hidden={!isSelected(path)}
                          style={{ display: isSelected(path) ? "flex" : "none" }}
                          aria-hidden={!isSelected(path)}
                          inert={!isSelected(path)}
                        >
                          <PreviewFileView
                            filePath={path}
                            onDirtyChange={(dirty) => setDirtyPaths(path, dirty)}
                            saveRequest={() => saveRequests[path] ?? 0}
                            onSaveComplete={() => {
                              removePath(path)
                              setClosingPath(null)
                            }}
                            zoom={() => zoomForPath(path)}
                            zoomIn={(maximum) => setZoomForPath(path, zoomForPath(path) + 10, maximum)}
                            zoomOut={() => setZoomForPath(path, zoomForPath(path) - 10)}
                            onZoomChange={(value, maximum) => setZoomForPath(path, value, maximum)}
                          />
                        </div>
                      </Portal>
                    )}
                  </Show>
                )}
              </For>
            </div>
          </Show>
        </div>
      </div>
      <MenuV2 open={!!tabContextMenu()} onOpenChange={(open) => !open && setTabContextMenu(null)}>
        <MenuV2.Portal>
          <MenuV2.Content
            class="fixed"
            style={{
              left: `${tabContextMenu()?.x ?? 0}px`,
              top: `${tabContextMenu()?.y ?? 0}px`,
            }}
          >
            <MenuV2.Item onSelect={() => void copyPreviewPath((tabContextMenu()?.path ?? "").split("/").at(-1) ?? "")}>
              Copy filename
            </MenuV2.Item>
            <MenuV2.Item onSelect={() => void copyPreviewPath(tabContextMenu()?.path ?? "")}>Copy filepath</MenuV2.Item>
          </MenuV2.Content>
        </MenuV2.Portal>
      </MenuV2>
    </>
  )
}
