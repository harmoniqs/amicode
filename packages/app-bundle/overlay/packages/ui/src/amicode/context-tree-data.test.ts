import { describe, expect, test } from "bun:test"
import { buildContextTree, contextKind, vaultNodeLocked, vaultRefFromPath, type ContextTurn } from "./context-tree-data"

const turn = (id: string, refs: ContextTurn["refs"], busy = false): ContextTurn => ({
  id,
  refs,
  busy,
})

describe("contextKind", () => {
  test("maps types and extensions", () => {
    expect(contextKind({ label: "STRATEGY.md", type: "note", path: "/v/STRATEGY.md" })).toBe("note")
    expect(contextKind({ label: "solve.jl", type: "package", path: "/p/solve.jl" })).toBe("source")
    expect(contextKind({ label: "transmon", type: "skill" })).toBe("skill")
    expect(contextKind({ label: "Explore", type: "agent" })).toBe("agent")
    expect(contextKind({ label: "run solve", type: "experiment" })).toBe("action")
    expect(contextKind({ label: "arxiv.org", type: "resource" })).toBe("web")
  })
})

describe("vaultRefFromPath", () => {
  test("splits mount and relative path", () => {
    expect(vaultRefFromPath("/Users/k/.amico/vaults/armonissima/insights/x.md")).toEqual({
      mount: "armonissima",
      rel: "insights/x.md",
    })
    expect(vaultRefFromPath("/Users/k/project/src/x.ts")).toBeUndefined()
  })
})

// amicode#447: a vault path names the mount by its DIRECTORY segment, which
// the /amicode/vaults wire may key differently (marker `name`) — the lock
// decision must reconcile through the wire's dirName before failing closed.
describe("vaultNodeLocked", () => {
  const mounts = [
    { id: "aaron", browsable: true, dirName: "armonia-aaron-trowbridge" },
    { id: "armonissima", browsable: false, dirName: "armonissima" },
  ]

  test("dir≠name mounts unlock through their dirName identity", () => {
    expect(vaultNodeLocked({ mounts, vaultDir: "armonia-aaron-trowbridge" })).toBe(false)
  })

  test("non-browsable mounts lock through either identity; unknown locks", () => {
    expect(vaultNodeLocked({ mounts, vaultDir: "armonissima" })).toBe(true)
    expect(vaultNodeLocked({ mounts, vaultDir: "secret-mount" })).toBe(true)
  })

  test("an id-keyed wire without dirName still locks/unlocks by id", () => {
    const legacy = [{ id: "armonissima", browsable: false }]
    expect(vaultNodeLocked({ mounts: legacy, vaultDir: "armonissima" })).toBe(true)
    expect(vaultNodeLocked({ mounts: legacy, vaultDir: "armonia-aaron-trowbridge" })).toBe(true) // unknown → fail closed
  })

  test("no wire data never locks — the server still enforces the real gate", () => {
    expect(vaultNodeLocked({ mounts: undefined, vaultDir: "armonia-aaron-trowbridge" })).toBe(false)
  })
})

describe("buildContextTree", () => {
  test("root → turns → leaves; roman numerals only — never prompt text", () => {
    const tree = buildContextTree([
      turn("m1", [
        { label: "setup.jl", type: "package", path: "/p/setup.jl" },
        { label: "transmon", type: "skill" },
      ]),
      turn("m2", [{ label: "Explore", type: "agent" }]),
    ])
    expect(tree.kind).toBe("root")
    expect(tree.children!.map((t) => t.label)).toEqual(["I", "II"])
    expect(tree.children![0].children!.length).toBe(2)
  })
  test("consider refs (searches) never enter the tree", () => {
    const tree = buildContextTree([turn("m1", [{ label: "saveat", type: "resource", consider: true }])])
    expect(tree.children![0].children!.length).toBe(0)
  })
  test("a re-touched file dedups into a recall link, not a duplicate", () => {
    const tree = buildContextTree([
      turn("m1", [{ label: "solve.jl", type: "package", path: "/p/solve.jl" }]),
      turn("m2", [{ label: "solve.jl", type: "package", path: "/p/solve.jl" }]),
    ])
    const [t1, t2] = tree.children!
    expect(t1.children!.length).toBe(1)
    expect(t2.children!.length).toBe(0)
    expect(t2.recalls).toEqual([t1.children![0].id])
  })
  test("busy turn puts the live cursor on its newest leaf", () => {
    const tree = buildContextTree([
      turn(
        "m1",
        [
          { label: "a.md", type: "note", path: "/p/a.md" },
          { label: "b.md", type: "note", path: "/p/b.md" },
        ],
        true,
      ),
    ])
    const leaves = tree.children![0].children!
    expect(leaves[1].active).toBe(true)
    expect(leaves[0].active).toBeUndefined()
  })
  test("vault paths are flagged for the Vault panel", () => {
    const tree = buildContextTree([
      turn("m1", [{ label: "STRATEGY.md", type: "note", path: "/u/.amico/vaults/armonissima/STRATEGY.md" }]),
    ])
    expect(tree.children![0].children![0].vault).toBe(true)
  })
  test("vaultLocked marks non-browsable vault leaves locked; others untouched", () => {
    const tree = buildContextTree(
      [
        turn("m1", [
          { label: "STRATEGY.md", type: "note", path: "/u/.amico/vaults/armonissima/STRATEGY.md" },
          { label: "notes.md", type: "note", path: "/u/.amico/vaults/armonia-kate/notes.md" },
          { label: "solve.jl", type: "package", path: "/p/solve.jl" },
        ]),
      ],
      { vaultLocked: (mount) => mount === "armonissima" },
    )
    const [team, personal, project] = tree.children![0].children!
    expect(team.locked).toBe(true)
    expect(personal.locked).toBe(false)
    expect(project.locked).toBeUndefined() // not a vault file — predicate never consulted
  })
  test("marathon sessions fold old turns into one earlier branch", () => {
    const turns = Array.from({ length: 30 }, (_, i) =>
      turn(`m${i}`, [{ label: `f${i}.md`, type: "note", path: `/p/f${i}.md` }]),
    )
    const tree = buildContextTree(turns)
    expect(tree.children![0].id).toBe("turn-earlier")
    expect(tree.children!.length).toBe(25) // fold + last 24
    expect(tree.children![0].children!.length).toBe(6) // 30 - 24 folded refs
    // a later re-touch of a folded file recalls into the fold, not a dup
    const again = buildContextTree([...turns, turn("m30", [{ label: "f0.md", type: "note", path: "/p/f0.md" }])])
    const last = again.children![again.children!.length - 1]
    expect(last.children!.length).toBe(0)
    expect(last.recalls!.length).toBe(1)
  })
})
