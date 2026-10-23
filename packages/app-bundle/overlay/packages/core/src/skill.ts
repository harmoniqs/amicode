export * as SkillV2 from "./skill"

import path from "path"
import { Cause, Context, Effect, Layer, Schema, Stream, Types } from "effect"
import { Skill } from "@opencode-ai/schema/skill"
import { AgentV2 } from "./agent"
import { ConfigMarkdown } from "./config/markdown"
import { makeLocationNode } from "./effect/app-node"
import { FSUtil } from "./fs-util"
import { Watcher } from "./filesystem/watcher"
import { EventV2 } from "./event"
import { PermissionV2 } from "./permission"
import { AbsolutePath } from "./schema"
import { SkillDiscovery } from "./skill/discovery"
import { State } from "./state"

export const DirectorySource = Skill.DirectorySource
export type DirectorySource = Skill.DirectorySource

export const UrlSource = Skill.UrlSource
export type UrlSource = Skill.UrlSource

export const EmbeddedSource = Skill.EmbeddedSource
export type EmbeddedSource = Skill.EmbeddedSource

export const Source = Skill.Source
export type Source = typeof Source.Type

export const Info = Skill.Info
export type Info = Skill.Info

export const available = (skills: ReadonlyArray<Info>, agent: AgentV2.Info) =>
  skills.filter((skill) => PermissionV2.evaluate("skill", skill.name, agent.permissions).effect !== "deny")

const Frontmatter = Schema.Struct({
  name: Schema.String.pipe(Schema.optional),
  description: Schema.String.pipe(Schema.optional),
  slash: Schema.Boolean.pipe(Schema.optional),
})
const decodeFrontmatter = Schema.decodeUnknownOption(Frontmatter)

export type Data = {
  sources: Types.DeepMutable<Source>[]
}

export type Draft = {
  source: (source: Source) => void
  list: () => readonly Source[]
}

export interface Interface extends State.Transformable<Draft> {
  readonly sources: () => Effect.Effect<Source[]>
  readonly list: () => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Skill") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const discovery = yield* SkillDiscovery.Service
    const fs = yield* FSUtil.Service
    const events = yield* EventV2.Service

    const state = State.create<Data, Draft>({
      initial: () => ({ sources: [] }),
      draft: (draft) => ({
        source: (source) => {
          if (draft.sources.some((item) => Source.equals(item, source))) return
          draft.sources.push(source as Types.DeepMutable<Source>)
        },
        list: () => draft.sources as Source[],
      }),
    })

    const load = Effect.fn("SkillV2.load")(function* (source: Source) {
      const skills: Info[] = []
      if (source.type === "embedded") return { skills: [source.skill], directories: [] as string[] }
      const directories = source.type === "directory" ? [source.path] : yield* discovery.pull(source.url)
      for (const directory of directories) {
        const files = yield* fs
          .glob("{*.md,**/SKILL.md}", { cwd: directory, absolute: true, include: "file", symlink: true, dot: true })
          .pipe(Effect.catch(() => Effect.succeed([] as string[])))
        for (const filepath of files.toSorted()) {
          const content = yield* fs.readFileStringSafe(filepath).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (!content) continue
          const markdown = ConfigMarkdown.parseOption(content)
          if (!markdown) continue
          const frontmatter = decodeFrontmatter(markdown.data).valueOrUndefined
          if (!frontmatter) continue
          const name =
            frontmatter.name !== undefined
              ? frontmatter.name
              : path.dirname(filepath) === directory
                ? path.basename(filepath, ".md")
                : undefined
          if (!name) continue
          skills.push({
            name,
            description: frontmatter.description,
            slash: frontmatter.slash,
            location: AbsolutePath.make(filepath),
            content: markdown.content,
          })
        }
      }
      return { skills, directories }
    })

    // Local skills are live (#1740): the Location-scoped filesystem watcher
    // publishes per-file events on the bus, and a debounced flush drops the
    // cache entry of every source whose directories contain a changed file,
    // so the next list() re-globs it. Watcher-disabled environments and files
    // outside every source directory keep the boot-frozen behavior. V1/TUI
    // (packages/opencode/src/skill) stays boot-frozen by design.
    const cache = new Map<string, { skills: Info[]; directories: string[] }>()
    const pending = new Set<string>()
    const flush = () => {
      if (pending.size === 0) return
      const files = Array.from(pending)
      pending.clear()
      for (const source of state.get().sources) {
        if (source.type === "embedded") continue
        const key = Source.key(source)
        const entry = cache.get(key)
        if (!entry) continue
        const directories = source.type === "directory" ? [source.path] : entry.directories
        if (directories.some((directory) => files.some((file) => FSUtil.contains(directory, file)))) {
          cache.delete(key)
        }
      }
    }
    yield* events
      .subscribe(Watcher.Event.Updated)
      .pipe(
        Stream.mapEffect((event) =>
          Effect.sync(() => {
            pending.add(event.data.file)
          }),
        ),
        // The flush is debounced, not the marking: every event lands in
        // `pending` immediately, and a save storm coalesces into one flush —
        // the reload itself is already lazy (one re-parse per invalidated
        // source, at the next list()).
        Stream.debounce("50 millis"),
        Stream.runForEach(() => Effect.sync(flush)),
        Effect.catchCause((cause) =>
          Effect.logError("skill cache invalidation stopped; skills stay boot-frozen until restart", {
            cause: Cause.pretty(cause),
          }),
        ),
        Effect.forkScoped,
      )

    const list = Effect.fn("SkillV2.list")(function* () {
      const skills = new Map<string, Info>()
      for (const source of state.get().sources) {
        const key = Source.key(source)
        const loaded = cache.get(key) ?? (yield* load(source))
        cache.set(key, loaded)
        for (const skill of loaded.skills) skills.set(skill.name, skill)
      }
      return Array.from(skills.values())
    })

    return Service.of({
      transform: state.transform,
      reload: state.reload,
      sources: Effect.fn("SkillV2.sources")(function* () {
        return state.get().sources
      }),
      list,
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [SkillDiscovery.node, FSUtil.node, EventV2.node] })
