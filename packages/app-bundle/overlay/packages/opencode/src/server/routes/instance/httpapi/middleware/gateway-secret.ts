export * as GatewaySecret from "./gateway-secret"

// AMICODE #1760 P1 — one door. When AMICODE_ENGINE_SHARED_SECRET is set, every
// engine API route requires the frontdoor-only shared-secret header; the
// direct-engine client population (fleet sessions, CLIs, probes) gets a 401
// and must move to the gateway. Env UNSET = today's open behavior — the
// compat window during rollout and the safety valve for a half-rolled fleet
// (a secret on the frontdoor but not on an engine, or vice versa, degrades to
// open, never to outage).
//
// Idioms follow ServerAuth (src/server/auth.ts): a ConfigService backed by an
// env var, Option-typed so unset is explicit, with a `required()` gate that
// treats an empty string as unset. The header is case-insensitive on the wire
// (HTTP semantics); the canonical spelling is what the frontdoor stamps.
import { timingSafeEqual } from "node:crypto"
import { Config as EffectConfig, Context, Effect, Option } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { ConfigService } from "@/effect/config-service"

/** The header the frontdoor stamps on EVERY engine-facing connection (#1760 P1). */
export const HEADER = "x-amicode-gateway-secret"

export class Config extends ConfigService.Service<Config>()("@opencode/AmicodeGatewaySecretConfig", {
  sharedSecret: EffectConfig.string("AMICODE_ENGINE_SHARED_SECRET").pipe(EffectConfig.option),
}) {}

export type Info = Context.Service.Shape<typeof Config>

export function required(config: Info) {
  return Option.isSome(config.sharedSecret) && config.sharedSecret.value !== ""
}

function secretMatches(provided: string | undefined, want: string) {
  if (provided === undefined) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(want)
  return a.length === b.length && timingSafeEqual(a, b)
}

const unauthorized = () =>
  HttpServerResponse.jsonUnsafe({ error: `missing or invalid ${HEADER}` }, { status: 401 })

// GLOBAL router middleware (same position as cors in createRoutes): it wraps
// every route — typed API routes, raw /amicode/* routes, the doc route, and
// the SPA fallback alike. There is no public path when the secret is armed:
// the frontdoor serves the panel's static app itself, so nothing legitimate
// reaches the engine without the stamp.
export const gatewaySecretLayer = HttpRouter.middleware()(
  Effect.gen(function* () {
    const config = yield* Config
    const want = Option.isSome(config.sharedSecret) ? config.sharedSecret.value : ""
    if (want === "") return (effect) => effect
    return (effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        if (secretMatches(request.headers[HEADER], want)) return yield* effect
        return unauthorized()
      })
  }),
  { global: true },
)
