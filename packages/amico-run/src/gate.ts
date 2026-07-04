// The --spec launch gate (spec C) — the ONE enforcement point that is not an
// agent honor system, and it holds under both today's bash launch and the
// future Scheduler. Steps, in spec order: (1) schema validation; (2) import
// scan against the entitlement allowlist; (3) tier/env consistency incl. the
// per-binding Manifest staleness check (#74 extension — a project/sandbox
// env is validated against its OWN Manifest, not the extension-pinned one);
// (4) tier-2 masked-baseline check; (5) stamp assembly (canonical spec +
// gate-computed spec_hash). Any failure → no Julia process, one clear line.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { validate } from '@amicode/schema'
import type { AuthoringConfig } from './authoring.js'
import { checkImports, scanImports } from './import_scan.js'
import { maskedHash } from './baseline.js'
import { loadExemplarsIndex } from './catalog.js'

export interface GateStamp {
  tier?: string
  hashes: Record<string, string>   // spec hashes + gate-computed spec_hash
  specCanonical: string            // stable-key-order JSON, what gets persisted
}

export type GateResult =
  | { ok: true; stamp: GateStamp }
  | { ok: false; reason: string; demote_to?: 'free' }

/** Stable key order at every level so spec_hash is insensitive to author key order. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort())
      out[key] = canonicalize((value as Record<string, unknown>)[key])
    return out
  }
  return value
}

/** Julia Manifest v2 keys deps as [[deps.<Name>]] — the parsed `deps` object's
 *  keys ARE the package names. Every Project [deps] name must appear. */
function staleEnvCheck(projectDir: string): string | undefined {
  const projectFile = join(projectDir, 'Project.toml')
  const manifestFile = join(projectDir, 'Manifest.toml')
  if (!existsSync(projectFile)) return `env has no Project.toml at ${projectDir}`
  if (!existsSync(manifestFile))
    return `env at ${projectDir} has no Manifest.toml — instantiate it first (JULIA_PKG_USE_CLI_GIT=true julia --project=${projectDir} -e 'using Pkg; Pkg.instantiate()')`
  try {
    const project = parseToml(readFileSync(projectFile, 'utf8')) as Record<string, unknown>
    const manifest = parseToml(readFileSync(manifestFile, 'utf8')) as Record<string, unknown>
    const wanted = Object.keys((project.deps as Record<string, unknown>) ?? {})
    const present = new Set(Object.keys((manifest.deps as Record<string, unknown>) ?? {}))
    const missing = wanted.filter((name) => !present.has(name))
    if (missing.length > 0)
      return `stale env: ${missing.join(', ')} in Project.toml but not its Manifest — re-instantiate`
  } catch (e) {
    return `env at ${projectDir} has an unparseable Project/Manifest: ${(e as Error).message}`
  }
  return undefined
}

export function runGate(specRaw: unknown, scriptText: string, authoring: AuthoringConfig): GateResult {
  // ── step 1: schema ──
  const validation = validate(specRaw, 'solvespec')
  if (!validation.ok) return { ok: false, reason: `solvespec schema: ${validation.errors[0]}` }
  const spec = specRaw as Record<string, unknown>
  const tier = typeof spec.tier === 'string' ? spec.tier : undefined
  const env = (typeof spec.env === 'object' && spec.env !== null ? spec.env : undefined) as
    | { kind?: string; project?: string }
    | undefined

  // ── step 2: import scan ──
  const scanned = scanImports(scriptText)
  if (!scanned.ok) return { ok: false, reason: scanned.reason }
  const checked = checkImports(scanned.roots, authoring)
  if (!checked.ok) return { ok: false, reason: checked.reason }

  // ── step 3: tier/env consistency ──
  if (tier === 'free' && env?.kind !== 'sandbox')
    return { ok: false, reason: 'free tier requires a sandbox env (env.kind = "sandbox")' }
  if ((env?.kind === 'project' || env?.kind === 'sandbox') && env.project) {
    const stale = staleEnvCheck(env.project)
    if (stale) return { ok: false, reason: stale }
  }

  // ── step 4: composed → masked baseline vs the exemplar's build-time hash ──
  if (tier === 'composed') {
    const exemplarId = (spec.source as Record<string, unknown> | undefined)?.exemplar_id
    if (typeof exemplarId !== 'string')
      return { ok: false, reason: 'tier "composed" requires source.exemplar_id' }
    const index = loadExemplarsIndex(authoring.exemplars ?? '')
    const entry = index.exemplars.find((e) => e.id === exemplarId)
    if (!entry) return { ok: false, reason: `unknown exemplar_id "${exemplarId}" (index: ${authoring.exemplars ?? 'absent'})` }
    if (maskedHash(scriptText, entry.fill_begin, entry.fill_end) !== entry.baseline_hash)
      return {
        ok: false,
        reason: `script is no longer the exemplar's physics (edits outside the fill points of "${exemplarId}") — re-assemble as tier "free"`,
        demote_to: 'free',
      }
  }

  // ── step 5: stamp — canonical spec + gate-computed spec_hash ──
  const specCanonical = JSON.stringify(canonicalize(spec), null, 2)
  const specHash = 'sha256:' + createHash('sha256').update(specCanonical).digest('hex')
  const hashes: Record<string, string> = {}
  if (typeof spec.hashes === 'object' && spec.hashes !== null)
    for (const [key, value] of Object.entries(spec.hashes as Record<string, unknown>))
      if (typeof value === 'string') hashes[key] = value
  hashes.spec_hash = specHash
  return { ok: true, stamp: { tier, hashes, specCanonical } }
}
