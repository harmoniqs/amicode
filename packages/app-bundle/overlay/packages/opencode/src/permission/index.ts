import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import { InstanceState } from "@/effect/instance-state"
import { InstanceRef } from "@/effect/instance-ref"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { RuntimeState } from "@opencode-ai/core/runtime-state"
import { Clock, Deferred, Effect, Layer, Context, Schema } from "effect"
import os from "os"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { EventV2Bridge } from "@/event-v2-bridge"

export const Event = PermissionV1.Event

export interface Interface {
  readonly ask: (input: PermissionV1.AskInput) => Effect.Effect<void, PermissionV1.Error>
  readonly reply: (input: PermissionV1.ReplyInput) => Effect.Effect<void, PermissionV1.NotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<PermissionV1.Request>>
}

interface PendingEntry {
  info: PermissionV1.Request
  deferred: Deferred.Deferred<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>
}

interface State {
  pending: Map<PermissionV1.ID, PendingEntry>
  approved: PermissionV1.Rule[]
}

export function evaluate(permission: string, pattern: string, ...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule {
  return (
    rulesets
      .flat()
      .findLast((rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern)) ?? {
      action: "ask",
      permission,
      pattern: "*",
    }
  )
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Permission") {}

const decodeRequest = Schema.decodeUnknownOption(PermissionV1.Request)

const pendingDirectory = Effect.gen(function* () {
  const ctx = yield* InstanceRef
  return ctx ? ctx.directory : null
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("Permission.state")(function* (ctx) {
        void ctx
        const state = {
          pending: new Map<PermissionV1.ID, PendingEntry>(),
          approved: [],
        }

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const item of state.pending.values()) {
              yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
            }
            state.pending.clear()
          }),
        )

        return state
      }),
    )

    // ── shared-store plumbing (#1760 P2) ─────────────────────────────────────
    // The in-memory fast path stays authoritative; the store is the cross-
    // component truth so any instance can list or resolve a pending request.

    /** The memory-hit reply core: publish, settle the deferred, run the cascade. */
    const applyReply = Effect.fnUntraced(function* (input: PermissionV1.ReplyInput, existing: PendingEntry) {
      const { approved, pending } = yield* InstanceState.get(state)
      pending.delete(input.requestID)
      yield* events.publish(Event.Replied, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        reply: input.reply,
      })

      if (input.reply === "reject") {
        yield* Deferred.fail(
          existing.deferred,
          input.message
            ? new PermissionV1.CorrectedError({ feedback: input.message })
            : new PermissionV1.RejectedError(),
        )

        for (const [id, item] of pending.entries()) {
          if (item.info.sessionID !== existing.info.sessionID) continue
          pending.delete(id)
          yield* events.publish(Event.Replied, {
            sessionID: item.info.sessionID,
            requestID: item.info.id,
            reply: "reject",
          })
          yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
        }
        return
      }

      yield* Deferred.succeed(existing.deferred, undefined)
      if (input.reply === "once") return

      for (const pattern of existing.info.always) {
        approved.push({
          permission: existing.info.permission,
          pattern,
          action: "allow",
        })
      }

      for (const [id, item] of pending.entries()) {
        if (item.info.sessionID !== existing.info.sessionID) continue
        const ok = item.info.patterns.every(
          (pattern) => evaluate(item.info.permission, pattern, approved).action === "allow",
        )
        if (!ok) continue
        pending.delete(id)
        yield* events.publish(Event.Replied, {
          sessionID: item.info.sessionID,
          requestID: item.info.id,
          reply: "always",
        })
        yield* Deferred.succeed(item.deferred, undefined)
      }
    })

    /**
     * Resolves a pending request this instance does not hold in memory against
     * the shared row instead of one process's memory: a live pending row gets
     * its resolution recorded (the owning ask's reconcile loop applies it); an
     * already-settled row replays idempotently; a dead or unknown row is the
     * only honest "not found".
     */
    const replyThroughStore = Effect.fnUntraced(function* (input: PermissionV1.ReplyInput) {
      const runtime = RuntimeState.getGlobal()
      if (!runtime) return undefined
      const row = yield* RuntimeState.bestEffort(runtime.getPending("permission", input.requestID))
      if (row === undefined) return undefined
      if (row.state !== "pending") return "settled" as const
      const now = yield* Clock.currentTimeMillis
      if (row.time_heartbeat < now - RuntimeState.TTL_MS) {
        // The owner's heartbeat lapsed: nothing can consume a resolution.
        yield* Effect.logWarning("permission row expired with its owner", { requestID: input.requestID })
        return undefined
      }
      yield* RuntimeState.bestEffort(
        runtime.settlePending({
          kind: "permission",
          id: input.requestID,
          state: input.reply === "reject" ? "rejected" : "replied",
          resolution: { reply: input.reply, message: input.message },
        }),
      )
      return "recorded" as const
    })

    const reply = Effect.fn("Permission.reply")(function* (input: PermissionV1.ReplyInput) {
      const { pending } = yield* InstanceState.get(state)
      const existing = pending.get(input.requestID)
      if (existing) {
        // Settle the shared row BEFORE the deferred wakes the owning ask: its
        // exit cleanup only discards still-pending rows, and this ordering
        // guarantees the row is settled by the time that cleanup can run.
        const runtime = RuntimeState.getGlobal()
        if (runtime) {
          yield* RuntimeState.bestEffort(
            runtime.settlePending({
              kind: "permission",
              id: input.requestID,
              state: input.reply === "reject" ? "rejected" : "replied",
              resolution: { reply: input.reply, message: input.message },
            }),
          )
        }
        return yield* applyReply(input, existing)
      }
      const throughStore = yield* replyThroughStore(input)
      if (throughStore !== undefined) return
      yield* Effect.logWarning("reply for unknown request", { requestID: input.requestID })
      return yield* new PermissionV1.NotFoundError({ requestID: input.requestID })
    })

    /**
     * Keeps the shared row heartbeated while the ask waits, and applies a
     * resolution recorded by a mis-routed reply through the LOCAL reply, so
     * the always/once cascade runs in the owning instance where the
     * same-session pending map lives.
     */
    const reconcile = (
      id: PermissionV1.ID,
      deferred: Deferred.Deferred<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>,
    ) =>
      Effect.gen(function* () {
        const runtime = RuntimeState.getGlobal()
        if (!runtime) return yield* Deferred.await(deferred)
        let lastHeartbeat = 0
        for (;;) {
          const now = yield* Clock.currentTimeMillis
          if (now - lastHeartbeat >= RuntimeState.HEARTBEAT_INTERVAL_MS) {
            lastHeartbeat = now
            yield* RuntimeState.bestEffort(runtime.heartbeatPending({ kind: "permission", id }))
          }
          const row = yield* RuntimeState.bestEffort(runtime.getPending("permission", id))
          if (row && row.state !== "pending") {
            const resolution = (row.resolution ?? {}) as { reply?: PermissionV1.Reply; message?: string }
            if (resolution.reply !== undefined) {
              // Uninterruptible: succeeding the target's deferred lets the ask
              // win its raceFirst and interrupt this reconcile fiber — the
              // always/reject cascade that FOLLOWS the deferred wake must
              // complete before that interruption lands.
              yield* Effect.uninterruptible(
                reply({ requestID: id, reply: resolution.reply, message: resolution.message }),
              )
            }
            return
          }
          yield* Effect.sleep(RuntimeState.RECONCILE_INTERVAL_MS)
        }
      })

    const ask = Effect.fn("Permission.ask")(function* (input: PermissionV1.AskInput) {
      const { approved, pending } = yield* InstanceState.get(state)
      const { ruleset, ...request } = input
      let needsAsk = false

      for (const pattern of request.patterns) {
        const rule = evaluate(request.permission, pattern, ruleset, approved)
        yield* Effect.logInfo("evaluated", { permission: request.permission, pattern, action: rule })
        if (rule.action === "deny") {
          return yield* new PermissionV1.DeniedError({
            ruleset: ruleset.filter((rule) => Wildcard.match(request.permission, rule.permission)),
          })
        }
        if (rule.action === "allow") continue
        needsAsk = true
      }

      if (!needsAsk) return

      const id = request.id ?? PermissionV1.ID.ascending()
      const info: PermissionV1.Request = {
        id,
        sessionID: request.sessionID,
        permission: request.permission,
        patterns: request.patterns,
        metadata: request.metadata,
        always: request.always,
        tool: request.tool,
      }
      yield* Effect.logInfo("asking", { id, permission: info.permission, patterns: info.patterns })

      const deferred = yield* Deferred.make<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>()
      pending.set(id, { info, deferred })

      // Mirror the pending request into the shared store BEFORE the event, so
      // anything that observes permission.asked can also find the store row.
      const runtime = RuntimeState.getGlobal()
      if (runtime) {
        const directory = yield* pendingDirectory
        yield* RuntimeState.bestEffort(
          runtime.recordPending({ kind: "permission", id, sessionID: request.sessionID, directory, data: info }),
        )
      }
      yield* events.publish(Event.Asked, info)
      return yield* Effect.ensuring(
        Effect.raceFirst(Deferred.await(deferred), reconcile(id, deferred)),
        Effect.gen(function* () {
          pending.delete(id)
          // The owning ask exited: drop the row only while it is still
          // pending, so an already-settled row keeps its recorded state for
          // reply idempotency until the TTL prunes it.
          if (runtime) {
            yield* RuntimeState.bestEffort(runtime.discardPending({ kind: "permission", id }))
          }
        }),
      )
    })

    const list = Effect.fn("Permission.list")(function* () {
      const pending = (yield* InstanceState.get(state)).pending
      const memory = Array.from(pending.values(), (item) => item.info)
      const runtime = RuntimeState.getGlobal()
      if (!runtime) return memory
      const directory = yield* pendingDirectory
      const rows = yield* RuntimeState.bestEffort(runtime.livePending("permission"))
      if (rows === undefined) return memory
      // Memory is the truth for this instance's own rows; the store adds rows
      // held by other instances (same process, other directories) and other
      // processes entirely.
      const memoryIds = new Set(memory.map((item) => item.id))
      const merged: PermissionV1.Request[] = [...memory]
      for (const row of rows) {
        if (row.owner_id === RuntimeState.self.owner_id && row.directory === directory) continue
        if (memoryIds.has(row.id as PermissionV1.ID)) continue
        const decoded = decodeRequest(row.data)
        if (decoded._tag === "Some") merged.push(decoded.value)
      }
      return merged
    })

    return Service.of({ ask, reply, list })
  }),
)

function expand(pattern: string): string {
  if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
  if (pattern === "~") return os.homedir()
  if (pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5)
  if (pattern.startsWith("$HOME")) return os.homedir() + pattern.slice(5)
  return pattern
}

export function fromConfig(permission: ConfigPermissionV1.Info) {
  const ruleset: PermissionV1.Rule[] = []
  for (const [key, value] of Object.entries(permission)) {
    if (typeof value === "string") {
      ruleset.push({ permission: key, action: value, pattern: "*" })
      continue
    }
    ruleset.push(
      ...Object.entries(value).map(([pattern, action]) => ({ permission: key, pattern: expand(pattern), action })),
    )
  }
  return ruleset
}

export function merge(...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule[] {
  return rulesets.flat()
}

export function disabled(tools: string[], ruleset: PermissionV1.Ruleset): Set<string> {
  const edits = ["edit", "write", "apply_patch"]
  const reads = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]
  return new Set(
    tools.filter((tool) => {
      const permission = edits.includes(tool) ? "edit" : reads.includes(tool) ? "read" : tool
      const rule = ruleset.findLast((rule) => Wildcard.match(permission, rule.permission))
      return rule?.pattern === "*" && rule.action === "deny"
    }),
  )
}

export function visibleTools<T>(tools: Record<string, T>, ruleset: PermissionV1.Ruleset): Record<string, T> {
  const hidden = disabled(Object.keys(tools), ruleset)
  return Object.fromEntries(Object.entries(tools).filter(([name]) => !hidden.has(name)))
}

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2Bridge.node] })

export * as Permission from "."
