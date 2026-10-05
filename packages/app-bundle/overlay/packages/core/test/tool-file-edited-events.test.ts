import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer, Stream } from "effect"
import { FileSystem } from "@opencode-ai/schema/filesystem"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { FileMutation } from "@opencode-ai/core/file-mutation"
import { Location } from "@opencode-ai/core/location"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { EditTool } from "@opencode-ai/core/tool/edit"
import { WriteTool } from "@opencode-ai/core/tool/write"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import fs from "fs/promises"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { settleTool, toolIdentity } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_file_edited_events_test")

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.void,
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const withTools = <A, E, R>(directory: string, body: (registry: ToolRegistry.Interface) => Effect.Effect<A, E, R>) => {
  const activeLocation = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
  )
  return Effect.gen(function* () {
    return yield* body(yield* ToolRegistry.Service)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(
        LayerNode.group([
          ToolRegistry.node,
          ToolRegistry.toolsNode,
          LocationMutation.node,
          FileMutation.node,
          WriteTool.node,
          EditTool.node,
          EventV2.node,
        ]),
        [
          [Location.node, activeLocation],
          [PermissionV2.node, permission],
          [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
        ],
      ),
    ),
  )
}

const call = (name: "write" | "edit", input: unknown, id = `call-${name}`) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name, input },
})

const it = testEffect(Layer.empty)

describe("file.edited events", () => {
  // The publish lives in the FileMutation layer, so edit, write, and apply_patch
  // all emit the same existing FileSystem.Event.Edited with the canonical
  // (absolute) path. The EventV2 bus uses an unbounded pubsub, so a subscriber
  // that attaches late still receives a buffered event — the yieldNow guards
  // only against the subscriber never attaching (a hang → timeout → fail).
  it.live("WriteTool publishes file.edited with the canonical absolute path", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        withTools(tmp.path, (registry) =>
          Effect.gen(function* () {
            const events = yield* EventV2.Service
            const fiber = yield* events
              .subscribe(FileSystem.Event.Edited)
              .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
            yield* Effect.yieldNow

            const settled = yield* settleTool(
              registry,
              call("write", { path: "src/new.txt", content: "created" } satisfies typeof WriteTool.Input.Type),
            )
            const received = Array.from(yield* Fiber.join(fiber))

            expect(settled.result).toEqual({ type: "text", value: "Created file successfully: src/new.txt" })
            expect(received).toHaveLength(1)
            expect(received[0]?.type).toBe("file.edited")
            expect(received[0]?.data).toEqual({ file: path.join(tmp.path, "src/new.txt") })
          }),
        ),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("EditTool publishes file.edited with the canonical absolute path", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        const target = path.join(tmp.path, "hello.txt")
        return Effect.promise(() => fs.writeFile(target, "before\n")).pipe(
          Effect.andThen(
            withTools(tmp.path, (registry) =>
              Effect.gen(function* () {
                const events = yield* EventV2.Service
                const fiber = yield* events
                  .subscribe(FileSystem.Event.Edited)
                  .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
                yield* Effect.yieldNow

                const settled = yield* settleTool(
                  registry,
                  call("edit", {
                    path: "hello.txt",
                    oldString: "before",
                    newString: "after",
                  } satisfies typeof EditTool.Input.Type),
                )
                const received = Array.from(yield* Fiber.join(fiber))

                expect(settled.result).toMatchObject({ type: "text" })
                expect(received).toHaveLength(1)
                expect(received[0]?.type).toBe("file.edited")
                expect(received[0]?.data).toEqual({ file: target })
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
