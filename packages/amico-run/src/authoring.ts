// Authoring config (spec C) — the extension→amico-run seam. Session prep
// writes ~/.amico/authoring/authoring.json (allowlist resolved from
// entitlements + absolute paths to the bundled registry/exemplars/harness
// assets); the gate reads it here. Absent file → conservative built-in
// defaults (public base ∪ support set) so a bare-but-spec'd dev invocation
// still gates sanely. $AMICO_AUTHORING_FILE overrides the path (tests).
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface AuthoringConfig {
  allowlist: string[]      // entitlement-resolved Harmoniqs packages
  support_set: string[]    // fixed support packages the run-dir contract itself needs
  registry?: string        // abs path to templates/registry.toml
  exemplars?: string       // abs path to exemplars/index.json
  verify_harness?: string  // abs path to julia/verify_rollout.jl
  verify_tolerance: number // tier-3 re-rollout agreement (absolute)
}

export const DEFAULT_ALLOWLIST = ['Piccolo', 'Legato', 'Intonato', 'NamedTrajectories', 'DirectTrajOpt']
export const DEFAULT_SUPPORT = ['JLD2', 'CairoMakie', 'Makie', 'TOML', 'Printf']
const DEFAULT_TOLERANCE = 0.001

function defaults(): AuthoringConfig {
  return {
    allowlist: [...DEFAULT_ALLOWLIST],
    support_set: [...DEFAULT_SUPPORT],
    verify_tolerance: DEFAULT_TOLERANCE,
  }
}

export function authoringFile(): string {
  const env = process.env.AMICO_AUTHORING_FILE
  if (env && env.trim() !== '') return env
  return join(homedir(), '.amico', 'authoring', 'authoring.json')
}

export function readAuthoring(): { config: AuthoringConfig; warning?: string } {
  const file = authoringFile()
  if (!existsSync(file)) return { config: defaults() }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return { config: defaults(), warning: `malformed authoring.json at ${file} — using built-in defaults` }
  }
  if (typeof raw !== 'object' || raw === null)
    return { config: defaults(), warning: `authoring.json at ${file} is not an object — using built-in defaults` }
  const data = raw as Record<string, unknown>
  const strings = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : undefined
  return {
    config: {
      allowlist: strings(data.allowlist) ?? [...DEFAULT_ALLOWLIST],
      support_set: strings(data.support_set) ?? [...DEFAULT_SUPPORT],
      registry: typeof data.registry === 'string' ? data.registry : undefined,
      exemplars: typeof data.exemplars === 'string' ? data.exemplars : undefined,
      verify_harness: typeof data.verify_harness === 'string' ? data.verify_harness : undefined,
      verify_tolerance: typeof data.verify_tolerance === 'number' ? data.verify_tolerance : DEFAULT_TOLERANCE,
    },
  }
}
