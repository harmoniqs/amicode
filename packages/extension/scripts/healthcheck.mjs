#!/usr/bin/env node
// Amicode healthcheck — exit 0 iff julia+project, opencode /event, amico-run,
// and LLM creds all resolve; else non-zero with a precise ✗ line per failure.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const EXT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const JULIA_PROJECT = join(homedir(), '.amico', 'julia')          // absolute — '~' is NOT expanded in flags
const CHECK_ORDER = ['julia', 'opencode', 'amicorun', 'creds']
const LABEL = { julia: 'julia+project', opencode: 'opencode /event', amicorun: 'amico-run', creds: 'LLM creds' }

/** PURE: results = { [name]: {ok} | {ok:false,reason,fix} } → { exitCode, lines }. Unit-tested. */
export function resolveChecks(results) {
  const lines = []
  let failed = 0
  for (const name of CHECK_ORDER) {
    const r = results[name] ?? { ok: false, reason: 'not run', fix: 'internal' }
    if (r.ok) lines.push(`✓ ${LABEL[name]}`)
    else { failed++; lines.push(`✗ ${LABEL[name]}: ${r.reason} → ${r.fix}`) }
  }
  lines.push(failed === 0 ? `\nAll ${CHECK_ORDER.length} checks passed.` : `\n${failed} check(s) failed.`)
  return { exitCode: failed === 0 ? 0 : 1, lines }
}

// ---- probe implementations (impure; run only when executed as CLI) ----
function probeJulia() {
  if (!existsSync(JULIA_PROJECT)) return { ok: false, reason: `no julia project at ${JULIA_PROJECT}`, fix: 'run scripts/install.sh' }
  try { execFileSync('julia', [`--project=${JULIA_PROJECT}`, '-e', 'using Piccolo'], { stdio: 'ignore', timeout: 300_000 }); return { ok: true } }
  catch (e) { return { ok: false, reason: `julia/Piccolo load failed (${(e.message || '').slice(0, 80)})`, fix: 'run scripts/install.sh to instantiate' } }
}
function probeOpencode() {
  // spawn β.2's boot_smoke.mjs (process.exit script, no exports) → exit 0 = ok
  try { execFileSync('node', [join(EXT_ROOT, 'test', 'boot_smoke.mjs')], { stdio: 'ignore', timeout: 90_000 }); return { ok: true } }
  catch { return { ok: false, reason: 'vendored opencode did not serve /event 200', fix: 'pnpm --filter amicode-v2 fetch:opencode' } }
}
function probeAmicorun() {
  for (const dir of [join(EXT_ROOT, 'bin', 'launcher'), join(EXT_ROOT, '..', 'amico-run', 'launcher')]) {
    const p = join(dir, 'amico-run')
    if (existsSync(p)) {
      try { execFileSync(p, ['--help'], { stdio: 'ignore', timeout: 15_000 }); return { ok: true } }
      catch (e) { return { ok: false, reason: `amico-run --help failed (${(e.message || '').slice(0, 60)})`, fix: 'rebuild amico-run / check node on PATH' } }
    }
  }
  return { ok: false, reason: 'amico-run launcher not found', fix: 'pnpm -r build (stages bin/) or check the VSIX' }
}
// Strip JSONC comments before JSON.parse — string-aware so `//` inside a string
// (e.g. the "$schema": "https://…" URL, or a model id) is preserved, and a
// `"model"` mentioned inside a real // or /* */ comment can't false-pass.
function stripJsonc(s) {
  return s.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_m, str) => str ?? '')
}

function probeCreds() {
  // config-level only (spec §4): opencode config resolves a model+provider; for
  // amazon-bedrock, AWS creds findable in env or ~/.aws. Not a paid LLM call.
  const cfgPath = [join(homedir(), '.config', 'opencode', 'opencode.jsonc'), join(homedir(), '.config', 'opencode', 'opencode.json')].find(existsSync)
  if (!cfgPath) return { ok: false, reason: 'no opencode config', fix: 'create ~/.config/opencode/opencode.jsonc with a model' }
  let cfg
  try { cfg = JSON.parse(stripJsonc(readFileSync(cfgPath, 'utf8'))) } catch { return { ok: false, reason: 'opencode config not parseable', fix: 'fix the JSON(C) in your opencode config' } }
  const model = typeof cfg.model === 'string' ? cfg.model : undefined
  if (!model) return { ok: false, reason: 'no model in opencode config', fix: 'set "model" in opencode config' }
  if (model.startsWith('amazon-bedrock')) {
    const awsEnv = process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE || process.env.AWS_BEARER_TOKEN_BEDROCK
    const awsFile = existsSync(join(homedir(), '.aws', 'credentials')) || existsSync(join(homedir(), '.aws', 'config'))
    if (!awsEnv && !awsFile) return { ok: false, reason: 'bedrock model but no AWS creds (env or ~/.aws)', fix: 'configure AWS creds for Bedrock' }
  }
  return { ok: true }
}

function main() {
  const results = { julia: probeJulia(), opencode: probeOpencode(), amicorun: probeAmicorun(), creds: probeCreds() }
  const { exitCode, lines } = resolveChecks(results)
  console.log(lines.join('\n'))
  process.exitCode = exitCode
}

// realpath-compare so a symlinked invocation path (e.g. macOS /tmp→/private/tmp)
// can't make this silently no-op and exit 0 — a false "healthcheck passed".
function isMain() {
  if (!process.argv[1]) return false
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) }
  catch { return false }
}
if (isMain()) main()
