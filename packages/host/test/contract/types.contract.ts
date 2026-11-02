// Type-level contracts for the upstream symbols the host uses ONLY as types. Compiled by types.test.ts (and by
// `tsc`). Each block uses the symbol the way src/ does; test/contract/types.test.ts also checks that every type-only
// contract in registry.ts is mentioned here. If a bump renames or reshapes one, this file stops compiling.
import type { Plugin } from "@opencode/plugin"
import { fromPromise } from "@opencode/plugin/promise/adapter"
import type { Effect } from "effect"
import type { HttpServerResponse } from "effect/http"

// Plugin.Plugin = { id, setup(context) => cleanup | void }, and Plugin.Context carries the hook surface the plugin set
// (src/plugins/**) registers on. Mirrors permission.ts, context.ts and provider.ts.
export const plugin = {
  id: "contract.types",
  setup: async (context: Plugin.Context) => {
    const registrations = [
      await context.permission.hook("evaluate", (event) => {
        event.effect = event.effect === "deny" ? "deny" : "ask"
        event.message = `${event.action} ${event.resources.join(",")}`
      }),
      await context.session.hook("prompt", async (prompt) => {
        await context.session.instructions.entry.put({ sessionID: prompt.sessionID, key: "k", value: "v" })
        await context.session.instructions.entry.remove({ sessionID: prompt.sessionID, key: "k" })
      }),
      await context.session.hook("context", (request) => {
        request.system.push({ type: "text", text: `${request.agent} ${context.location.directory} ${request.sessionID}` })
        request.options.temperature ??= 0.5
      }),
      await context.session.hook("model.request", (request) => {
        request.headers["X-Session-Id"] = `${request.sessionID}${request.model.providerID}`
      }),
      await context.session.hook("http.request", (event) => void event.request),
      await context.tool.hook("execute.before", (event) => void [event.id, event.tool, event.sessionID, event.input]),
      await context.tool.hook("execute.after", (event) => void event.id),
      await context.shell.hook("create.before", (event) => {
        event.env.AMICO_SESSION_ID = event.command
      }),
    ]
    await context.model.transform((models) => void models.default.get())
    return async () => void (await Promise.all(registrations.map((registration) => registration.dispose())))
  },
} satisfies Plugin.Plugin

// A Plugin.Plugin can be handed to fromPromise (the seam's SdkPlugins.register argument).
export const adapted = fromPromise(plugin)

// Types the seam names from effect (server-seam.ts): Effect.Effect<HttpServerResponse.HttpServerResponse, unknown>.
export type RouterEffect = Effect.Effect<HttpServerResponse.HttpServerResponse, unknown>
