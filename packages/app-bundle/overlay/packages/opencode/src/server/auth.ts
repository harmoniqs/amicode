export * as ServerAuth from "./auth"

import { ConfigService } from "@/effect/config-service"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Config as EffectConfig, Context, Option, Redacted } from "effect"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { timingSafeEqual } from "node:crypto"

// AMICODE OVERLAY (#1438, ADR 0032 §D2) — the engine-boundary half of the
// accept-set. Stock base opencode validates a SINGLE per-boot password with a
// plaintext `===`. This overlay replaces that with:
//   · a CONSTANT-TIME password compare (length-guarded timingSafeEqual), and
//   · the SAME accept-set the extension service boundary enforces — a caller
//     bearing a non-revoked peer token this machine issued is authorized.
// "Two boundaries, one accept-set" (§D2): both read the SAME on-disk stores
// (~/.amico/fleet-peer-tokens.json + ~/.amico/fleet-accept-set.json), PER
// REQUEST (no cache), so a revocation / close takes effect immediately. The
// engine cannot import the extension package, so the reader is self-contained
// here (pure node:fs) — the honest cost of the second boundary.

export type Credentials = {
  password?: string
  username?: string
}

export type DecodedCredentials = {
  readonly username: string
  readonly password: Redacted.Redacted
}

export class Config extends ConfigService.Service<Config>()("@opencode/ServerAuthConfig", {
  password: EffectConfig.string("OPENCODE_SERVER_PASSWORD").pipe(EffectConfig.option),
  username: EffectConfig.string("OPENCODE_SERVER_USERNAME").pipe(EffectConfig.withDefault("opencode")),
}) {}

export type Info = Context.Service.Shape<typeof Config>

// ── the accept-set stores (mirror of fleet_issued_tokens.ts / fleet_accept_set.ts) ──

function issuedTokenRegistryPath(): string {
  const env = process.env.AMICO_FLEET_ISSUED_TOKEN_FILE
  if (env && env.trim() !== "") return env
  return join(homedir(), ".amico", "fleet-peer-tokens.json")
}

function acceptSetStatePath(): string {
  const env = process.env.AMICO_FLEET_ACCEPT_SET_FILE
  if (env && env.trim() !== "") return env
  return join(homedir(), ".amico", "fleet-accept-set.json")
}

/** The accept-set is CLOSED (§D3.2 — require a member; withdraw auth=open).
 *  Absent/corrupt → additive (the safe default; a half-migrated fleet is never
 *  locked out). Read fresh (no cache) so a close takes effect immediately. */
export function acceptSetClosed(): boolean {
  const file = acceptSetStatePath()
  if (!existsSync(file)) return false
  try {
    const doc = JSON.parse(readFileSync(file, "utf8")) as { phase?: unknown }
    return doc.phase === "closed"
  } catch {
    return false
  }
}

/** The non-revoked peer tokens THIS machine issued (its own registry). Read
 *  FRESH each call — currency (§D2). Absent/corrupt → []. */
function readIssuedTokens(): string[] {
  const file = issuedTokenRegistryPath()
  if (!existsSync(file)) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return []
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return []
  const issued = (parsed as { issued?: unknown }).issued
  if (typeof issued !== "object" || issued === null || Array.isArray(issued)) return []
  const tokens: string[] = []
  for (const entry of Object.values(issued as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null) continue
    const t = (entry as Record<string, unknown>).token
    if (typeof t === "string" && t !== "") tokens.push(t)
  }
  return tokens
}

/** Length-guarded constant-time equality — never a plaintext `===`. */
function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8")
  const bb = Buffer.from(b, "utf8")
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/** Constant-time membership test of a presented secret against a set, with NO
 *  early exit on a mismatch (§D2) — the match is accumulated, so the compare
 *  leaks neither which secret matched nor that none did. */
function matchesAnyConstantTime(presented: string, secrets: string[]): boolean {
  let ok = false
  for (const secret of secrets) {
    if (constantTimeEqual(presented, secret)) ok = true
  }
  return ok
}

// ── the exported auth surface (the base contract, accept-set-extended) ──────

/** Auth is REQUIRED when a per-boot password is configured (base) OR the
 *  accept-set has been CLOSED (§D3.2 — an anonymous request must then be
 *  refused even on an otherwise-unarmed engine). */
export function required(config: Info) {
  return (Option.isSome(config.password) && config.password.value !== "") || acceptSetClosed()
}

/** Authorize a caller against the accept-set: the local per-boot password
 *  (constant-time, replacing base `===`) OR a non-revoked peer token this
 *  machine issued. Both require the configured username. */
export function authorized(credentials: DecodedCredentials, config: Info) {
  if (credentials.username !== config.username) return false
  const presented = Redacted.value(credentials.password)
  let ok = false
  // 1. local per-boot password — constant-time (was a plaintext === in base).
  if (Option.isSome(config.password) && constantTimeEqual(presented, config.password.value)) ok = true
  // 2. a non-revoked peer token this machine issued (the accept-set) — fresh
  //    per request, no early exit.
  if (matchesAnyConstantTime(presented, readIssuedTokens())) ok = true
  return ok
}

export function header(credentials?: Credentials) {
  const password = credentials?.password ?? Flag.OPENCODE_SERVER_PASSWORD
  if (!password) return undefined

  const username = credentials?.username ?? Flag.OPENCODE_SERVER_USERNAME ?? "opencode"
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

export function headers(credentials?: Credentials) {
  const authorization = header(credentials)
  if (!authorization) return undefined
  return { Authorization: authorization }
}
