// The host's in-process plugin set (#2062): built from AMICODE_HOST_PLUGIN_CONFIG and handed to the seam, which
// registers them with the engine. Nothing here imports the engine.
import type { Plugin } from "@opencode/plugin"
import path from "node:path"
import { defaultPolicy, permissionPlugin, type Effect, type Grant } from "./permission.ts"

export class PluginConfigError extends Error {}

export interface PluginConfig {
  readonly permission: { readonly grants: readonly Grant[]; readonly replaceDefaults: boolean }
  /** Absolute paths of extra plugin modules; each default-exports a `Plugin`. */
  readonly modules: readonly string[]
}

type Env = Record<string, string | undefined>
const VAR = "AMICODE_HOST_PLUGIN_CONFIG"

export async function loadPlugins(env: Env): Promise<Plugin[]> {
  const config = parsePluginConfig(env[VAR])
  const grants = config.permission.replaceDefaults ? config.permission.grants : [...defaultPolicy({ home: env.HOME }).grants, ...config.permission.grants]
  const extra = await Promise.all(config.modules.map(loadModule))
  return [permissionPlugin({ grants }), ...extra]
}

export function parsePluginConfig(raw: string | undefined): PluginConfig {
  const value = raw === undefined || raw === "" ? {} : parse(raw)
  const unknown = Object.keys(value).filter((key) => !["permission", "modules"].includes(key))
  if (unknown.length) throw new PluginConfigError(`${VAR} has unknown keys: ${unknown.join(", ")}`)
  const permission = record(value.permission, "permission")
  const unknownPermission = Object.keys(permission).filter((key) => !["grants", "replaceDefaults"].includes(key))
  if (unknownPermission.length) throw new PluginConfigError(`${VAR}.permission has unknown keys: ${unknownPermission.join(", ")}`)
  const modules = value.modules ?? []
  if (!Array.isArray(modules) || modules.some((m) => typeof m !== "string" || !path.isAbsolute(m)))
    throw new PluginConfigError(`${VAR}.modules must be an array of absolute paths`)
  return {
    permission: { grants: grants(permission.grants), replaceDefaults: permission.replaceDefaults === true },
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

async function loadModule(file: string): Promise<Plugin> {
  const loaded = await import(file).catch((error) => {
    throw new PluginConfigError(`${VAR}.modules: cannot load ${file}: ${error instanceof Error ? error.message : String(error)}`)
  })
  const plugin = loaded.default
  if (typeof plugin?.id !== "string" || typeof plugin?.setup !== "function")
    throw new PluginConfigError(`${VAR}.modules: ${file} must default-export a plugin { id, setup }`)
  return plugin
}
