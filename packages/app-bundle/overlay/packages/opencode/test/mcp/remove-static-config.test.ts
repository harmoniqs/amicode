import { expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { MCP } from "../../src/mcp/index"
import { testEffect } from "../lib/effect"

// amicode#1205 — MCP servers injected through OPENCODE_CONFIG_CONTENT (the
// extension bakes `slack` + `amicode` in at spawn) must not linger in the MCP
// section once they are removed. The static config is read-only for the life of
// the engine process, so a DELETE /mcp/<name> on a config-baked server used to
// close its client and then re-list it (red, toggleable) straight from the
// config: status() enumerates cfg.mcp. Removal is now sticky for the instance.
const it = testEffect(LayerNode.compile(MCP.node))

function withConfigContent<A, E, R>(content: unknown, effect: Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const original = process.env.OPENCODE_CONFIG_CONTENT
      process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify(content)
      return original
    }),
    () => effect,
    (original) =>
      Effect.sync(() => {
        if (original === undefined) delete process.env.OPENCODE_CONFIG_CONTENT
        else process.env.OPENCODE_CONFIG_CONTENT = original
      }),
  )
}

// `enabled: false` keeps the fixture hermetic (no process is spawned); the
// server is still a configured, listed MCP entry.
const baked = {
  $schema: "https://opencode.ai/config.json",
  mcp: {
    slack: { type: "local", command: ["slack-mcp-server"], enabled: false },
    amicode: { type: "local", command: ["amicode-mcp"], enabled: false },
  },
}

it.instance("a config-baked server is listed until it is removed, then stays gone", () =>
  withConfigContent(
    baked,
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      expect(Object.keys(yield* mcp.status()).sort()).toEqual(["amicode", "slack"])

      yield* mcp.remove("slack")
      expect(Object.keys(yield* mcp.status())).toEqual(["amicode"])
      // sticky — a second read (and a repeated remove) does not resurrect it
      yield* mcp.remove("slack")
      expect(Object.keys(yield* mcp.status())).toEqual(["amicode"])
    }),
  ),
)

it.instance("the amicode built-in MCP entry is untouched by removing another server", () =>
  withConfigContent(
    baked,
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      yield* mcp.remove("slack")
      expect((yield* mcp.status())["amicode"]?.status).toBe("disabled")
    }),
  ),
)

it.instance("runtime-added (user) servers are unaffected by removing a config-baked one", () =>
  withConfigContent(
    baked,
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      yield* mcp.add("mine", { type: "local", command: ["my-mcp"], enabled: false })
      yield* mcp.remove("slack")
      expect(Object.keys(yield* mcp.status()).sort()).toEqual(["amicode", "mine"])
    }),
  ),
)

it.instance("re-adding a removed config-baked name lists it again", () =>
  withConfigContent(
    baked,
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      yield* mcp.remove("slack")
      expect(Object.keys(yield* mcp.status())).toEqual(["amicode"])
      yield* mcp.add("slack", { type: "local", command: ["slack-mcp-server"], enabled: false })
      expect(Object.keys(yield* mcp.status()).sort()).toEqual(["amicode", "slack"])
    }),
  ),
)
