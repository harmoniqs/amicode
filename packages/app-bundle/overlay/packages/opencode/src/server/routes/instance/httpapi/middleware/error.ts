import { NamedError } from "@opencode-ai/core/util/error"
import { ConfigErrorV1 } from "@opencode-ai/core/v1/config/error"
import { Cause, Effect } from "effect"
import { HttpRouter, HttpServerError, HttpServerRespondable, HttpServerResponse } from "effect/unstable/http"

// Keep typed HttpApi failures on their declared error path; this boundary only replaces defect-only empty 500s.
export const errorLayer = HttpRouter.middleware<{ handles: unknown }>()((effect) =>
  effect.pipe(
    Effect.catchCause((cause) => {
      const defect = cause.reasons.filter(Cause.isDieReason).find((reason) => {
        if (HttpServerResponse.isHttpServerResponse(reason.defect)) return false
        if (HttpServerError.isHttpServerError(reason.defect)) return false
        if (HttpServerRespondable.isRespondable(reason.defect)) return false
        return true
      })
      if (!defect) return Effect.failCause(cause)

      const error = defect.defect
      if (
        ConfigErrorV1.JsonError.isInstance(error) ||
        ConfigErrorV1.InvalidError.isInstance(error) ||
        ConfigErrorV1.FrontmatterError.isInstance(error) ||
        ConfigErrorV1.DirectoryTypoError.isInstance(error)
      ) {
        return Effect.succeed(HttpServerResponse.jsonUnsafe(error.toObject(), { status: 400 }))
      }

      // amicode#1282: a stale model pin is a client-fixable config problem, not
      // a server fault — return it NAMED (the shape the app's error renderer
      // already formats) instead of the generic "Unexpected server error".
      // Duck-typed on the tag to keep provider.ts out of the middleware graph.
      if (isModelNotFound(error)) {
        return Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            {
              name: "ProviderModelNotFoundError",
              data: {
                providerID: error.providerID,
                modelID: error.modelID,
                suggestions: error.suggestions ?? [],
                message: error.message,
              },
            },
            { status: 400 },
          ),
        )
      }

      const ref = `err_${crypto.randomUUID().slice(0, 8)}`

      return Effect.logError("failed", { ref, error, cause: Cause.pretty(cause) }).pipe(
        Effect.as(
          HttpServerResponse.jsonUnsafe(
            new NamedError.Unknown({
              message: "Unexpected server error. Check server logs for details.",
              ref,
            }).toObject(),
            { status: 500 },
          ),
        ),
      )
    }),
  ),
).layer

type ModelNotFoundLike = {
  _tag: "ProviderModelNotFoundError"
  providerID: string
  modelID: string
  suggestions?: readonly string[]
  message: string
}

function isModelNotFound(error: unknown): error is ModelNotFoundLike {
  if (typeof error !== "object" || error === null) return false
  const e = error as Partial<ModelNotFoundLike>
  return e._tag === "ProviderModelNotFoundError" && typeof e.providerID === "string" && typeof e.modelID === "string"
}
