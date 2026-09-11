// Issue #853 — the yellow-chunks port's durable docket token helpers.
import { describe, expect, test } from "vitest"
import { contextDocket, editDocket, shellDocket, type DocketPart } from "../../app-bundle/overlay/packages/ui/src/amicode/docket"

function part(tool: string, input: Record<string, unknown> = {}, status = "done", metadata: Record<string, unknown> = {}): DocketPart {
  return { tool, state: { status, input, metadata } }
}

function edit(filePath: string, additions = 0, deletions = 0): DocketPart {
  return part("edit", { filePath }, "done", { filediff: { additions, deletions } })
}

describe("editDocket (fork 6dac9ce04, ported)", () => {
  test("one token per unique file, ± summed across repeat edits", () => {
    const docket = editDocket([edit("/a/b/solve.jl", 5, 1), edit("/a/b/solve.jl", 7, 2), edit("/x/spec.toml", 4, 0)])
    expect(docket.more).toBe(0)
    expect(docket.tokens).toEqual([
      { kind: "file", name: "solve.jl", dir: "/a/b", additions: 12, deletions: 3 },
      { kind: "file", name: "spec.toml", dir: "/x", additions: 4, deletions: undefined },
    ])
  })

  test("caps at max and reports the rest", () => {
    const docket = editDocket(["a.ts", "b.ts", "c.ts", "d.ts"].map((f) => edit(`/p/${f}`)), 2)
    expect(docket.tokens).toHaveLength(2)
    expect(docket.more).toBe(2)
  })

  test("pending parts without a path contribute nothing", () => {
    expect(editDocket([part("edit")])).toEqual({ tokens: [], more: 0 })
  })

  test("a file edited with zero recorded diff still appears, without ±", () => {
    expect(editDocket([part("edit", { filePath: "/q/bare.jl" })])).toEqual({
      tokens: [{ kind: "file", name: "bare.jl", dir: "/q", additions: undefined, deletions: undefined }],
      more: 0,
    })
  })
})

describe("contextDocket (fork 6dac9ce04, ported)", () => {
  test("reads become file tokens, searches merge patterns, lists become dirs", () => {
    const parts = [
      part("read", { filePath: "/a/one.jl" }),
      part("grep", { pattern: "fidelity", path: "/a" }),
      part("grep", { pattern: "fidelity", path: "/a" }),
      part("list", { path: "/a/src" }),
    ]
    expect(contextDocket(parts)).toEqual({
      tokens: [
        { kind: "file", name: "one.jl" },
        { kind: "pattern", text: "fidelity", count: 2 },
        { kind: "dir", text: "/a/src" },
      ],
      more: 0,
    })
  })

  test("caps and counts the tail", () => {
    const docket = contextDocket(["x", "y", "z", "w"].map((p) => part("read", { filePath: `/${p}.jl` })), 2)
    expect(docket.tokens).toHaveLength(2)
    expect(docket.more).toBe(2)
  })
})

describe("shellDocket (fork 6dac9ce04, ported)", () => {
  test("counts commands and failures", () => {
    const parts = [part("bash"), part("bash"), part("bash", {}, "error")]
    expect(shellDocket(parts)).toEqual({ commands: 3, failed: 1 })
  })
})
