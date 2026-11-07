// The cycle regression, order B — importing ../src/filesystem/search FIRST.
// This is the order that froze HARDEST pre-fix (a hard TDZ ReferenceError in
// the bundler's module interop; esbuild turns it into a silent undefined in
// production bundles). See cycle-order-a.filesystem-first.test.ts for the
// other order and the incident narrative.
import { describe, it, expect } from "bun:test"
import { node as searchNode } from "../../src/filesystem/search"
import { node } from "../../src/filesystem"

describe("filesystem/search import cycle (order B: search first)", () => {
  it("filesystem node's deps are fully defined — no undefined capture", () => {
    expect(node.dependencies).toBeDefined()
    for (const dep of node.dependencies as readonly { name: string }[]) {
      expect(dep).toBeDefined()
      expect(dep?.name).toBeTruthy()
    }
  })

  it("the search node itself is fully defined", () => {
    expect(searchNode).toBeDefined()
    expect(searchNode.dependencies).toBeDefined()
    for (const dep of searchNode.dependencies as readonly { name: string }[]) {
      expect(dep).toBeDefined()
    }
  })
})
