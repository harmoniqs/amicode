import { describe, expect } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SkillV2 } from "@opencode-ai/core/skill"
import { SkillTool } from "@opencode-ai/core/tool/skill"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

// #1740: the skill tool re-reads the SKILL.md body per invocation, so a fresh
// edit is served even before the watcher invalidates the parse cache — the
// cache only pins name/description metadata between invalidations.

const it = testEffect(LayerNode.compile(FSUtil.node))

const skill = (location: string, content: string): SkillV2.Info => ({
  name: "my-skill",
  description: "does things",
  slash: undefined,
  location: AbsolutePath.make(location),
  content,
})

describe("SkillTool live content", () => {
  it.live("re-reads the skill body per invocation", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(Effect.promise(() => tmpdir()), (t) =>
        Effect.promise(() => t[Symbol.asyncDispose]()),
      )
      const file = path.join(tmp.path, "SKILL.md")
      yield* Effect.promise(() =>
        Bun.write(file, `---\nname: my-skill\ndescription: does things\n---\n\nfresh body\n`),
      )

      const fs = yield* FSUtil.Service
      const served = yield* SkillTool.liveContent(fs, skill(file, "stale body"))
      expect(served.content).toContain("fresh body")
      expect(served.name).toBe("my-skill")
    }),
  )

  it.live("falls back to the cached body when the file is gone", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(Effect.promise(() => tmpdir()), (t) =>
        Effect.promise(() => t[Symbol.asyncDispose]()),
      )
      const file = path.join(tmp.path, "missing", "SKILL.md")

      const fs = yield* FSUtil.Service
      const served = yield* SkillTool.liveContent(fs, skill(file, "cached body"))
      expect(served.content).toBe("cached body")
    }),
  )
})
