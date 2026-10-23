import { $ } from "bun"
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { ConfigProvider, Deferred, Effect, Fiber, Layer, Option, Stream } from "effect"
import type { Glob } from "@opencode-ai/core/util/glob"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { Config } from "@opencode-ai/core/config"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionContextEpoch } from "@opencode-ai/core/session/context-epoch"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { AgentV2 } from "@opencode-ai/core/agent"
import { SkillV2 } from "@opencode-ai/core/skill"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { SystemContext } from "@opencode-ai/core/system-context"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect, it } from "./lib/effect"

// Live skills (#1740): the per-source skill parse cache invalidates on
// filesystem watch events, so a merged SKILL.md edit reaches the next
// list()/invocation of a running session instead of waiting for a restart.

type WatcherEvent = { file: string; event: "add" | "change" | "unlink" }

const skillFile = (root: string, name: string, description: string, body: string) =>
  Effect.promise(() =>
    fs
      .mkdir(path.join(root, name), { recursive: true })
      .then(() =>
        fs.writeFile(
          path.join(root, name, "SKILL.md"),
          `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
        ),
      ),
  )

const rewrite = (root: string, name: string, description: string, body: string) =>
  Effect.promise(() =>
    fs.writeFile(path.join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`),
  )

const skillsOf = (list: readonly SkillV2.Info[]) =>
  Object.fromEntries(list.map((skill) => [skill.name, skill]))

const registerSource = (root: string) =>
  Effect.flatMap(SkillV2.Service, (skills) =>
    skills.transform((draft) => {
      draft.source(SkillV2.DirectorySource.make({ type: "directory", path: AbsolutePath.make(root) }))
    }),
  )

const publish = (file: string, event: "add" | "change" | "unlink") =>
  Effect.flatMap(EventV2.Service, (events) => events.publish(Watcher.Event.Updated, { file, event })).pipe(
    Effect.asVoid,
  )

const withTmp = <A, E, R>(use: (tmp: { path: string }) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(Effect.promise(() => tmpdir()), (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]())).pipe(
    Effect.flatMap(use),
  )

const globalLayer = [Global.node, Global.layerWith({ config: "/global" })] as const

const itSkill = testEffect(AppNodeBuilder.build(LayerNode.group([SkillV2.node, EventV2.node]), [globalLayer]))
const itGuidance = testEffect(
  AppNodeBuilder.build(LayerNode.group([SkillGuidance.node, SkillV2.node, EventV2.node, Database.node]), [globalLayer]),
)

describe("SkillV2 cache", () => {
  itSkill.live("serves fresh skills after a change event under the source directory", () =>
    withTmp((tmp) =>
      Effect.gen(function* () {
        const root = path.join(tmp.path, "skills")
        yield* skillFile(root, "my-skill", "old description", "old body")
        yield* registerSource(root)

        const skills = yield* SkillV2.Service
        const before = skillsOf(yield* skills.list())
        expect(before["my-skill"]?.description).toBe("old description")
        expect(before["my-skill"]?.content).toContain("old body")

        yield* rewrite(root, "my-skill", "new description", "new body")
        yield* publish(path.join(root, "my-skill", "SKILL.md"), "change")
        yield* Effect.sleep("200 millis")

        const after = skillsOf(yield* skills.list())
        expect(after["my-skill"]?.description).toBe("new description")
        expect(after["my-skill"]?.content).toContain("new body")
      }),
    ),
  )

  itSkill.live("ignores watch events for files outside the source directories", () =>
    withTmp((tmp) =>
      Effect.gen(function* () {
        const root = path.join(tmp.path, "skills")
        yield* skillFile(root, "my-skill", "old description", "old body")
        yield* registerSource(root)

        const skills = yield* SkillV2.Service
        expect(skillsOf(yield* skills.list())["my-skill"]?.description).toBe("old description")

        yield* rewrite(root, "my-skill", "new description", "new body")
        yield* publish(path.join(tmp.path, "unrelated.txt"), "change")
        yield* Effect.sleep("200 millis")

        expect(skillsOf(yield* skills.list())["my-skill"]?.description).toBe("old description")
      }),
    ),
  )

  itSkill.live("picks up added and removed skill directories on add/unlink events", () =>
    withTmp((tmp) =>
      Effect.gen(function* () {
        const root = path.join(tmp.path, "skills")
        yield* skillFile(root, "my-skill", "does things", "body")
        yield* registerSource(root)

        const skills = yield* SkillV2.Service
        expect((yield* skills.list()).map((skill) => skill.name)).toEqual(["my-skill"])

        yield* skillFile(root, "added-skill", "added later", "added body")
        yield* publish(path.join(root, "added-skill", "SKILL.md"), "add")
        yield* Effect.sleep("200 millis")
        expect((yield* skills.list()).map((skill) => skill.name)).toEqual(["added-skill", "my-skill"])

        yield* Effect.promise(() => fs.rm(path.join(root, "added-skill"), { recursive: true, force: true }))
        yield* publish(path.join(root, "added-skill", "SKILL.md"), "unlink")
        yield* Effect.sleep("200 millis")
        expect((yield* skills.list()).map((skill) => skill.name)).toEqual(["my-skill"])
      }),
    ),
  )

  // #1740 fail-safe floor: with no watch events the cache stays boot-frozen,
  // exactly like watcher-disabled environments (no native binding, flag off).
  itSkill.live("stays boot-frozen when no watch events arrive", () =>
    withTmp((tmp) =>
      Effect.gen(function* () {
        const root = path.join(tmp.path, "skills")
        yield* skillFile(root, "my-skill", "old description", "old body")
        yield* registerSource(root)

        const skills = yield* SkillV2.Service
        expect(skillsOf(yield* skills.list())["my-skill"]?.description).toBe("old description")

        yield* rewrite(root, "my-skill", "new description", "new body")
        yield* Effect.sleep("200 millis")

        expect(skillsOf(yield* skills.list())["my-skill"]?.description).toBe("old description")
      }),
    ),
  )
})

// Burst coalescing: the reload count (glob calls) is observable only through a
// counting FSUtil replacement, so this test drives its own layer tree.
describe("SkillV2 invalidation consumer", () => {
  it.live("coalesces an event burst into a single reload", () =>
    Effect.gen(function* () {
      const globs = { count: 0 }
      const countingFS = Layer.effect(
        FSUtil.Service,
        FSUtil.Service.pipe(
          Effect.map((fs) =>
            FSUtil.Service.of({
              ...fs,
              glob: (pattern: string, options?: Glob.Options) =>
                Effect.sync(() => {
                  globs.count++
                }).pipe(Effect.andThen(fs.glob(pattern, options))),
            }),
          ),
        ),
      ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))

      const layer = AppNodeBuilder.build(LayerNode.group([SkillV2.node, EventV2.node]), [
        globalLayer,
        [FSUtil.node, countingFS],
      ])
      yield* withTmp((tmp) =>
        Effect.gen(function* () {
          const root = path.join(tmp.path, "skills")
          yield* skillFile(root, "my-skill", "old description", "old body")
          yield* skillFile(root, "other-skill", "old description", "old body")
          yield* registerSource(root)

          const skills = yield* SkillV2.Service
          expect((yield* skills.list()).length).toBe(2)
          expect(globs.count).toBe(1)

          const file = path.join(root, "my-skill", "SKILL.md")
          yield* publish(file, "change")
          yield* publish(file, "change")
          yield* publish(path.join(root, "other-skill", "SKILL.md"), "change")
          yield* Effect.sleep("200 millis")
          expect((yield* skills.list()).length).toBe(2)

          // One burst → one debounced flush → one re-glob of the source.
          expect(globs.count).toBe(2)
        }),
      ).pipe(Effect.provide(layer), Effect.scoped)
    }),
  )

  it.live("stops consuming watch events when the location scope closes", () =>
    Effect.gen(function* () {
      const active = { count: 0 }
      const countingEvents = Layer.effect(
        EventV2.Service,
        EventV2.Service.pipe(
          Effect.map((real) =>
            EventV2.Service.of({
              ...real,
              subscribe: (definition) =>
                Stream.unwrap(
                  Effect.acquireRelease(
                    Effect.sync(() => {
                      active.count++
                    }),
                    () =>
                      Effect.sync(() => {
                        active.count--
                      }),
                  ).pipe(Effect.as(real.subscribe(definition))),
                ),
            }),
          ),
        ),
      ).pipe(Layer.provide(LayerNode.compile(EventV2.node)))

      const layer = AppNodeBuilder.build(LayerNode.group([SkillV2.node, EventV2.node]), [
        globalLayer,
        [EventV2.node, countingEvents],
      ])
      yield* withTmp((tmp) =>
        Effect.gen(function* () {
          const root = path.join(tmp.path, "skills")
          yield* skillFile(root, "my-skill", "does things", "body")
          yield* registerSource(root)

          const skills = yield* SkillV2.Service
          expect((yield* skills.list()).length).toBe(1)
          // The consumer's subscription is live for as long as the layer holds it.
          yield* Effect.sleep("100 millis")
          expect(active.count).toBe(1)
        }),
      ).pipe(Effect.provide(layer), Effect.scoped)

      // Location disposal interrupts the consumer — no dangling subscription.
      expect(active.count).toBe(0)
    }),
  )

  it.live("degrades to the frozen cache when the event stream fails", () =>
    Effect.gen(function* () {
      const attempts = { count: 0 }
      const failingEvents = Layer.effect(
        EventV2.Service,
        EventV2.Service.pipe(
          Effect.map((real) =>
            EventV2.Service.of({
              ...real,
              subscribe: (definition) =>
                Stream.unwrap(
                  Effect.acquireRelease(
                    Effect.sync(() => {
                      attempts.count++
                    }),
                    () => Effect.void,
                  ).pipe(Effect.as(Stream.fail(new Error("watch events unavailable")).pipe(Stream.orDie))),
                ),
            }),
          ),
        ),
      ).pipe(Layer.provide(LayerNode.compile(EventV2.node)))

      const layer = AppNodeBuilder.build(LayerNode.group([SkillV2.node, EventV2.node]), [
        globalLayer,
        [EventV2.node, failingEvents],
      ])
      yield* withTmp((tmp) =>
        Effect.gen(function* () {
          const root = path.join(tmp.path, "skills")
          yield* skillFile(root, "my-skill", "old description", "old body")
          yield* registerSource(root)

          const skills = yield* SkillV2.Service
          expect(skillsOf(yield* skills.list())["my-skill"]?.description).toBe("old description")
          yield* Effect.sleep("100 millis")
          // The consumer died (one attempt) but the service keeps serving.
          expect(attempts.count).toBe(1)
          expect(skillsOf(yield* skills.list())["my-skill"]?.description).toBe("old description")
        }),
      ).pipe(Effect.provide(layer), Effect.scoped)
    }),
  )
})

const selection = { id: AgentV2.ID.make("build"), info: AgentV2.Info.empty(AgentV2.ID.make("build")) }

describe("SkillGuidance epoch delivery", () => {
  itGuidance.live("reconciles a mid-session skill edit into a context update", () =>
    withTmp((tmp) =>
      Effect.gen(function* () {
        const root = path.join(tmp.path, "skills")
        yield* skillFile(root, "my-skill", "old description", "old body")
        yield* registerSource(root)

        const guidance = yield* SkillGuidance.Service
        const initialized = yield* SystemContext.initialize(yield* guidance.load(selection))
        expect(initialized.baseline).toContain("old description")

        yield* rewrite(root, "my-skill", "new description", "new body")
        yield* publish(path.join(root, "my-skill", "SKILL.md"), "change")
        yield* Effect.sleep("200 millis")

        const result = yield* SystemContext.reconcile(yield* guidance.load(selection), initialized.snapshot)
        expect(result).toMatchObject({ _tag: "Updated" })
        if (result._tag === "Updated") {
          expect(result.text).toContain("The available skills have changed")
          expect(result.text).toContain("new description")
        }
      }),
    ),
  )

  itGuidance.live("delivers the update through SessionContextEpoch as a ContextUpdated event", () =>
    withTmp((tmp) =>
      Effect.gen(function* () {
        const root = path.join(tmp.path, "skills")
        yield* skillFile(root, "my-skill", "old description", "old body")
        yield* registerSource(root)

        const { db } = yield* Database.Service
        const events = yield* EventV2.Service
        yield* db
          .insert(ProjectTable)
          .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        const sessionID = SessionV2.ID.make("ses_skill_live_epoch")
        yield* db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: Project.ID.global,
            slug: sessionID,
            directory: "/project",
            title: "test",
            version: "test",
          })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)

        const guidance = yield* SkillGuidance.Service
        const context = Effect.suspend(() => guidance.load(selection))
        const first = yield* SessionContextEpoch.prepare(db, events, context, sessionID)
        expect(first.baseline).toContain("old description")

        const updates: string[] = []
        const fiber = yield* events
          .subscribe(SessionEvent.ContextUpdated)
          .pipe(
            Stream.runForEach((event) =>
              Effect.sync(() => {
                updates.push(event.data.text)
              }),
            ),
            Effect.forkScoped,
          )

        yield* rewrite(root, "my-skill", "new description", "new body")
        yield* publish(path.join(root, "my-skill", "SKILL.md"), "change")
        yield* Effect.sleep("200 millis")

        const second = yield* SessionContextEpoch.prepare(db, events, context, sessionID)
        // The baseline is not rewritten — the change arrives as a separate
        // chronological ContextUpdated event, exactly as a session sees it.
        expect(second.baseline).toBe(first.baseline)
        expect(updates).toHaveLength(1)
        expect(updates[0]).toContain("The available skills have changed")
        expect(updates[0]).toContain("new description")

        yield* Fiber.interrupt(fiber)
      }),
    ),
  )
})

// End-to-end through the real @parcel/watcher binding: an actual disk edit (no
// synthetic bus publish) invalidates the cache.
const describeWatcher = Watcher.hasNativeBinding() && !process.env.CI ? describe : describe.skip

const waitForEvent = (check: (data: WatcherEvent) => boolean, trigger: Effect.Effect<void, unknown>) =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const deferred = yield* Deferred.make<WatcherEvent>()
    const fiber = yield* events
      .subscribe(Watcher.Event.Updated)
      .pipe(
        Stream.runForEach((event) => {
          if (!check(event.data)) return Effect.void
          return Deferred.succeed(deferred, event.data).pipe(Effect.asVoid)
        }),
        Effect.forkScoped,
      )
    yield* Effect.yieldNow
    const option = yield* trigger.pipe(
      Effect.andThen(Deferred.await(deferred)),
      Effect.timeoutOption("2 seconds"),
    )
    yield* Fiber.interrupt(fiber)
    return Option.isSome(option)
  })

describeWatcher("SkillV2 native watcher end-to-end", () => {
  it.live("invalidates the skill cache from real filesystem events", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(Effect.promise(() => tmpdir()), (t) =>
        Effect.promise(() => t[Symbol.asyncDispose]()),
      )
      const root = path.join(tmp.path, "skills")
      yield* skillFile(root, "my-skill", "old description", "old body")
      yield* Effect.promise(async () => {
        await $`git init`.cwd(tmp.path).quiet()
        await $`git config core.fsmonitor false`.cwd(tmp.path).quiet()
        await $`git config user.email test@opencode.test`.cwd(tmp.path).quiet()
        await $`git config user.name Test`.cwd(tmp.path).quiet()
        await $`git commit --allow-empty -m root`.cwd(tmp.path).quiet()
      })
      const vcs = { type: "git" as const, store: AbsolutePath.make(path.join(tmp.path, ".git")) }

      const configLayer = Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) }))
      const flagsLayer = ConfigProvider.layer(
        ConfigProvider.fromUnknown({ OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "false" }),
      )
      const locationLayer = Layer.succeed(
        Location.Service,
        Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) }, { vcs })),
      )
      const layer = AppNodeBuilder.build(
        LayerNode.group([Watcher.node, SkillV2.node, FSUtil.node, EventV2.node]),
        [
          [Config.node, configLayer],
          [Location.node, locationLayer],
          globalLayer,
        ],
      ).pipe(Layer.provide(flagsLayer))

      yield* Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        yield* registerSource(root)

        // Wait for the watcher subscription to go live before editing: retry
        // fresh probe files until one produces an event (bounded).
        const readyDeadline = Date.now() + 5_000
        let ready = false
        while (!ready && Date.now() < readyDeadline) {
          const probe = path.join(tmp.path, `.watcher-probe-${Math.random().toString(36).slice(2)}`)
          ready = yield* waitForEvent((data) => data.file === probe, fs.writeFileString(probe, "ready"))
          yield* fs.remove(probe, { force: true }).pipe(Effect.ignore)
        }
        expect(ready).toBe(true)

        const skills = yield* SkillV2.Service
        expect(skillsOf(yield* skills.list())["my-skill"]?.description).toBe("old description")

        yield* fs.writeFileString(
          path.join(root, "my-skill", "SKILL.md"),
          `---\nname: my-skill\ndescription: new description\n---\n\nnew body\n`,
        )

        // The real watcher publishes the change; the debounced consumer then
        // invalidates. Poll list() until the edit lands (bounded).
        const pollDeadline = Date.now() + 5_000
        let current = skillsOf(yield* skills.list())
        while (current["my-skill"]?.description !== "new description" && Date.now() < pollDeadline) {
          yield* Effect.sleep("100 millis")
          current = skillsOf(yield* skills.list())
        }
        expect(current["my-skill"]?.description).toBe("new description")
        expect(current["my-skill"]?.content).toContain("new body")
      }).pipe(Effect.provide(layer), Effect.scoped)
    }),
  )
})
