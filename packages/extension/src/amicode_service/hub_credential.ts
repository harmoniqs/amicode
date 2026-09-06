// HUB CREDENTIAL (amicissimo#391 — the local-shell data plane, D5): the
// fleet plane's third mint and its client-side credential-store entry.
//
// D5 — three mints, one honesty rule. Every mint is NAMED and stamped; a
// missing credential is a NAMED outcome; there is no silent mint fallback:
//
//   - "service"  the service's own per-boot mint (server_auth.ts) — its
//                routes, both modes, base behavior.
//   - "engine"   the spawned engine's per-boot mint — the framed bootstrap's
//                ?auth_token= carrier and the proxied local-engine calls,
//                both modes, base behavior (#822/#823).
//   - "hub"      the hub's mint, fleet mode ONLY — transported over the
//                fleet tunnel and used for the HUB's API on the upstream
//                hop. It is never accepted on the service's own routes (a
//                client authenticates to the service with the service or
//                engine mint; the proxy translates to the hub mint per
//                request — the accept-both discipline extends PER-MODE, and
//                the hub mint's mode makes it upstream-only).
//
// The store entry (one file, atomically written 0600 through the
// credentials.ts writer) carries the lifecycle spec's F4 version stamp plus
// the base-reader guarantee: the stamp is present from day one, unknown keys
// are tolerated on read and PRESERVED on rewrite (never clobbered), and any
// shape the base could have written still reads — a downgraded machine reads
// every store it ever wrote.
import { existsSync, readFileSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { atomicWriteFileSync } from "./credentials"
import { serverAuthHeader } from "../server_auth"

/** F4: the store's version stamp — present from the first write, tolerated
 *  absent on read (a pre-stamp store still reads; the stamp never lies). */
export const HUB_STORE_VERSION = 1
export const HUB_MINT_NAME = "hub"

export type HubCredentialReadReason = "absent" | "malformed" | "incomplete"

export interface HubCredential {
  baseUrl: string
  token: string
}

/** The NAMED read outcome — one of three shapes, never a throw, never a
 *  half-present credential. */
export type HubCredentialRead =
  | { ok: true; mint: typeof HUB_MINT_NAME; storeVersion?: number; credential: HubCredential }
  | { ok: false; mint: typeof HUB_MINT_NAME; reason: HubCredentialReadReason; detail?: string }

export function fleetHubFile(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.AMICO_FLEET_HUB_FILE
  if (v && v.trim() !== "") return v
  return join(homedir(), ".amico", "fleet-hub.json")
}

/** Tolerant JSON read — malformed is a NAMED outcome, not an exception. */
function readRaw(file: string): { ok: true; raw: Record<string, unknown> } | { ok: false; reason: HubCredentialReadReason; detail?: string } {
  if (!existsSync(file)) return { ok: false, reason: "absent" }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"))
  } catch (e) {
    return { ok: false, reason: "malformed", detail: e instanceof Error ? e.message : String(e) }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "malformed", detail: "credential file is not a JSON object" }
  }
  return { ok: true, raw: parsed as Record<string, unknown> }
}

export function readHubCredential(env: NodeJS.ProcessEnv = process.env): HubCredentialRead {
  const read = readRaw(fleetHubFile(env))
  if (!read.ok) return { ok: false, mint: HUB_MINT_NAME, reason: read.reason, ...(read.detail ? { detail: read.detail } : {}) }
  const d = read.raw
  const baseUrl = typeof d.base_url === "string" ? d.base_url.trim() : ""
  const token = typeof d.token === "string" ? d.token.trim() : ""
  if (baseUrl === "" || token === "") {
    return { ok: false, mint: HUB_MINT_NAME, reason: "incomplete", detail: "store entry lacks base_url/token" }
  }
  const version = typeof d.store_version === "number" ? d.store_version : undefined
  return { ok: true, mint: HUB_MINT_NAME, ...(version !== undefined ? { storeVersion: version } : {}), credential: { baseUrl, token } }
}

/** Allowlist-write the hub entry WITH the version stamp and the mint name,
 *  preserving every key this writer does not own (bidirectional courtesy:
 *  a future reader's fields survive our rewrite). Atomic 0600 via the
 *  credentials writer. SECURITY: no credential value ever appears in an
 *  error message. */
export function writeHubCredential(
  value: HubCredential,
  opts: { env?: NodeJS.ProcessEnv; hooks?: Parameters<typeof atomicWriteFileSync>[2] } = {},
): void {
  const file = fleetHubFile(opts.env)
  // preserve what we do not own — read tolerantly (an unreadable prior store
  // is overwritten with a clean stamped one, named in the result shape only
  // for callers who check; the write itself always succeeds or throws whole)
  let preserved: Record<string, unknown> = {}
  const prior = readRaw(file)
  if (prior.ok) {
    for (const [k, v] of Object.entries(prior.raw)) {
      if (k === "store_version" || k === "mint" || k === "base_url" || k === "token") continue
      preserved[k] = v
    }
  }
  const out = {
    ...preserved,
    store_version: HUB_STORE_VERSION,
    mint: HUB_MINT_NAME,
    base_url: value.baseUrl.trim(),
    token: value.token.trim(),
  }
  atomicWriteFileSync(file, JSON.stringify(out, null, 2) + "\n", opts.hooks)
}

/** Remove the credential file; absent is a no-op. */
export function clearHubCredential(env: NodeJS.ProcessEnv = process.env): void {
  rmSync(fleetHubFile(env), { force: true })
}

/** The Authorization header the hub upstream expects: the same Basic idiom
 *  the engine spawn uses (base64("opencode:<password>")) — the hub is an
 *  opencode server behind the tunnel, so one credential shape serves both
 *  upstream hops. */
export function hubUpstreamAuthHeader(hubToken: string): string {
  return serverAuthHeader(hubToken)
}

// ── the mint registry (D5's "every mint is named") ───────────────────────────

export interface MintRecord {
  mint: string
  /** What the mint authenticates, and on which hop. */
  scope: string
  modes: Array<"engine" | "fleet">
  present: boolean
  /** The F4-style stamp the mint's store entry carries, where it has one. */
  stamped?: string
}

/** The three mints of the data plane, named with their scope and presence —
 *  the honesty surface /amicode/fleet/status renders. `mode` is the CURRENT
 *  routing mode: the hub mint exists (and may be USED) only in fleet mode. */
export function mintRegistry(input: {
  mode: "engine" | "fleet"
  engineArmed: boolean
  hubCredential: HubCredentialRead
  servicePassword?: boolean
}): MintRecord[] {
  void input.servicePassword
  return [
    {
      mint: "service",
      scope: "the service's own routes (per-boot Basic + ?auth_token= carrier)",
      modes: ["engine", "fleet"],
      present: true,
      stamped: "per-boot mint — in-memory only, never persisted",
    },
    {
      mint: "engine",
      scope: "the framed bootstrap + proxied local-engine calls",
      modes: ["engine", "fleet"],
      present: input.engineArmed,
      stamped: "per-boot mint — in-memory only, never persisted",
    },
    {
      mint: "hub",
      scope: "the hub's API over the fleet tunnel — upstream hop only, never accepted client-side",
      modes: ["fleet"],
      present: input.hubCredential.ok,
      stamped: `credential-store entry: store_version=${input.hubCredential.ok && input.hubCredential.storeVersion !== undefined ? input.hubCredential.storeVersion : HUB_STORE_VERSION}`,
    },
  ]
}
