// Context injection, on the v2 plugin API (#2062, ADR 0039) — the port of `amicode_context.ts` (v1 hooks
// `experimental.chat.system.transform` and `chat.headers`), with no engine source patch.
//
// Two delivery routes, chosen per source by how often its text changes:
//  - "keyed": the text is stored as a session instruction entry (`session.instructions.entry.put`) when a prompt is
//    admitted. The engine renders entries into the epoch baseline once and, when a value changes, as a small
//    update — the system prompt and its cache breakpoints stay byte-identical, so the prompt cache stays intact.
//    Re-putting an unchanged value is a no-op (it is hashed). For slow-moving state (stack state, setup state).
//  - "request": the text is appended to the system prompt of every model request through the `context` hook.
//    For text that depends on the request itself (the active mode block depends on the request's agent, and v1
//    emitted it per request so it survives compaction by construction).
// Like the v1 hook, a failing source never breaks a prompt: it is logged and skipped.
import type { Plugin } from "@opencode/plugin"
import path from "node:path"

export interface ContextRequest {
  readonly sessionID: string
  /** Present for "request" sources (the agent of the model request being built). */
  readonly agent?: string
  readonly directory?: string
}

export interface ContextSource {
  /** Slash-free and stable: becomes the instruction entry key `amicode-<key>`. */
  readonly key: string
  readonly delivery: "keyed" | "request"
  /** The text to inject, or null/undefined for nothing (silent outcomes stay silent). */
  readonly build: (request: ContextRequest) => Promise<string | null | undefined> | string | null | undefined
}

const log = (message: string) => process.stderr.write(`amicode-host: context: ${message}\n`)

export function contextPlugin(options: { sources: readonly ContextSource[]; harmoniqsHeaders?: boolean; sessionEnv?: boolean }): Plugin.Plugin {
  const keyed = options.sources.filter((source) => source.delivery === "keyed")
  const perRequest = options.sources.filter((source) => source.delivery === "request")
  return {
    id: "amicode.context",
    setup: async (context) => {
      const registrations: Array<{ dispose: () => Promise<void> }> = []
      if (keyed.length > 0)
        registrations.push(
          await context.session.hook("prompt", async (prompt) => {
            await Promise.all(
              keyed.map(async (source) => {
                const key = `amicode-${source.key}`
                const text = await attempt(source, { sessionID: prompt.sessionID })
                // `put` rejects values over the engine's size cap; a source that outgrew it is dropped, not fatal.
                if (text) await context.session.instructions.entry.put({ sessionID: prompt.sessionID, key, value: text }).catch((error) => log(`${key}: ${message(error)}`))
                else await context.session.instructions.entry.remove({ sessionID: prompt.sessionID, key }).catch(() => {})
              }),
            )
          }),
        )
      if (perRequest.length > 0)
        registrations.push(
          await context.session.hook("context", async (request) => {
            const texts = await Promise.all(perRequest.map((source) => attempt(source, { sessionID: request.sessionID, agent: request.agent, directory: context.location.directory })))
            for (const text of texts) if (text) request.system.push({ type: "text", text })
          }),
        )
      if (options.harmoniqsHeaders !== false)
        registrations.push(
          await context.session.hook("model.request", (request) => {
            if (request.model.providerID !== "harmoniqs") return
            // The gateway's routing contract (v1 `chat.headers`): the session id, and a per-call idempotency key.
            request.headers["X-Session-Id"] = request.sessionID
            request.headers["Idempotency-Key"] = `amicode:${request.sessionID}:${crypto.randomUUID()}`
          }),
        )
      if (options.sessionEnv !== false) registrations.push(...(await sessionEnv(context)))
      return async () => void (await Promise.all(registrations.map((registration) => registration.dispose())))
    },
  }
}

/**
 * v1 `shell.env` (#1928, A15): every shell command's environment carries AMICO_SESSION_ID. The v2 `shell` hook
 * (`create.before`) has the command and its env but not the session, so the session is learned from the tool hook
 * (`execute.before`, which has both) and matched by command text. A command seen by two different sessions at once
 * is ambiguous and gets NO id: a token must never be bound to the wrong session.
 */
async function sessionEnv(context: Plugin.Context) {
  const live = new Map<string, { sessionID: string; command: string }>()
  return [
    await context.tool.hook("execute.before", (event) => {
      const command = (event.input as { command?: unknown } | null)?.command
      if (event.tool === "shell" && typeof command === "string") live.set(event.id, { sessionID: event.sessionID, command })
    }),
    await context.tool.hook("execute.after", (event) => void live.delete(event.id)),
    await context.shell.hook("create.before", (event) => {
      const sessions = new Set([...live.values()].filter((entry) => entry.command === event.command).map((entry) => entry.sessionID))
      if (sessions.size === 1) event.env.AMICO_SESSION_ID = [...sessions][0]
    }),
  ]
}

// The one builder with a non-trivial signature; typed here so the extension's sources stay out of this typecheck.
interface ModeBlockModule {
  deployedModesRoot: () => string
  buildModeBlock: (deps: {
    sessionID: string | null
    engineClient: { session: { get: (options: unknown) => Promise<unknown> } } | null
    registryRoot: string
    directory?: string | null
  }) => Promise<string | null>
}

async function attempt(source: ContextSource, request: ContextRequest) {
  try {
    return (await source.build(request)) ?? null
  } catch (error) {
    log(`${source.key}: ${message(error)}`)
    return null
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * The v1 builders, taken from the extension's own `opencode-plugin` directory (the same modules the v1 plugin
 * called), loaded lazily per call so a missing or broken directory degrades to "no context", never to a failed
 * start. The recent-sessions and open-threads blocks are NOT ported: they read the v1 session table, which does
 * not exist in a v2 database.
 */
export function extensionSources(directory: string): ContextSource[] {
  const load = <T>(file: string) => import(path.join(directory, file)) as Promise<T>
  return [
    {
      key: "mode",
      delivery: "request",
      build: async (request) => {
        const { buildModeBlock, deployedModesRoot } = await load<ModeBlockModule>("mode_block.ts")
        // v1 resolved the agent through the engine client; a v2 request carries its agent, so answer from it.
        const engineClient = { session: { get: async () => ({ data: { agent: request.agent } }) } }
        return buildModeBlock({ sessionID: request.sessionID, engineClient, registryRoot: deployedModesRoot(), directory: request.directory ?? null })
      },
    },
    {
      key: "stack-state",
      delivery: "keyed",
      build: async () => (await load<{ buildStackStateBlock: () => string | null }>("stack_state.ts")).buildStackStateBlock(),
    },
    {
      key: "setup-state",
      delivery: "keyed",
      build: async () => (await load<{ buildSetupStateSection: () => string | null }>("setup_state.ts")).buildSetupStateSection(),
    },
  ]
}
