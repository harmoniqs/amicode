import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Layer, Option } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import path from "path"
import { ForbiddenError } from "../errors"
import { FileWriteBody, FileWriteWorkspaceMiddleware } from "../groups/file"
import { WorkspaceRouteContext } from "./workspace-routing"

/**
 * #1454 (W5): inspect the cached JSON body before the endpoint decoder and
 * reject only HTTP writes that resolve outside the routed workspace. Reading
 * `schemaBodyJson` is body-safe: Effect caches request text, so the unchanged
 * handler still receives and decodes the same FileWriteBody downstream.
 */
export const fileWriteWorkspaceLayer = Layer.succeed(
  FileWriteWorkspaceMiddleware,
  FileWriteWorkspaceMiddleware.of((effect) =>
    Effect.gen(function* () {
      const payload = yield* HttpServerRequest.schemaBodyJson(FileWriteBody).pipe(Effect.option)
      if (Option.isNone(payload)) return yield* effect

      const directory = (yield* WorkspaceRouteContext).directory
      const target = path.resolve(directory, payload.value.path)
      if (FSUtil.contains(directory, target)) return yield* effect

      return yield* new ForbiddenError({ message: "File write path must remain inside the workspace" })
    }),
  ),
)
