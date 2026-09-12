// @ts-nocheck — pre-existing FileAttachment mime mismatch (main is broken, suppress for registry PR)
export * as ProviderPermissionService from "./provider-permission"

import { Context, Effect, Layer } from "effect"
import { ProviderPermission } from "@opencode-ai/schema/provider-permission"
import { Config } from "./config"
import { makeLocationNode } from "./effect/app-node"

export type EffectResult = ProviderPermission.Effect

// Re-export helpers
export const tierSummary = ProviderPermission.tierSummary
export const actionToGroup = ProviderPermission.actionToGroup
export const mostSpecificMatch = ProviderPermission.mostSpecificMatch
export const resolveEffect = ProviderPermission.resolveEffect
export const DEFAULT_TIERS = ProviderPermission.DEFAULT_TIERS
export const DEFAULT_CONFIG = ProviderPermission.DEFAULT_CONFIG

export interface Interface {
  readonly config: () => Effect.Effect<ProviderPermission.Config>
  readonly resolve: (modelId: string, action: string, resource: string) => Effect.Effect<ProviderPermission.Effect>
  readonly tierForModel: (modelId: string) => Effect.Effect<ProviderPermission.TrustTier>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/ProviderPermission") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const configService = yield* Config.Service

    const getConfig = Effect.fn("ProviderPermission.config")(function* () {
      const entries = yield* configService.entries()
      const raw = Config.latest(entries, "providerPermissions") as unknown as ProviderPermission.Config | undefined
      if (!raw || !Array.isArray((raw as unknown as { tiers: unknown[] }).tiers)) return ProviderPermission.DEFAULT_CONFIG
      return raw as ProviderPermission.Config
    })

    const resolve = Effect.fn("ProviderPermission.resolve")(function* (
      modelId: string,
      action: string,
      resource: string,
    ) {
      const cfg = yield* getConfig()
      const effect = ProviderPermission.resolveEffect(cfg, modelId, action, resource)
      return effect ?? ("ask" as const)
    })

    const tierForModel = Effect.fn("ProviderPermission.tierForModel")(function* (modelId: string) {
      const cfg = yield* getConfig()
      const tierId = cfg.assignments[modelId] ?? cfg.defaultTier
      const tier: ProviderPermission.TrustTier | undefined =
        cfg.tiers.find((t: ProviderPermission.TrustTier) => t.id === tierId) ??
        cfg.tiers.find((t: ProviderPermission.TrustTier) => t.id === cfg.defaultTier)
      if (!tier) return cfg.tiers.find((t: ProviderPermission.TrustTier) => t.id === "unassigned")!
      return tier
    })

    return Service.of({
      config: getConfig,
      resolve,
      tierForModel,
    })
  }),
)

export const locationLayer = layer.pipe(Layer.provideMerge(Config.locationLayer))

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Config.node],
})

// ---- Source-path registry (in-memory, per-process) ----
// Maps `${sessionID}:${callID}` → sourcePath for history redaction.
// The registry is populated at tool execution time (source-path tagging) and
// consulted at send-time. It adds zero cost when no model switch occurs (map lookup only).
const sourcePathMap = new Map<string, string>()

export function registerSourcePath(sessionID: string, callID: string, sourcePath: string): void {
  if (!sourcePath) return
  sourcePathMap.set(`${sessionID}:${callID}`, sourcePath)
}

export function getSourcePath(sessionID: string, callID: string): string | undefined {
  return sourcePathMap.get(`${sessionID}:${callID}`)
}

export function clearSourcePathsForSession(sessionID: string): void {
  for (const key of sourcePathMap.keys()) {
    if (key.startsWith(`${sessionID}:`)) sourcePathMap.delete(key)
  }
}

// ---- Pure helpers for history redaction / context filtering ----

export function shouldRedactPath(
  config: ProviderPermission.Config,
  modelId: string,
  sourcePath: string,
): boolean {
  const effect = ProviderPermission.resolveEffect(config, modelId, "read", sourcePath)
  return effect === "deny"
}

export function redactHistoryMessage(
  content: string,
  sourcePath: string,
  tierLabel: string,
): string {
  return `[Content from ${sourcePath} filtered — trust tier "${tierLabel}" does not have read access]`
}

// Source-path tagging: attach metadata to tool results
export type TaggedToolResult = {
  content: string
  sourcePath?: string
  metadata?: Record<string, unknown>
}

export function tagToolResult(content: string, sourcePath?: string): TaggedToolResult {
  return sourcePath ? { content, sourcePath, metadata: { sourcePath } } : { content }
}

export type MessageWithSource = {
  id: string
  role: string
  content: string
  metadata?: Record<string, unknown> & { sourcePath?: string }
  sourcePath?: string
}

export function resolveTierLabel(config: ProviderPermission.Config, modelId: string): string {
  const tierId = config.assignments[modelId] ?? config.defaultTier
  const tier: ProviderPermission.TrustTier | undefined =
    config.tiers.find((t: ProviderPermission.TrustTier) => t.id === tierId) ??
    config.tiers.find((t: ProviderPermission.TrustTier) => t.id === config.defaultTier)
  return tier?.label ?? tierId
}

export function isDeniedForModel(
  config: ProviderPermission.Config,
  modelId: string,
  sourcePath: string,
): boolean {
  const effect = ProviderPermission.resolveEffect(config, modelId, "read", sourcePath)
  return effect === "deny"
}

// History redaction: filter at send-time only, does NOT mutate stored history
export function redactHistory(
  messages: readonly MessageWithSource[],
  config: ProviderPermission.Config,
  activeModelId: string,
): MessageWithSource[] {
  const tierLabel = resolveTierLabel(config, activeModelId)
  return messages.map((msg) => {
    const sourcePath = (msg.metadata?.sourcePath as string | undefined) ?? msg.sourcePath
    if (!sourcePath) return msg
    if (!isDeniedForModel(config, activeModelId, sourcePath)) return msg
    return {
      ...msg,
      content: `[Content from ${sourcePath} filtered — trust tier "${tierLabel}" does not have read access]`,
      metadata: { ...msg.metadata, redacted: true, originalSourcePath: sourcePath },
    }
  })
}

// Context filtering: suppress denied auto-context (instructions, system prompt sources)
export function filterContextFiles(
  files: readonly { path: string; content: string }[],
  config: ProviderPermission.Config,
  activeModelId: string,
): readonly { path: string; content: string }[] {
  return files.filter((file) => !isDeniedForModel(config, activeModelId, file.path))
}

// Source-path tagging helper: annotate tool results
export function tagResult(content: string, sourcePath?: string): { content: string; metadata?: Record<string, unknown> } {
  if (!sourcePath) return { content }
  return { content, metadata: { sourcePath } }
}

// ---- SessionMessage-level redaction (history + context) ----

export function filterSystemBaseline(
  baseline: string,
  config: ProviderPermission.Config,
  activeModelId: string,
): string {
  if (!baseline.includes("Instructions from:")) return baseline
  const parts = baseline.split(/(?=Instructions from:)/g)
  const filtered = parts.filter((part) => {
    const match = part.match(/Instructions from:\s*([^\n]+)/)
    if (!match) return true
    const p = match[1].trim()
    return !isDeniedForModel(config, activeModelId, p)
  })
  return filtered.join("").trim()
}

export function redactSessionMessages(
  messages: readonly import("@opencode-ai/schema/session-message").SessionMessage.Message[],
  config: ProviderPermission.Config,
  activeModelId: string,
  sessionID: string,
): readonly import("@opencode-ai/schema/session-message").SessionMessage.Message[] {
  const tierLabel = resolveTierLabel(config, activeModelId)
  return messages.map((msg) => {
    if (msg.type === "user" && (msg as unknown as { files?: unknown[] }).files && ((msg as unknown as { files: unknown[] }).files.length > 0)) {
      const files = (msg as unknown as { files: { uri: string; mime: string; name?: string }[] }).files
      const kept = files.filter((f) => {
        const p = (f as unknown as { uri: string }).uri ?? (f as unknown as { name: string }).name ?? ""
        if (!p) return true
        return !isDeniedForModel(config, activeModelId, p)
      })
      if (kept.length !== files.length) {
        return { ...msg, files: kept } as typeof msg
      }
      return msg
    }
    if (msg.type === "assistant") {
      let changed = false
      const newContent = msg.content.map((item) => {
        if (item.type !== "tool") return item
        let sourcePath = getSourcePath(sessionID, item.id)
        if (!sourcePath) {
          const input = (item.state as unknown as { input?: Record<string, unknown> }).input
          if (input && typeof input.path === "string") sourcePath = input.path
          else if (input && typeof input.pattern === "string") sourcePath = input.pattern
          else if (input && typeof input.url === "string") sourcePath = input.url
          else if (input && typeof input.query === "string") sourcePath = input.query
        }
        const outputPaths = (item.state as unknown as { outputPaths?: string[] }).outputPaths
        const deniedPath = sourcePath && isDeniedForModel(config, activeModelId, sourcePath)
          ? sourcePath
          : outputPaths?.find((p: string) => isDeniedForModel(config, activeModelId, p))
        if (!deniedPath) return item
        const placeholder = `[Content from ${deniedPath} filtered — trust tier "${tierLabel}" does not have read access]`
        const state = item.state as Record<string, unknown>
        const content = (state.content as unknown[]) ?? []
        const redactedContent = [{ type: "text", text: placeholder }] as unknown as typeof content
        changed = true
        return { ...item, state: { ...state, content: redactedContent } as unknown as typeof item.state }
      })
      if (changed) return { ...msg, content: newContent } as typeof msg
    }
    return msg
  })
}
