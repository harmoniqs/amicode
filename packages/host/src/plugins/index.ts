// The host's in-process plugin set (#2062): built from AMICODE_HOST_PLUGIN_CONFIG and handed to the seam, which
// registers them with the engine. Nothing here imports the engine.
import type { Plugin } from "@opencode/plugin"
import path from "node:path"
import { contextPlugin, extensionSources } from "./context.ts"
import { DEFAULT_PROVIDER_CONFIG, providerPlugin, type ProviderConfig } from "./provider.ts"
import { defaultPolicy, permissionPlugin, type Effect, type Grant } from "./permission.ts"

export class PluginConfigError extends Error {}

export interface PluginConfig {
  readonly permission: { readonly grants: readonly Grant[]; readonly replaceDefaults: boolean }
  /** Where the v1 context builders live; null turns the injected context blocks off (headers and session env stay). Default: the repo's extension. */
  readonly context: { readonly extensionDir: string | null }
  readonly provider: ProviderConfig
  /** Absolute paths of extra plugin modules; each default-exports a `Plugin`. */
  readonly modules: readonly string[]
}

type Env = Record<string, string | undefined>
const VAR = "AMICODE_HOST_PLUGIN_CONFIG"
// The v1 builders ship in the extension package; absent in a deployment that does not carry it (then: no context).
const DEFAULT_EXTENSION_DIR = path.resolve(import.meta.dir, "../../../extension/opencode-plugin")

export async function loadPlugins(env: Env): Promise<Plugin.Plugin[]> {
  const config = parsePluginConfig(env[VAR])
  const grants = config.permission.replaceDefaults ? config.permission.grants : [...defaultPolicy({ home: env.HOME }).grants, ...config.permission.grants]
  const extra = await Promise.all(config.modules.map(loadModule))
  const context = contextPlugin({ sources: config.context.extensionDir === null ? [] : extensionSources(config.context.extensionDir) })
  return [permissionPlugin({ grants }), context, providerPlugin(config.provider), ...extra]
}

export function parsePluginConfig(raw: string | undefined): PluginConfig {
  const value = raw === undefined || raw === "" ? {} : parse(raw)
  const unknown = Object.keys(value).filter((key) => !["permission", "context", "provider", "modules"].includes(key))
  if (unknown.length) throw new PluginConfigError(`${VAR} has unknown keys: ${unknown.join(", ")}`)
  const permission = record(value.permission, "permission")
  const unknownPermission = Object.keys(permission).filter((key) => !["grants", "replaceDefaults"].includes(key))
  if (unknownPermission.length) throw new PluginConfigError(`${VAR}.permission has unknown keys: ${unknownPermission.join(", ")}`)
  const context = record(value.context, "context")
  const unknownContext = Object.keys(context).filter((key) => key !== "extensionDir")
  if (unknownContext.length) throw new PluginConfigError(`${VAR}.context has unknown keys: ${unknownContext.join(", ")}`)
  const extensionDir = context.extensionDir === undefined ? DEFAULT_EXTENSION_DIR : context.extensionDir
  if (extensionDir !== null && (typeof extensionDir !== "string" || !path.isAbsolute(extensionDir)))
    throw new PluginConfigError(`${VAR}.context.extensionDir must be an absolute path or null`)
  const modules = value.modules ?? []
  if (!Array.isArray(modules) || modules.some((m) => typeof m !== "string" || !path.isAbsolute(m)))
    throw new PluginConfigError(`${VAR}.modules must be an array of absolute paths`)
  return {
    permission: { grants: grants(permission.grants), replaceDefaults: permission.replaceDefaults === true },
    context: { extensionDir },
    provider: providerConfig(record(value.provider, "provider")),
    modules: modules as string[],
  }
}

function parse(raw: string): Record<string, unknown> {
  try {
    return record(JSON.parse(raw), "")
  } catch (error) {
    if (error instanceof PluginConfigError) throw error
    throw new PluginConfigError(`${VAR} is not valid JSON`)
  }
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined) return {}
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new PluginConfigError(`${VAR}${name && "." + name} must be a JSON object`)
  return value as Record<string, unknown>
}

const EFFECTS: readonly string[] = ["allow", "ask", "deny"] satisfies Effect[]
function grants(value: unknown): Grant[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new PluginConfigError(`${VAR}.permission.grants must be an array`)
  return value.map((item, index) => {
    const ok = typeof item === "object" && item !== null && typeof item.action === "string" && typeof item.resource === "string" && EFFECTS.includes(item.effect)
    if (!ok) throw new PluginConfigError(`${VAR}.permission.grants[${index}] must be { action, resource, effect: allow|ask|deny }`)
    return { action: item.action, resource: item.resource, effect: item.effect }
  })
}

async function loadModule(file: string): Promise<Plugin.Plugin> {
  const loaded = await import(file).catch((error) => {
    throw new PluginConfigError(`${VAR}.modules: cannot load ${file}: ${error instanceof Error ? error.message : String(error)}`)
  })
  const plugin = loaded.default
  if (typeof plugin?.id !== "string" || typeof plugin?.setup !== "function")
    throw new PluginConfigError(`${VAR}.modules: ${file} must default-export a plugin { id, setup }`)
  return plugin
}

function providerConfig(value: Record<string, unknown>): ProviderConfig {
  const unknown = Object.keys(value).filter((key) => !["qwen", "bedrock", "defaultModelGuard"].includes(key))
  if (unknown.length) throw new PluginConfigError(`${VAR}.provider has unknown keys: ${unknown.join(", ")}`)
  for (const key of ["bedrock", "defaultModelGuard"])
    if (value[key] !== undefined && typeof value[key] !== "boolean") throw new PluginConfigError(`${VAR}.provider.${key} must be a boolean`)
  const qwen = value.qwen
  const validQwen = qwen === undefined || qwen === false || (typeof qwen === "object" && qwen !== null && typeof (qwen as any).temperature === "number" && typeof (qwen as any).topP === "number")
  if (!validQwen) throw new PluginConfigError(`${VAR}.provider.qwen must be false or { temperature: number, topP: number }`)
  return {
    qwen: qwen === undefined ? DEFAULT_PROVIDER_CONFIG.qwen : (qwen as ProviderConfig["qwen"]),
    bedrock: (value.bedrock as boolean | undefined) ?? DEFAULT_PROVIDER_CONFIG.bedrock,
    defaultModelGuard: (value.defaultModelGuard as boolean | undefined) ?? DEFAULT_PROVIDER_CONFIG.defaultModelGuard,
  }
}
