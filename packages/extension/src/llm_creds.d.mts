// Hand-written types for llm_creds.mjs — the shared pure module is JS so the
// raw `node scripts/healthcheck.mjs` invocation can import it without a build,
// while extension.ts gets full typing here.

export type Provider = 'anthropic' | 'openai' | 'amazon-bedrock'

/** A valid loaded credential from the canonical store. */
export interface LlmCred {
  provider: Provider
  key: string
}

/** Malformed-store sentinel returned by loadLlmCred (never thrown). */
export interface LlmCredError {
  error: string
}

/** ok | not-ok signal shared by the healthcheck and the chat-not-ready gate. */
export type LlmCredsSignal =
  | { ok: true; provider: string; source: 'store' | 'env' }
  | { ok: false; reason: string; fix: string }

export function credStorePath(home: string): string
export function loadLlmCred(home: string): LlmCred | LlmCredError | null
export function credSpawnEnv(cred: LlmCred | LlmCredError | null | undefined): Record<string, string>
export function resolveLlmCreds(args: { home: string; env: Record<string, string | undefined> }): LlmCredsSignal
