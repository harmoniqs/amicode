// Default-deny permission policy, on the v2 `permission.evaluate` hook (#2062, ADR 0039).
//
// Why a plugin: v2 agents default to allow-all, so with no policy an agent can run any shell command and edit any
// file. The engine evaluates configured rules first (a configured deny never reaches this hook), then triggers
// `evaluate` with its provisional `effect`; whatever the hook leaves in `effect` is final. This policy is
// tighten-only: a request needs a matching grant for EVERY resource or it is denied; a grant can keep or tighten
// the engine's effect but never loosen it (an `ask` stays an `ask`, a `deny` stays a `deny`).
import type { Plugin } from "@opencode/plugin"
import os from "node:os"
import path from "node:path"
import { match } from "./wildcard.ts"

export type Effect = "allow" | "ask" | "deny"
export interface Grant {
  readonly action: string
  readonly resource: string
  readonly effect: Effect
}
export interface PermissionPolicy {
  /** Last match wins, like the engine's own rulesets. */
  readonly grants: readonly Grant[]
}
export interface Request {
  readonly action: string
  readonly resources: readonly string[]
  readonly effect: string
}
export interface Decision {
  readonly effect: Effect
  readonly message?: string
}

const strictness: Record<Effect, number> = { allow: 0, ask: 1, deny: 2 }
const asEffect = (effect: string): Effect => (effect === "allow" || effect === "ask" || effect === "deny" ? effect : "deny")

export function decide(policy: PermissionPolicy, request: Request): Decision {
  const engine = asEffect(request.effect)
  if (engine === "deny") return { effect: "deny" }
  // An empty resource list (a pure action check) is judged against the catch-all resource.
  const resources = request.resources.length > 0 ? request.resources : ["*"]
  const grants = resources.map((resource) => ({
    resource,
    grant: [...policy.grants].reverse().find((g) => match(request.action, g.action) && match(resource, g.resource)),
  }))
  const missing = grants.find((g) => g.grant === undefined)
  if (missing) return { effect: "deny", message: `default-deny: no grant for ${request.action} on ${missing.resource}` }
  const strictest = grants.reduce<Effect>((worst, g) => (strictness[g.grant!.effect] > strictness[worst] ? g.grant!.effect : worst), engine)
  if (strictest === "deny") {
    const denied = grants.find((g) => g.grant!.effect === "deny")!
    return { effect: "deny", message: `denied by policy: ${request.action} on ${denied.resource}` }
  }
  return { effect: strictest }
}

/**
 * The out-of-the-box allowlist, drawn from what the v1 stack granted (`assembleOpencodeConfig`): read-only tools,
 * the user's question tool, and `external_directory` for the scratch and `~/.amico` roots the solve workflow
 * touches. Shell and general edits are deliberately NOT granted: an operator adds them, scoped, via the plugin
 * config. v2 action names: `bash`→`shell`, `write`/`patch`→`edit`, `task`→`subagent`.
 */
export function defaultPolicy(input: { home?: string; scratch?: string } = {}): PermissionPolicy {
  const home = input.home ?? os.homedir()
  const scratch = input.scratch ?? "/tmp/amicode-work"
  const amico = path.join(home, ".amico")
  return {
    grants: [
      { action: "read", resource: "*", effect: "allow" },
      { action: "glob", resource: "*", effect: "allow" },
      { action: "grep", resource: "*", effect: "allow" },
      { action: "question", resource: "*", effect: "allow" },
      { action: "subagent", resource: "*", effect: "allow" },
      { action: "webfetch", resource: "*", effect: "ask" },
      { action: "websearch", resource: "*", effect: "ask" },
      { action: "edit", resource: `${scratch}/**`, effect: "allow" },
      { action: "external_directory", resource: `${scratch}/**`, effect: "allow" },
      { action: "external_directory", resource: `/private${scratch}/**`, effect: "allow" },
      { action: "external_directory", resource: `${amico}/**`, effect: "allow" },
    ],
  }
}

export function permissionPlugin(policy: PermissionPolicy): Plugin.Plugin {
  return {
    id: "amicode.permission",
    setup: async (context) => {
      const registration = await context.permission.hook("evaluate", (event) => {
        const decision = decide(policy, event)
        event.effect = decision.effect
        if (decision.message !== undefined) event.message = decision.message
      })
      return () => registration.dispose()
    },
  }
}
