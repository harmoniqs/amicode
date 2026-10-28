// #1984: one-token reachability probe per catalog model. The probe runs
// entirely inside the engine through Provider.getLanguage, so credentials never
// leave the process; the response carries only a named status, latency, a
// redacted reason and a stable non-secret credential fingerprint.
import { Cause, Effect, Schema } from "effect"
import { Hash } from "@opencode-ai/core/util/hash"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Auth } from "../auth"
import { Env } from "../env"
import { Provider } from "./provider"
import { ProviderError } from "./error"

export const PROBE_MAX_OUTPUT_TOKENS = 1
export const PROBE_TIMEOUT_MS = 10_000
export const PROBE_CONCURRENCY = 4
export const PROBE_MAX_MODELS = 500
const REASON_MAX_CHARS = 300

export const Status = Schema.Literals(["ok", "denied", "unavailable", "invalid", "rate-limited", "error"])
export type Status = Schema.Schema.Type<typeof Status>

export const Input = Schema.Struct({
  providerID: ProviderV2.ID,
  modelIDs: Schema.Array(Schema.String).check(Schema.isMaxLength(PROBE_MAX_MODELS)),
}).annotate({ identifier: "ProviderProbeInput" })
export type Input = Schema.Schema.Type<typeof Input>

export const Result = Schema.Struct({
  model: Schema.String,
  status: Status,
  latency_ms: Schema.Number,
  reason: Schema.NullOr(Schema.String),
  credential_fp: Schema.NullOr(Schema.String),
  checked_at: Schema.Number,
}).annotate({ identifier: "ProviderProbeResult" })
export type Result = Schema.Schema.Type<typeof Result>

export const Output = Schema.Struct({
  providerID: Schema.String,
  results: Schema.Array(Result),
}).annotate({ identifier: "ProviderProbeOutput" })
export type Output = Schema.Schema.Type<typeof Output>

function strings(input: unknown, out: string[] = []): string[] {
  if (typeof input === "string") out.push(input)
  else if (Array.isArray(input)) for (const item of input) strings(item, out)
  else if (input && typeof input === "object") for (const value of Object.values(input)) strings(value, out)
  return out
}

/**
 * Stable, non-secret fingerprint of the credential a provider resolves with:
 * the stored auth entry (cf. #1848 authStamp, which stamps the whole
 * auth.json), plus the config/env material that selects an identity or
 * endpoint. A truncated domain-separated sha256 — it identifies "same
 * credential" for the probe cache and cannot be reversed into the secret.
 */
export function credentialFingerprint(input: {
  providerID: string
  auth: unknown
  provider: Pick<Provider.Info, "key" | "env" | "options">
  env: Record<string, string | undefined>
}) {
  const options = input.provider.options ?? {}
  const material = {
    auth: input.auth ?? null,
    key: input.provider.key ?? null,
    apiKey: options.apiKey ?? null,
    baseURL: options.baseURL ?? null,
    profile: options.profile ?? null,
    region: options.region ?? null,
    env: Object.fromEntries([...input.provider.env].sort().map((name) => [name, input.env[name] ?? null])),
  }
  return Hash.sha256(`amicode/credential-fp/v1\0${input.providerID}\0${JSON.stringify(material)}`).slice(0, 16)
}

/** Strip every known secret (and generic bearer/AWS key shapes) from a reason string. */
export function redact(text: string, secrets: string[]) {
  let out = text
  for (const secret of [...new Set(secrets)].filter((s) => s.length >= 6).sort((a, b) => b.length - a.length))
    out = out.split(secret).join("[redacted]")
  out = out
    .replace(/Bearer\s+\S+/gi, "[redacted]")
    .replace(/\b(AKIA|ASIA)[A-Z0-9]{12,}\b/g, "[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
  return out.length > REASON_MAX_CHARS ? `${out.slice(0, REASON_MAX_CHARS)}…` : out
}

export const run = Effect.fn("ProviderProbe.run")(function* (input: Input) {
  const provider = yield* Provider.Service
  const auth = yield* Auth.Service
  const env = yield* Env.Service

  const modelIDs = [...new Set(input.modelIDs)]
  const info = yield* provider.getProvider(input.providerID)
  const now = () => Date.now()
  if (!info) {
    const checked_at = now()
    return {
      providerID: input.providerID,
      results: modelIDs.map((model) => ({
        model,
        status: "error" as const,
        latency_ms: 0,
        reason: "provider not connected",
        credential_fp: null,
        checked_at,
      })),
    } satisfies Output
  }

  const entry = yield* auth.get(input.providerID).pipe(Effect.orElseSucceed(() => undefined))
  const envs = yield* env.all()
  const credential_fp = credentialFingerprint({ providerID: input.providerID, auth: entry, provider: info, env: envs })
  const secrets = [
    ...strings(entry),
    ...strings(info.key),
    ...strings(info.options?.apiKey),
    ...strings(info.options?.headers),
    ...info.env.map((name) => envs[name]).filter((v): v is string => typeof v === "string"),
  ]

  const probeOne = Effect.fn("ProviderProbe.one")(function* (modelID: string) {
    const started = now()
    const done = (status: Status, reason: string | null): Result => ({
      model: modelID,
      status,
      latency_ms: now() - started,
      reason: reason === null ? null : redact(reason, secrets),
      credential_fp,
      checked_at: now(),
    })
    const model = info.models[modelID]
    if (!model) return done("invalid", "model not listed by provider")
    const attempt = (maxOutputTokens: number) =>
      provider.getLanguage(model).pipe(
        Effect.flatMap((language) =>
          Effect.tryPromise({
            try: () =>
              language.doGenerate({
                prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
                maxOutputTokens,
                headers: model.headers,
                abortSignal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
              }),
            catch: (error) => error,
          }),
        ),
        Effect.as(undefined),
        Effect.catchCause((cause) => Effect.succeed({ error: Cause.squash(cause) })),
      )
    const first = yield* attempt(PROBE_MAX_OUTPUT_TOKENS)
    if (!first) return done("ok", null)
    // #1994: a max_output_tokens floor is a request-shape rejection, not a dead
    // model — retry exactly once at the (parsed, capped) floor and classify that.
    const floor = ProviderError.probeTokenFloor(first.error)
    const outcome = floor !== undefined && floor > PROBE_MAX_OUTPUT_TOKENS ? yield* attempt(floor) : first
    if (!outcome) return done("ok", null)
    const classified = ProviderError.classifyProbeError({ providerID: model.providerID, error: outcome.error })
    const retriedIntoFloor = outcome !== first && ProviderError.probeTokenFloor(outcome.error) !== undefined
    return done(
      classified.status,
      retriedIntoFloor ? `retried at ${floor} output tokens; ${classified.message}` : classified.message,
    )
  })

  const results = yield* Effect.forEach(modelIDs, probeOne, { concurrency: PROBE_CONCURRENCY })
  return { providerID: input.providerID, results } satisfies Output
})

export * as ProviderProbe from "./probe"
