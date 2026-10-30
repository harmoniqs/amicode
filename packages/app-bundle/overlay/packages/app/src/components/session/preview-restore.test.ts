import { describe, expect, test } from "bun:test"
import {
  createPreviewPersister,
  createPreviewWorkspace,
  openPreviewPath,
  planPreviewRestore,
  previewActiveAfterClose,
  previewLeafContaining,
  previewLeaves,
  removePreviewPath,
  type PreviewWorkspace,
} from "./session-preview-tree"

// #1640 AC6: a simulation of the Preview persistence lifecycle — async store
// hydration, window reload / re-instantiation, close-then-switch, net-new open —
// asserting the persisted set. The harness wires the SAME pure decisions the
// SessionPreviewTab effect uses (planPreviewRestore + the persister + openPreviewPath).

type Store = { hydrated: boolean; paths: string[]; active: string | null; writes: number }

const openOf = (workspace: PreviewWorkspace) => previewLeaves(workspace.tree).flatMap((leaf) => leaf.tabs)

/** One mounted Preview instance reading/writing the shared persisted store. */
const mount = (store: Store) => {
  let workspace = createPreviewWorkspace()
  let last = ""
  const persist = createPreviewPersister({
    hydrated: () => store.hydrated,
    foreground: () => true,
    write: (paths) => {
      store.paths = Array.from(new Set(paths))
      store.writes++
    },
  })
  const sync = () => persist(openOf(workspace))
  const reconcile = () => {
    const plan = planPreviewRestore({
      last,
      hydrated: store.hydrated,
      persisted: store.paths,
      active: store.active,
      open: openOf(workspace),
    })
    if (!plan.run) return
    last = plan.signature
    for (const path of plan.missing) workspace = openPreviewPath(workspace, path)
    if (plan.missing.length > 0 && store.active) workspace = openPreviewPath(workspace, store.active)
    if (plan.persistNetNew) sync()
  }
  return {
    reconcile,
    open: (path: string) => {
      workspace = openPreviewPath(workspace, path)
      store.active = path
      sync()
    },
    close: (path: string) => {
      const wasActive = store.active
      workspace = removePreviewPath(workspace, path)
      sync()
      const next = previewActiveAfterClose(path, wasActive, openOf(workspace))
      if (next !== wasActive) store.active = next
    },
    tabs: () => openOf(workspace),
    selected: () => previewLeafContaining(workspace.tree, store.active ?? "")?.selectedPath ?? null,
  }
}

describe("Preview persistence lifecycle", () => {
  test("reload with N persisted files: all N return, the active one focused", () => {
    const store: Store = { hydrated: true, paths: ["a", "b", "c"], active: "b", writes: 0 }
    const view = mount(store)
    view.reconcile()
    expect(view.tabs().sort()).toEqual(["a", "b", "c"])
    expect(view.selected()).toBe("b")
    expect(store.writes).toBe(0) // restoring writes nothing
  })

  test("re-instantiation with everything already open reopens nothing and writes nothing", () => {
    const store: Store = { hydrated: true, paths: ["a", "b"], active: "a", writes: 0 }
    const view = mount(store)
    view.reconcile()
    const before = view.tabs()
    view.reconcile() // a second reactive pass over the same inputs
    expect(view.tabs()).toEqual(before)
    expect(store.writes).toBe(0)
  })

  test("close a tab, then a fresh instance (tab switch back) leaves it closed", () => {
    const store: Store = { hydrated: true, paths: ["a", "b", "c"], active: "b", writes: 0 }
    const first = mount(store)
    first.reconcile()
    first.close("b")
    expect(store.paths.sort()).toEqual(["a", "c"])
    expect(store.active).not.toBe("b")
    const second = mount(store)
    second.reconcile()
    expect(second.tabs().sort()).toEqual(["a", "c"])
  })

  test("close all, then reload: the Preview is empty and nothing reopens", () => {
    const store: Store = { hydrated: true, paths: ["a"], active: "a", writes: 0 }
    const first = mount(store)
    first.reconcile()
    first.close("a")
    expect(store).toMatchObject({ paths: [], active: null })
    const reloaded = mount(store)
    reloaded.reconcile()
    expect(reloaded.tabs()).toEqual([])
  })

  test("the first open into a closed Preview (net-new active) shows AND persists, once", () => {
    const store: Store = { hydrated: true, paths: [], active: "new.md", writes: 0 }
    const view = mount(store)
    view.reconcile()
    expect(view.tabs()).toEqual(["new.md"])
    expect(store.paths).toEqual(["new.md"])
    expect(store.writes).toBe(1)
    view.reconcile()
    expect(store.writes).toBe(1) // deduped: the persisted set now contains it
  })

  test("async hydration: a net-new open seen BEFORE hydration is persisted once the store hydrates (even if nothing else changed)", () => {
    const store: Store = { hydrated: false, paths: [], active: "first.md", writes: 0 }
    const view = mount(store)
    view.reconcile()
    expect(view.tabs()).toEqual(["first.md"]) // shown immediately
    expect(store.paths).toEqual([]) // the pre-hydration write is held…
    store.hydrated = true // …the store hydrates with nothing persisted for this session
    view.reconcile()
    expect(store.paths).toEqual(["first.md"]) // …and the held open lands now
  })

  test("async hydration: persisted files arrive late and are merged without clobbering", () => {
    const store: Store = { hydrated: false, paths: [], active: null, writes: 0 }
    const view = mount(store)
    view.reconcile()
    store.hydrated = true
    store.paths = ["a", "b"]
    store.active = "a"
    view.reconcile()
    expect(view.tabs().sort()).toEqual(["a", "b"])
    expect(store.writes).toBe(0)
  })
})

describe("planPreviewRestore", () => {
  test("is idempotent on unchanged inputs and treats hydration as an input", () => {
    const inputs = { persisted: ["a"], active: "a" as string | null, open: ["a"] }
    const pre = planPreviewRestore({ last: "", hydrated: false, ...inputs })
    expect(pre.run).toBe(true)
    expect(planPreviewRestore({ last: pre.signature, hydrated: false, ...inputs }).run).toBe(false)
    expect(planPreviewRestore({ last: pre.signature, hydrated: true, ...inputs }).run).toBe(true)
  })
})
