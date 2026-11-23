// #2131: a content search over a file with a line longer than ripgrep's 64 KB
// JSON record cap must return the other matches instead of failing the whole
// search with "Ripgrep JSON record exceeded 65536 bytes".
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { RelativePath } from "@opencode-ai/core/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([CrossSpawnSpawner.node, Ripgrep.node])))

describe("Ripgrep.grep over very long lines (#2131)", () => {
  it.live("skips an over-long match record and returns the rest of the matches", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const longLine = "needle " + "x".repeat(200 * 1024)
      yield* Effect.promise(() =>
        fs.writeFile(path.join(dir, "data.txt"), ["first needle", longLine, "last needle", ""].join("\n")),
      )
      yield* Effect.promise(() => fs.writeFile(path.join(dir, "other.txt"), "needle elsewhere\n"))

      const matches = yield* (yield* Ripgrep.Service).grep({ cwd: dir, pattern: "needle", limit: 50 })

      const data = matches.filter((m) => m.entry.path === RelativePath.make("data.txt")).map((m) => m.line)
      expect(data).toContain(1)
      expect(data).toContain(3)
      expect(matches.map((m) => m.entry.path)).toContain(RelativePath.make("other.txt"))
    }),
  )
})
