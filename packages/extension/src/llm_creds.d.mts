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

/** The live provider id list (S3 model routing, amicode#860) — key-free ids
 *  only; undefined when the query fails (unknown, never "none"). */
export function fetchProviderIds(
  baseUrl: string,
  opts?: { fetchImpl?: typeof fetch; timeoutMs?: number; headers?: Record<string, string> },
): Promise<string[] | undefined>;

/** #1985: the live provider → model-id catalog (key-free: provider ids and
 *  model keys only); undefined when the query fails (unknown, never empty). */
export function fetchProviderModels(
  baseUrl: string,
  opts?: { fetchImpl?: typeof fetch; timeoutMs?: number; headers?: Record<string, string> },
): Promise<Record<string, string[]> | undefined>;

/** #2000: the FULL catalog (engine GET /provider): every listed provider's
 *  model ids with non-secret price/context meta, plus the connected set. */
export function fetchProviderCatalog(
  baseUrl: string,
  opts?: { fetchImpl?: typeof fetch; timeoutMs?: number; headers?: Record<string, string> },
): Promise<
  | {
      connected: string[];
      providers: Record<string, Record<string, { input?: number; output?: number; context?: number }>>;
    }
  | undefined
>;

/** One row of the engine's POST /provider/probe response (#1984). */
export interface ProviderProbeResultWire {
  model: string;
  status: "ok" | "denied" | "unavailable" | "invalid" | "rate-limited" | "error";
  latency_ms: number;
  reason: string | null;
  credential_fp: string | null;
  checked_at: number;
}

/** #1985: POST /provider/probe {providerID, modelIDs}; undefined on failure. */
export function probeProviderModels(
  baseUrl: string,
  providerID: string,
  modelIDs: string[],
  opts?: { fetchImpl?: typeof fetch; timeoutMs?: number; headers?: Record<string, string> },
): Promise<{ providerID: string; results: ProviderProbeResultWire[] } | undefined>;
