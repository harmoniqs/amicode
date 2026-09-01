// Hand-written types for llm_creds.mjs — the shared pure module is JS so the
// raw `node scripts/healthcheck.mjs` invocation can import it without a build,
// while extension.ts gets full typing here.

/** A key-free provider entry from opencode's /config/providers (post-strip). */
export interface ProviderEntry {
  id: string;
  source?: string;
}

/** ok | not-ok signal shared by the healthcheck and the chat-not-ready gate. */
export type LlmCredsSignal =
  | { ok: true; provider: string; source?: string; warning?: string }
  | { ok: false; reason: string; fix: string };

/** PURE: compute the signal from opencode's resolved providers + configured model. */
export function resolveLlmCreds(args: { providers: ProviderEntry[]; model?: string }): LlmCredsSignal;

/** No-leak boundary: strip the raw /config/providers JSON to key-free {id, source}. */
export function stripProviders(providersJson: unknown): ProviderEntry[];

/** Async: query a running opencode server for the provider signal (no key ever
 *  returned). `headers` carries the Basic credential for the per-boot server
 *  password (#163). */
export function fetchProviderSignal(
  baseUrl: string,
  opts?: { fetchImpl?: typeof fetch; timeoutMs?: number; headers?: Record<string, string> },
): Promise<LlmCredsSignal>;
