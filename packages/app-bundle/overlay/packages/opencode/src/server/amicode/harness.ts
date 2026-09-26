// AMICODE: harness switch routes (#1549) — the engine half of the
// harness.json contract. The app's composer control POSTs {harness} here;
// this route validates the id against the EXTENSION-published registry view
// (harness-options.json — the registry lives in the extension, this side
// never computes it) and writes {harness, status:"switching"} to the ops
// dir. The amicode extension's watcher (packages/extension/src/
// harness_switch.ts) consumes the request and performs the real switch —
// the setting persist and the server restart — settling status:"ready".
// Sibling of the solver-mode flip in connections.ts: same loopback guard,
// same fixed value-free refusals, same atomic switching write.
import { readFileSync } from "node:fs"
import path from "node:path"
import { atomicWriteFileSync } from "./credentials"
import { amicodeOpsDir, isLoopbackHostname, getBindHostname } from "./connections"

/** ops-dir override → ~/.amico/amicode — the SAME resolution the extension's
 *  watcher reads (substrate/vault_store.ts amicodeOpsDir), so the watcher
 *  reads exactly where this route writes and tests stay hermetic. */
export function harnessFile(): string {
  return path.join(amicodeOpsDir(), "harness.json")
}

export function harnessOptionsFile(): string {
  return path.join(amicodeOpsDir(), "harness-options.json")
}

export interface HarnessOptionView {
  id: string
  displayName: string
  state: "ready" | "needs-setup"
  detail: string
  disabled: boolean
  reason?: string
}

export interface HarnessOptionsView {
  current: string
  options: HarnessOptionView[]
}

/** Tolerant {harness, status} read — the solver-mode reader's semantics:
 *  anything absent/off-shape collapses to opencode/ready. */
export function readHarnessState(file: string = harnessFile()): { harness: string; status: "ready" | "switching" } {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { harness?: unknown; status?: unknown }
    return {
      harness: typeof parsed.harness === "string" && parsed.harness !== "" ? parsed.harness : "opencode",
      status: parsed.status === "switching" ? "switching" : "ready",
    }
  } catch {
    return { harness: "opencode", status: "ready" }
  }
}

/** Tolerant registry-view read — undefined when the extension hasn't
 *  published one (standalone opencode, extension not yet booted). Entries
 *  missing required fields are dropped, not repaired. */
export function readHarnessOptions(file: string = harnessOptionsFile()): HarnessOptionsView | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { current?: unknown; options?: unknown }
    if (!Array.isArray(parsed.options)) return undefined
    const options: HarnessOptionView[] = []
    for (const raw of parsed.options) {
      if (typeof raw !== "object" || raw === null) continue
      const entry = raw as Record<string, unknown>
      if (typeof entry.id !== "string" || entry.id === "") continue
      if (typeof entry.displayName !== "string") continue
      if (entry.state !== "ready" && entry.state !== "needs-setup") continue
      if (typeof entry.disabled !== "boolean") continue
      options.push({
        id: entry.id,
        displayName: entry.displayName,
        state: entry.state,
        detail: typeof entry.detail === "string" ? entry.detail : "",
        disabled: entry.disabled,
        ...(typeof entry.reason === "string" ? { reason: entry.reason } : {}),
      })
    }
    if (options.length === 0) return undefined
    return {
      current: typeof parsed.current === "string" && parsed.current !== "" ? parsed.current : "opencode",
      options,
    }
  } catch {
    return undefined
  }
}

// --- mutation body (POST). Sibling discipline with the connection routes:
// never reject, ok:false + "code: detail" on failure, every failure message a
// FIXED string — nothing the caller sent is ever echoed.

export function synthesizeHarness(code: string, detail: string): string {
  return JSON.stringify({ ok: false, harness: null, error: `${code}: ${detail}` })
}

const MAX_BODY_BYTES = 16 * 1024

/** The FIXED partial-failure warning (sibling "code: detail" shape). */
export const HARNESS_SWITCH_WARNING = "harness_switch_failed: the harness switch could not be requested"

/** GET /amicode/harness — the current harness + the published registry view.
 *  `current` prefers the extension's setting-backed view; the handshake
 *  file's harness only speaks when no view exists yet. A response without
 *  `options` means "no registry published" — the composer control stays
 *  hidden (stock-opencode behavior, unchanged). */
export function harnessStateResponse(): string {
  const options = readHarnessOptions()
  const state = readHarnessState()
  const harness = options?.current ?? state.harness
  return JSON.stringify({
    ok: true,
    harness,
    status: state.status,
    ...(options !== undefined ? { options: options.options } : {}),
  })
}

/** POST /amicode/harness — body {harness}. Validates against the published
 *  registry view, no-ops when the harness is already current (the watcher is
 *  never poked for nothing), and otherwise writes the switching request the
 *  extension watcher performs. NEVER throws. */
export function harnessResponse(rawBody: string): string {
  const bind = getBindHostname()
  if (!isLoopbackHostname(bind)) return synthesizeHarness("non_loopback", "harness mutations serve loopback binds only")
  let parsed: unknown
  try {
    if (rawBody.length > MAX_BODY_BYTES) return synthesizeHarness("bad_request", "body must be JSON {harness}")
    parsed = JSON.parse(rawBody)
  } catch {
    return synthesizeHarness("bad_request", "body must be JSON {harness}")
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return synthesizeHarness("bad_request", "body must be JSON {harness}")
  }
  const requested = (parsed as { harness?: unknown }).harness
  if (typeof requested !== "string" || requested === "") {
    return synthesizeHarness("bad_request", "body must be JSON {harness}")
  }
  // The registry view IS the id allowlist: the engine never hardcodes
  // harness identity (the wire-protocol rule) — the extension publishes it.
  const options = readHarnessOptions()
  if (options === undefined) {
    return synthesizeHarness("registry_unavailable", "no harness registry is published — is the Amicode extension running?")
  }
  if (!options.options.some((o) => o.id === requested)) {
    return synthesizeHarness("unsupported_harness", "the requested harness is not in the published registry")
  }
  if (requested === options.current) {
    return JSON.stringify({ ok: true, harness: requested, noop: true, error: null })
  }
  try {
    atomicWriteFileSync(harnessFile(), JSON.stringify({ harness: requested, status: "switching" }))
  } catch {
    return JSON.stringify({ ok: false, harness: null, error: HARNESS_SWITCH_WARNING })
  }
  return JSON.stringify({ ok: true, harness: requested, noop: false, error: null })
}
