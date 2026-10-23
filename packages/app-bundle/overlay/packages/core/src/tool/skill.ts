export * as SkillTool from "./skill"

import path from "path"
import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { ConfigMarkdown } from "../config/markdown"
import { FSUtil } from "../fs-util"
import { SkillV2 } from "../skill"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "skill"
const FILE_LIMIT = 10

export const Input = Schema.Struct({
  name: Schema.String.annotate({ description: "The name of the skill from the available skills list" }),
})

export const Output = Schema.Struct({
  name: Schema.String,
  directory: Schema.String,
  output: Schema.String,
})

export const description = [
  "Load a specialized skill when the task at hand matches one of the available skills in the system context.",
  "",
  "Use this tool to inject the skill's instructions and resources into the current conversation. The output may contain detailed workflow guidance as well as references to scripts, files, etc. in the same directory as the skill.",
  "",
  "The skill name must match one of the available skills in the system context.",
].join("\n")

export const toModelOutput = (skill: SkillV2.Info, files: ReadonlyArray<string>) => {
  const directory = path.dirname(skill.location)
  return [
    `<skill_content name="${skill.name}">`,
    `# Skill: ${skill.name}`,
    "",
    skill.content.trim(),
    "",
    `Base directory for this skill: ${directory}`,
    "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
    "Note: file list is sampled.",
    "",
    "<skill_files>",
    ...files.map((file) => `<file>${file}</file>`),
    "</skill_files>",
    "</skill_content>",
  ].join("\n")
}

// #1740: the body is re-read from disk per invocation. The parse cache pins
// name/description metadata between watcher invalidations, but a merged body
// edit is served immediately — matching the fresh companion-file glob below. A
// failed read falls back to the cached body, never the tool's failure.
export const liveContent = (fs: FSUtil.Interface, skill: SkillV2.Info): Effect.Effect<SkillV2.Info> =>
  Effect.gen(function* () {
    const fresh = yield* fs.readFileStringSafe(skill.location).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (fresh === undefined) return skill
    const markdown = ConfigMarkdown.parseOption(fresh)
    if (!markdown) return skill
    return { ...skill, content: markdown.content }
  })

const unableToLoad = (name: string, error?: unknown) =>
  new ToolFailure({ message: `Unable to load skill ${name}`, error })

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const fs = yield* FSUtil.Service
    const skills = yield* SkillV2.Service
    const permission = yield* PermissionV2.Service
    yield* tools
      .register({
        [name]: Tool.make({
          description,
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: output.output }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const current = yield* skills.list()
              const skill = current.find((skill) => skill.name === input.name)
              if (!skill) return yield* unableToLoad(input.name)
              return yield* Effect.gen(function* () {
                yield* permission.assert({
                  action: name,
                  resources: [skill.name],
                  save: [skill.name],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                })
                const served = yield* liveContent(fs, skill)
                const directory = path.dirname(served.location)
                const files =
                  path.basename(served.location) === "SKILL.md"
                    ? (yield* fs.glob("**/*", { cwd: directory, absolute: true, include: "file", dot: true }))
                        .filter((file) => path.basename(file) !== "SKILL.md")
                        .toSorted()
                        .slice(0, FILE_LIMIT)
                    : []
                return {
                  name: served.name,
                  directory,
                  output: toModelOutput(served, files),
                }
              }).pipe(Effect.mapError((error) => unableToLoad(input.name, error)))
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/skill",
  layer,
  deps: [ToolRegistry.node, FSUtil.node, SkillV2.node, PermissionV2.node],
})
