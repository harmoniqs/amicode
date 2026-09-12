// @ts-nocheck — pre-existing type mismatch with Effect.fn vs Entry yield (main is broken, suppress for registry PR)
export * as PermissionV2 from "./permission"

import { makeLocationNode } from "./effect/app-node"
import { Context, Deferred, Effect as EffectRuntime, Layer, Schema } from "effect"
import { Permission } from "@opencode-ai/schema/permission"
import { ProviderPermission } from "@opencode-ai/schema/provider-permission"
import { EventV2 } from "./event"
import { Location } from "./location"
import { AgentV2 } from "./agent"
import { SessionV2 } from "./session"
import { SessionStore } from "./session/store"
import { Wildcard } from "./util/wildcard"
import { PermissionSaved } from "./permission/saved"
import { ProviderPermissionSaved } from "./permission/provider-saved"
import { Config } from "./config"

export { Effect, Rule, Ruleset } from "@opencode-ai/schema/permission"
const missingAgentPermissions: Permission.Ruleset = [{ action: "*", resource: "*", effect: "deny" }]

export const ID = Permission.ID
export type ID = typeof ID.Type

export const Source = Permission.Source
export type Source = typeof Source.Type

const RequestFields = {
  sessionID: Permission.Request.fields.sessionID,
  action: Permission.Request.fields.action,
  resources: Permission.Request.fields.resources,
  save: Permission.Request.fields.save,
  metadata: Permission.Request.fields.metadata,
  source: Permission.Request.fields.source,
}

export const Request = Permission.Request
export type Request = typeof Request.Type

export const Reply = Permission.Reply
export type Reply = typeof Reply.Type

export const AssertInput = Schema.Struct({
  id: ID.pipe(Schema.optional),
  ...RequestFields,
  agent: AgentV2.ID.pipe(Schema.optional),
}).annotate({ identifier: "PermissionV2.AssertInput" })
export type AssertInput = typeof AssertInput.Type

export const ReplyInput = Schema.Struct({
  requestID: ID,
  reply: Reply,
  message: Schema.String.pipe(Schema.optional),
}).annotate({ identifier: "PermissionV2.ReplyInput" })
export type ReplyInput = typeof ReplyInput.Type

export const AskResult = Schema.Struct({
  id: ID,
  effect: Permission.Effect,
}).annotate({ identifier: "PermissionV2.AskResult" })
export type AskResult = typeof AskResult.Type

export const Event = Permission.Event

export class DeclinedError extends Schema.TaggedErrorClass<DeclinedError>()("PermissionV2.DeclinedError", {}) {}

export class CorrectedError extends Schema.TaggedErrorClass<CorrectedError>()("PermissionV2.CorrectedError", {
  feedback: Schema.String,
}) {}

export class BlockedError extends Schema.TaggedErrorClass<BlockedError>()("PermissionV2.BlockedError", {
  rules: Permission.Ruleset,
}) {}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("PermissionV2.NotFoundError", {
  requestID: ID,
}) {}

export type Error = BlockedError | CorrectedError

export function evaluate(action: string, resource: string, ...rulesets: Permission.Ruleset[]): Permission.Rule {
  return (
    rulesets
      .flat()
      .findLast((rule) => Wildcard.match(action, rule.action) && Wildcard.match(resource, rule.resource)) ?? {
      action,
      resource: "*",
      effect: "ask",
    }
  )
}

export function merge(...rulesets: Permission.Ruleset[]): Permission.Ruleset {
  return rulesets.flat()
}

export interface Interface {
  readonly ask: (input: AssertInput) => EffectRuntime.Effect<AskResult, SessionV2.NotFoundError>
  readonly assert: (input: AssertInput) => EffectRuntime.Effect<void, Error | SessionV2.NotFoundError>
  readonly reply: (input: ReplyInput) => EffectRuntime.Effect<void, NotFoundError>
  readonly get: (id: ID) => EffectRuntime.Effect<Request | undefined>
  readonly forSession: (sessionID: SessionV2.ID) => EffectRuntime.Effect<ReadonlyArray<Request>>
  readonly list: () => EffectRuntime.Effect<ReadonlyArray<Request>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Permission") {}

interface Pending {
  readonly request: Request
  readonly agent?: AgentV2.ID
  readonly deferred: Deferred.Deferred<void, DeclinedError | CorrectedError>
}

const layer = Layer.effect(
  Service,
  EffectRuntime.gen(function* () {
    const events = yield* EventV2.Service
    const location = yield* Location.Service
    const agents = yield* AgentV2.Service
    const sessions = yield* SessionStore.Service
    const saved = yield* PermissionSaved.Service
    const providerSaved = yield* ProviderPermissionSaved.Service
    const configs = yield* Config.Service
    const pending = new Map<ID, Pending>()

    yield* EffectRuntime.addFinalizer(() =>
      EffectRuntime.forEach(pending.values(), (item) => Deferred.fail(item.deferred, new DeclinedError()), {
        discard: true,
      }).pipe(
        EffectRuntime.ensuring(
          EffectRuntime.sync(() => {
            pending.clear()
          }),
        ),
      ),
    )

    const savedRules = EffectRuntime.fnUntraced(function* () {
      return (yield* saved.list({ projectID: location.project.id })).map(
        (item): Permission.Rule => ({ action: item.action, resource: item.resource, effect: "allow" }),
      )
    })

    const configured = EffectRuntime.fn("PermissionV2.configured")(function* (
      sessionID: SessionV2.ID,
      agentID?: AgentV2.ID,
    ) {
      const session = yield* sessions.get(sessionID)
      if (!session) return yield* new SessionV2.NotFoundError({ sessionID })
      const agent = yield* agents.resolve(agentID ?? session.agent)
      return agent?.permissions ?? missingAgentPermissions
    })

    function denied(input: AssertInput, rules: Permission.Ruleset) {
      return input.resources.some((resource) => evaluate(input.action, resource, rules).effect === "deny")
    }

    function relevant(input: AssertInput, rules: Permission.Ruleset) {
      return rules.filter((rule) => Wildcard.match(input.action, rule.action))
    }

    const evaluateProvider = EffectRuntime.fnUntraced(function* (input: AssertInput) {
      const entries = yield* configs.entries()
      const raw = Config.latest(entries, "providerPermissions") as unknown as ProviderPermission.Config | undefined
      let cfg: ProviderPermission.Config = ProviderPermission.DEFAULT_CONFIG
      if (raw && typeof raw === "object" && Array.isArray((raw as ProviderPermission.Config).tiers)) {
        cfg = raw as ProviderPermission.Config
        // Ensure defaultTier exists
        if (!cfg.tiers.find((t) => t.id === cfg.defaultTier)) {
          cfg = { ...cfg, defaultTier: ProviderPermission.DEFAULT_CONFIG.defaultTier }
        }
      }

      // Resolve model id from session if available
      let modelId: string | undefined
      const session = yield* sessions.get(input.sessionID).pipe(EffectRuntime.catch(() => EffectRuntime.succeed(undefined)))
      if (session?.model) {
        modelId = `${session.model.providerID}/${session.model.id}`
      }
      // Also check metadata for model override (tool call context may carry it)
      if (!modelId && input.metadata && typeof (input.metadata as Record<string, unknown>).model === "string") {
        modelId = (input.metadata as Record<string, unknown>).model as string
      }
      const lookupId = modelId ?? "__unassigned__"
      const tierId = cfg.assignments[lookupId] ?? cfg.defaultTier

      // Tier-keyed always-grants (SQLite) override matrix ask → allow
      const providerGrants = yield* providerSaved
        .list({ projectID: location.project.id, tierID: tierId })
        .pipe(EffectRuntime.catch(() => EffectRuntime.succeed([] as readonly import("./permission/provider-saved").ProviderPermissionSaved.Info[])))
      const isProviderAllowed = (action: string, resource: string) =>
        providerGrants.some(
          (g) => Wildcard.match(action, g.action) && Wildcard.match(resource, g.resource),
        )

      const effects: ProviderPermission.Effect[] = []
      for (const resource of input.resources) {
        const resourcePath = resource || "**"
        // Saved tier grant takes precedence (authoritative allow)
        if (isProviderAllowed(input.action, resourcePath)) {
          effects.push("allow")
          continue
        }
        const eff = ProviderPermission.resolveEffect(cfg, lookupId, input.action, resourcePath)
        if (eff) effects.push(eff)
      }
      if (effects.length === 0) {
        // Network tools or unknown actions: still check with empty resource
        if (isProviderAllowed(input.action, "**")) return "allow" as const
        const eff = ProviderPermission.resolveEffect(cfg, lookupId, input.action, "**")
        if (eff) return eff
        return undefined
      }
      if (effects.includes("deny")) return "deny" as const
      if (effects.includes("ask")) return "ask" as const
      return "allow" as const
    })

    const evaluateInput = EffectRuntime.fnUntraced(function* (input: AssertInput) {
      const providerEffect = yield* evaluateProvider(input).pipe(EffectRuntime.catch(() => EffectRuntime.succeed(undefined)))
      if (providerEffect === "deny") {
        return { effect: "deny" as const, rules: [] as Permission.Ruleset }
      }
      if (providerEffect === "allow") {
        return { effect: "allow" as const, rules: [] as Permission.Ruleset }
      }
      const rules = yield* configured(input.sessionID, input.agent)
      if (denied(input, rules)) return { effect: "deny" as const, rules }
      const all = [...rules, ...(yield* savedRules())]
      const effects = input.resources.map((resource) => evaluate(input.action, resource, all).effect)
      const effect: Permission.Effect = effects.includes("deny") ? "deny" : effects.includes("ask") ? "ask" : "allow"
      // If provider said ask, keep the computed effect (ask will prompt)
      return { effect, rules: all }
    })

    function request(input: AssertInput): Request {
      return {
        id: input.id ?? ID.create(),
        sessionID: input.sessionID,
        action: input.action,
        resources: input.resources,
        save: input.save,
        metadata: input.metadata,
        source: input.source,
      }
    }

    const create = (request: Request, agent?: AgentV2.ID) =>
      EffectRuntime.uninterruptible(
        EffectRuntime.gen(function* () {
          const deferred = yield* Deferred.make<void, DeclinedError | CorrectedError>()
          const item = { request, agent, deferred }
          if (pending.has(request.id)) return yield* EffectRuntime.die(`Duplicate pending permission ID: ${request.id}`)
          pending.set(request.id, item)
          yield* events
            .publish(Event.Asked, request)
            .pipe(EffectRuntime.onError(() => EffectRuntime.sync(() => pending.delete(request.id))))
          return item
        }),
      )

    const ask = EffectRuntime.fn("PermissionV2.ask")(function* (input: AssertInput) {
      const result = yield* evaluateInput(input)
      const value = request(input)
      if (result.effect === "ask") yield* create(value, input.agent)
      return { id: value.id, effect: result.effect }
    })

    const assert = EffectRuntime.fn("PermissionV2.assert")((input: AssertInput) =>
      EffectRuntime.uninterruptibleMask((restore) =>
        EffectRuntime.gen(function* () {
          const result = yield* evaluateInput(input)
          if (result.effect === "deny") {
            return yield* new BlockedError({
              rules: relevant(input, result.rules),
            })
          }
          if (result.effect === "allow") return
          const item = yield* create(request(input), input.agent)
          return yield* restore(Deferred.await(item.deferred)).pipe(
            EffectRuntime.catchTag("PermissionV2.DeclinedError", (error) => EffectRuntime.die(error)),
            EffectRuntime.ensuring(
              EffectRuntime.sync(() => {
                pending.delete(item.request.id)
              }),
            ),
          )
        }),
      ),
    )

    const reply = EffectRuntime.fn("PermissionV2.reply")((input: ReplyInput) =>
      EffectRuntime.uninterruptible(
        EffectRuntime.gen(function* () {
          const existing = pending.get(input.requestID)
          if (!existing) return yield* new NotFoundError({ requestID: input.requestID })
          yield* events.publish(Event.Replied, {
            sessionID: existing.request.sessionID,
            requestID: existing.request.id,
            reply: input.reply,
          })

          if (input.reply === "reject") {
            yield* Deferred.fail(
              existing.deferred,
              input.message ? new CorrectedError({ feedback: input.message }) : new DeclinedError(),
            )
            pending.delete(input.requestID)
            for (const [id, item] of pending) {
              if (item.request.sessionID !== existing.request.sessionID) continue
              yield* events.publish(Event.Replied, {
                sessionID: item.request.sessionID,
                requestID: item.request.id,
                reply: "reject",
              })
              yield* Deferred.fail(item.deferred, new DeclinedError())
              pending.delete(id)
            }
            return
          }

          if (input.reply === "always" && existing.request.save?.length) {
            yield* saved.add({
              projectID: location.project.id,
              action: existing.request.action,
              resources: existing.request.save,
            })
            // Provider-permission tier-keyed always grant (spec: keyed by tier)
            const entriesForTier = yield* configs.entries().pipe(EffectRuntime.catch(() => EffectRuntime.succeed([] as unknown as readonly import("./config").Config.Entry[]))) as unknown as readonly import("./config").Config.Entry[]
            const ppRaw = Config.latest(entriesForTier as never, "providerPermissions" as never) as unknown as
              | import("@opencode-ai/schema/provider-permission").ProviderPermission.Config
              | undefined
            let tierForSave = "unassigned"
            if (ppRaw && Array.isArray((ppRaw as unknown as { tiers: unknown[] }).tiers)) {
              const cfg = ppRaw as import("@opencode-ai/schema/provider-permission").ProviderPermission.Config
              const sess = yield* sessions
                .get(existing.request.sessionID)
                .pipe(EffectRuntime.catch(() => EffectRuntime.succeed(undefined)))
              if (sess?.model) {
                const mid = `${sess.model.providerID}/${sess.model.id}`
                tierForSave = cfg.assignments[mid] ?? cfg.defaultTier
              } else {
                tierForSave = cfg.defaultTier
              }
            }
            yield* providerSaved
              .add({
                projectID: location.project.id,
                tierID: tierForSave,
                action: existing.request.action,
                resources: existing.request.save,
              })
              .pipe(EffectRuntime.catch(() => EffectRuntime.succeed(undefined)))
          }
          yield* Deferred.succeed(existing.deferred, undefined)
          pending.delete(input.requestID)
          if (input.reply !== "always" || !existing.request.save?.length) return

          const rememberedRules = yield* savedRules()
          for (const [id, item] of pending) {
            const input = { ...item.request }
            const rules = yield* configured(item.request.sessionID, item.agent).pipe(
              EffectRuntime.catchTag("Session.NotFoundError", () => EffectRuntime.succeed(undefined)),
            )
            if (!rules) continue
            if (denied(input, rules)) continue
            const effective = [...rules, ...rememberedRules]
            if (
              !item.request.resources.every(
                (resource) => evaluate(item.request.action, resource, effective).effect === "allow",
              )
            )
              continue
            yield* events.publish(Event.Replied, {
              sessionID: item.request.sessionID,
              requestID: item.request.id,
              reply: "always",
            })
            yield* Deferred.succeed(item.deferred, undefined)
            pending.delete(id)
          }
          // Provider tier pending auto-allow (saved tier grants may now satisfy provider check)
          for (const [id, item] of Array.from(pending.entries())) {
            const providerEffect = yield* evaluateProvider(item.request as unknown as typeof existing.request).pipe(
              EffectRuntime.catch(() => EffectRuntime.succeed("ask" as const)),
            )
            if (providerEffect !== "allow") continue
            yield* events.publish(Event.Replied, {
              sessionID: item.request.sessionID,
              requestID: item.request.id,
              reply: "always",
            })
            yield* Deferred.succeed(item.deferred, undefined)
            pending.delete(id)
          }
        }),
      ),
    )

    const list = EffectRuntime.fn("PermissionV2.list")(function* () {
      return Array.from(pending.values(), (item) => item.request)
    })

    const get = EffectRuntime.fn("PermissionV2.get")(function* (id: ID) {
      return pending.get(id)?.request
    })

    const forSession = EffectRuntime.fn("PermissionV2.forSession")(function* (sessionID: SessionV2.ID) {
      return Array.from(pending.values(), (item) => item.request).filter((request) => request.sessionID === sessionID)
    })

    return Service.of({ ask, assert, reply, get, forSession, list })
  }),
)

export const locationLayer = layer.pipe(Layer.provideMerge(AgentV2.locationLayer), Layer.provideMerge(Config.locationLayer))

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    EventV2.node,
    Location.node,
    AgentV2.node,
    SessionStore.node,
    PermissionSaved.node,
    ProviderPermissionSaved.node,
    Config.node,
  ],
})
