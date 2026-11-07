// The cycle regression, order A — importing ../src/filesystem FIRST.
// 2026-10-05 (#775/#1709): filesystem.ts captured FileSystemSearch.node into
// its node deps at module init while search.ts imported the FileSystem
// namespace back — under bun/esbuild cycle semantics the capture froze to
// undefined, crashing every per-directory location build (caught + swallowed
// per session prompt, leaking the half-built layer — the wedge driver at 8+
// parallel sessions). Each order gets its own test file because the freeze
// depends on which module of the cycle evaluates first; see
// cycle-order-b.search-first.test.ts for the other order.
import { describe, it, expect } from "bun:test"
import { node } from "../../src/filesystem"
import { node as searchNode } from "../../src/filesystem/search"

describe("filesystem/search import cycle (order A: filesystem first)", () => {
  it("filesystem node's deps are fully defined — no undefined capture", () => {
    expect(node.dependencies).toBeDefined()
    for (const dep of node.dependencies as readonly { name: string }[]) {
      expect(dep).toBeDefined()
      expect(dep?.name).toBeTruthy()
    }
  })

  it("the third dep is the search node, not undefined", () => {
    const deps = node.dependencies as readonly { name: string }[]
    expect(deps.map((d) => d.name)).toContain(searchNode.name)
  })
})
