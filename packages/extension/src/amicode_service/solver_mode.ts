// AMICODE SERVICE (#798): the solver-mode route — POST /amicode/solver-mode,
// ported from the fork's connections.ts @ v1.18.10-amicode.21 (the handler
// lives there in the pin, not in a separate module). Releasing the HP tier is
// the ONLY direction this route serves: hp is granted by connecting a Company
// Compute credential (the connections credential route's HP flip), and a
// second hp writer is the duplicate-flip bug ADR 0001 forbids.
//
// Persistence rides the SAME shared file contract the fork writes and the
// extension's watcher (src/solver_mode.ts, watchSolverMode) consumes:
// revoking `issimo` in $AMICODE_OPS_DIR/entitlements.toml, then requesting
// the piccolo switch as {mode:"piccolo",status:"switching"} in
// $AMICODE_OPS_DIR/solver-mode.json. The watcher does the real switch
// (re-prep config, restart the opencode server) and settles status:"ready" —
// this route only WRITES the request, never a second switch mechanism.
import { readFileSync } from "node:fs"
import path from "node:path"
import { amicodeOpsDir } from "./connections"
import { atomicWriteFileSync } from "./credentials"
import { parseTomlLite } from "./toml_lite"
import { getBindHostname, isLoopbackHostname } from "./bind_host"

export function entitlementsFile(): string {
  return path.join(amicodeOpsDir(), "entitlements.toml")
}

export function solverModeFile(): string {
  return path.join(amicodeOpsDir(), "solver-mode.json")
}

/** Revoke `issimo` PRESERVING every other code — the exact mirror of the
 *  connections family's grantIssimo, byte-compatible with the extension's
 *  applyEntitlementForMode (`codes = [...]` + optional `expired = [...]`).
 *  Returns whether the code was already absent, so a settled piccolo setup
 *  writes nothing. */
export function revokeIssimo(file: string): { alreadyRevoked: boolean } {
  let codes: string[] = []
  let expired: string[] = []
  try {
    const parsed = parseTomlLite(readFileSync(file, "utf8"))
    if (parsed.ok) {
      const value = parsed.value as { codes?: unknown; expired?: unknown }
      if (Array.isArray(value.codes)) codes = value.codes.filter((c): c is string => typeof c === "string")
      if (Array.isArray(value.expired)) expired = value.expired.filter((c): c is string => typeof c === "string")
    }
  } catch (e) {
    // A file that isn't there has no grant to revoke — the fresh-install state,
    // and a legitimate no-op. Any OTHER fault (an unwritable ops dir, a path
    // blocked by a regular file) must NOT masquerade as "already released":
    // readSolverMode falls back to piccolo on the same broken dir, so swallowing
    // it here would short-circuit the whole flip and report success having
    // written nothing.
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return { alreadyRevoked: true }
    throw e
  }
  if (!codes.includes("issimo")) return { alreadyRevoked: true }
  codes = codes.filter((c) => c !== "issimo")
  const lines = [`codes = [${codes.map((c) => JSON.stringify(c)).join(", ")}]`]
  if (expired.length > 0) lines.push(`expired = [${expired.map((c) => JSON.stringify(c)).join(", ")}]`)
  atomicWriteFileSync(file, lines.join("\n") + "\n")
  return { alreadyRevoked: false }
}

/** Tolerant {mode,status} read — the extension's readSolverModeState
 *  semantics: anything absent/off-shape collapses to piccolo/ready. */
function readSolverMode(file: string): { mode: "piccolo" | "hp"; status: "ready" | "switching" } {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { mode?: unknown; status?: unknown }
    return {
      mode: parsed.mode === "hp" ? "hp" : "piccolo",
      status: parsed.status === "switching" ? "switching" : "ready",
    }
  } catch {
    return { mode: "piccolo", status: "ready" }
  }
}

/** Sibling of the connections family's fixed warnings, for the release
 *  direction. Value-free by the module contract — never a token, path, or
 *  errno. */
export const PICCOLO_FLIP_WARNING = "piccolo_flip_failed: the local solver switch could not be requested"

/** The mirror of the credential route's HP flip, and the half opencode#78 was
 *  missing: RELEASE the tier. Revokes the entitlement and requests the piccolo
 *  switch in one operation — both, or the setup is split-brained (a piccolo
 *  mode file beside a granted `issimo` is precisely what amicode#259's
 *  reconcileSolverMode heals straight back to hp). No-ops when the setup is
 *  already settled at piccolo with no grant, so the watcher — whose one
 *  re-prep restarts the server — is never poked for nothing. NEVER throws. */
export function requestPiccoloFlip(): string | undefined {
  try {
    const { alreadyRevoked } = revokeIssimo(entitlementsFile())
    const modeFile = solverModeFile()
    if (alreadyRevoked && readSolverMode(modeFile).mode === "piccolo") return undefined
    atomicWriteFileSync(modeFile, JSON.stringify({ mode: "piccolo", status: "switching" }))
    return undefined
  } catch {
    return PICCOLO_FLIP_WARNING
  }
}

/** Sibling shape for the solver-mode family — no `connection` rides this
 *  route, so it carries the settled-mode field instead. One shape per route
 *  family, sibling discipline: never reject, ok:false + "code: detail" on
 *  failure. SECURITY: every failure message is a FIXED string — nothing the
 *  caller sent is ever echoed. */
export function synthesizeSolverMode(code: string, detail: string): string {
  return JSON.stringify({ ok: false, mode: null, error: `${code}: ${detail}` })
}

/** POST /amicode/solver-mode — body {mode:"piccolo"}. Releasing the tier is
 *  the ONLY direction this route serves: hp is granted by connecting a
 *  credential (submitCredentialResponse), and a second hp writer is the
 *  duplicate-flip ADR 0001 forbids. */
export function solverModeResponse(rawBody: string, deps: SolverModeDeps = {}): string {
  const refusal = loopbackRefusal(deps.bindHostname ?? getBindHostname())
  if (refusal) return synthesizeSolverMode("non_loopback", "solver mutations serve loopback binds only")
  const parsed = parseSolverModeBody(rawBody)
  if (!parsed || typeof parsed.mode !== "string")
    return synthesizeSolverMode("bad_request", 'body must be JSON {mode:"piccolo"}')
  if (parsed.mode !== "piccolo")
    return synthesizeSolverMode(
      "unsupported_mode",
      "only piccolo is selectable here; hp follows a Company Compute credential",
    )
  const warning = requestPiccoloFlip()
  // Unlike the hp flip — a rider on a credential save that stands on its own —
  // the flip IS this route's whole operation, so trouble is a failure, not a
  // partial one. PICCOLO_FLIP_WARNING is already in the sibling "code: detail"
  // shape, so it rides the error field verbatim.
  if (warning) return JSON.stringify({ ok: false, mode: null, error: warning })
  return JSON.stringify({ ok: true, mode: "piccolo", error: null })
}

// --- mutation bodies (POST routes). Same shape discipline as the connections
// family: tolerate everything off-shape by refusing with the fixed
// bad_request string, never echoing the caller's bytes.

const MAX_BODY_BYTES = 16 * 1024 // the toggle body is one small object; bigger is a mistake

export interface SolverModeDeps {
  /** override the recorded bind hostname (pure-injection alternative to the
   *  bind_host seam the service stamps at listen) */
  bindHostname?: string
}

interface SolverModeBody {
  mode?: unknown
}

function parseSolverModeBody(rawBody: string): SolverModeBody | undefined {
  if (rawBody.length > MAX_BODY_BYTES) return undefined
  try {
    const parsed: unknown = JSON.parse(rawBody)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined
    return parsed as SolverModeBody
  } catch {
    return undefined
  }
}

/** The distinct refusal this route answers on a non-loopback bind; undefined
 *  when the bind is fine. The loopback family rides the SAME shared signal as
 *  the credential mutations and the vault browser (bind_host.ts, stamped by
 *  the service at listen); undefined (the in-process/no-socket case) counts as
 *  loopback. */
function loopbackRefusal(bind: string | undefined): string | undefined {
  if (isLoopbackHostname(bind)) return undefined
  return synthesizeSolverMode("non_loopback", "solver mutations serve loopback binds only")
}
