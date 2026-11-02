// A minimal plugin runtime for hook-level tests: it hands a plugin a Context whose `*.hook` registrars record the
// callbacks, then lets a test fire a hook exactly the way the engine does (one mutable input object per call).
// Anything a plugin touches that the harness does not model throws, so a plugin cannot silently depend on more
// of the API than its tests cover. Behaviour that needs the real engine is tested against a real host process.
import type { Plugin } from "@opencode/plugin"

type Callback = (input: any) => Promise<void> | void

export interface Harness {
  /** Fires every callback registered for `domain`.`name`, in order, on `input`; returns the (mutated) input. */
  trigger<T extends object>(domain: string, name: string, input: T): Promise<T>
  registered(domain: string): string[]
  cleanup: () => Promise<void>
}

export async function load(plugin: Plugin.Plugin, extra: Record<string, unknown> = {}): Promise<Harness> {
  const hooks = new Map<string, Callback[]>()
  const registrar = (domain: string) => async (name: string, callback: Callback) => {
    const key = `${domain}:${name}`
    hooks.set(key, [...(hooks.get(key) ?? []), callback])
    return { dispose: async () => void hooks.set(key, (hooks.get(key) ?? []).filter((c) => c !== callback)) }
  }
  const base: Record<string, unknown> = {
    app: { name: "amicode-host", version: "test" },
    location: { directory: "/nonexistent" },
    options: {},
    permission: { hook: registrar("permission") },
    tool: { hook: registrar("tool") },
    shell: { hook: registrar("shell") },
    aisdk: { hook: registrar("aisdk") },
    model: { transform: async () => ({ dispose: async () => {} }) },
    ...extra,
    session: { hook: registrar("session"), ...(extra.session as object) },
  }
  const context = new Proxy(base, {
    get(target, key) {
      if (typeof key === "string" && !(key in target)) throw new Error(`plugin touched ctx.${key}, which the test harness does not model`)
      return Reflect.get(target, key)
    },
  }) as unknown as Plugin.Context
  const cleanup = await plugin.setup(context)
  return {
    async trigger(domain, name, input) {
      for (const callback of hooks.get(`${domain}:${name}`) ?? []) await callback(input)
      return input
    },
    registered: (domain) => [...hooks.keys()].filter((k) => k.startsWith(`${domain}:`)).map((k) => k.slice(domain.length + 1)),
    cleanup: async () => void (await cleanup?.()),
  }
}
