// The in-process plugin used to test criterion C7: it registers one RPC the harness can call over HTTP.
import { Plugin } from "@opencode/plugin/effect"
import { Effect, Schema } from "effect"

export const probePlugin = Plugin.define({
  id: "h0c-probe",
  effect: (ctx) =>
    ctx.rpc
      .register(
        { id: "h0c", methods: { ping: { input: Schema.Unknown, output: Schema.String } }, events: {} },
        { ping: () => Effect.succeed("pong-from-in-process-plugin") },
      )
      .pipe(Effect.asVoid, Effect.orDie),
})
