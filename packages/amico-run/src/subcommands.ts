// amico-run subcommands (spec C): `resolve` (mechanical tier resolution the
// agent calls to pick a tier + source + packages) and `sandbox` (generate a
// per-problem Julia project from a package set). Both are bash-callable from
// the Amicode workflow. Dispatch only fires when argv[0] is the literal
// subcommand AND is not an existing file (a bare script named `resolve` keeps
// the launch contract).
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { readAuthoring } from './authoring.js'
import { loadExemplarsIndex, loadRegistry, matchShape } from './catalog.js'
import { JULIA_STDLIBS } from './import_scan.js'

/** Tier-3 minimum package set — the free skeleton's `using` block AND the
 *  re-rollout harness both need these in the sandbox env, so `resolve` returns
 *  them for tier free (an empty set would generate an uninstantiable env). */
const TIER3_MIN_PACKAGES = ['Piccolo', 'CairoMakie', 'JLD2', 'TOML', 'Printf']

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined
}

export function resolveCommand(argv: string[]): number {
  const platform = flagValue(argv, '--platform')
  const kind = flagValue(argv, '--kind')
  const sizeRaw = flagValue(argv, '--size')
  if (!platform || !kind || !sizeRaw) {
    console.error('amico-run resolve: --platform, --kind, --size are all required')
    return 64
  }
  const size = Number(sizeRaw)
  if (!Number.isFinite(size)) { console.error(`amico-run resolve: --size must be a number (got ${sizeRaw})`); return 64 }

  const { config } = readAuthoring()
  const registry = loadRegistry(config.registry ?? '')
  const exemplars = loadExemplarsIndex(config.exemplars ?? '')
  const match = matchShape({ platform, kind, size }, registry, exemplars, config.allowlist)

  // template/exemplar paths in the catalog are relative to their manifest file;
  // resolve to absolute so the agent can copy the script directly.
  const registryDir = config.registry ? dirname(config.registry) : process.cwd()
  const exemplarsDir = config.exemplars ? dirname(config.exemplars) : process.cwd()
  const out: Record<string, unknown> = { tier: match.tier }
  if (match.template) {
    out.source = { template_id: match.template.id }
    out.template_path = resolve(registryDir, match.template.path)
    out.packages = match.template.packages
  } else if (match.exemplar) {
    out.source = { exemplar_id: match.exemplar.id }
    out.exemplar_path = resolve(exemplarsDir, match.exemplar.path)
    out.packages = match.exemplar.packages
  } else {
    out.packages = TIER3_MIN_PACKAGES
  }
  if (match.blockedHigher) out.blocked_higher = match.blockedHigher
  console.log(JSON.stringify(out))
  return 0
}

export function sandboxCommand(argv: string[]): number {
  const target = argv[0]
  if (!target || target.startsWith('-')) { console.error('amico-run sandbox: <workspace-dir> required'); return 64 }
  const packagesRaw = flagValue(argv, '--packages')
  if (!packagesRaw) { console.error('amico-run sandbox: --packages A,B,… required'); return 64 }
  const packages = packagesRaw.split(',').map((p) => p.trim()).filter(Boolean)

  // Julia stdlibs load from @stdlib in LOAD_PATH regardless of a project's
  // [deps] — they need no uuid and no [deps] entry. Filter them so the sandbox
  // is robust to ANY stdlib an authored script imports (spec-20260704-113005 §3
  // defect #2: TIER3_MIN_PACKAGES ships Printf+TOML, both stdlibs with no
  // [uuids] entry, which exit-64'd every tier-free launch at env generation).
  // Non-stdlib packages still require a uuid — the unknown-package guard holds.
  const depsNeeded = packages.filter((p) => !JULIA_STDLIBS.has(p))

  const { config } = readAuthoring()
  const registry = loadRegistry(config.registry ?? '')
  const missing = depsNeeded.filter((p) => !registry.uuids[p])
  if (missing.length > 0) {
    console.error(`amico-run sandbox: no uuid in the registry for: ${missing.join(', ')}`)
    return 64
  }

  const deps = depsNeeded
    .slice()
    .sort()
    .map((p) => `${p} = ${JSON.stringify(registry.uuids[p])}`)
    .join('\n')
  const envDir = join(target, 'env')
  mkdirSync(envDir, { recursive: true })
  writeFileSync(join(envDir, 'Project.toml'), `[deps]\n${deps}\n`)
  console.log(`amico-run: wrote ${join(envDir, 'Project.toml')}`)
  console.log(`instantiate it (private git deps need CLI git):`)
  console.log(`  JULIA_PKG_USE_CLI_GIT=true julia --project=${envDir} -e 'using Pkg; Pkg.instantiate()'`)
  return 0
}

/** Dispatch a subcommand if argv[0] names one and is not an existing file. */
export function trySubcommand(argv: string[]): number | undefined {
  const head = argv[0]
  if (head === 'resolve' && !existsSync(head)) return resolveCommand(argv.slice(1))
  if (head === 'sandbox' && !existsSync(head)) return sandboxCommand(argv.slice(1))
  return undefined
}
