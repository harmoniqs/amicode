// ============================================================================
// 0.3 — single-user LLM credential: storage + boot-handoff + the one
// configured/missing signal shared by the healthcheck and the chat-not-ready
// gate.
//
// CANONICAL STORE: ~/.amico/llm.json = { "provider": "<p>", "key": "<secret>" }
//   (single provider at a time — a different provider/model is a config change,
//   not a code change. v1 single-user; keychain/file-perm/revocation hardening
//   and a per-tenant auth seam are LATER phases — named here, not built.)
//
// HANDOFF: the secret flows ONLY into the spawned opencode process's env, via
//   credSpawnEnv() → the provider's well-known API-key var (e.g.
//   ANTHROPIC_API_KEY). It is NEVER passed to amico-run (argv-only, S37) and so
//   can never reach a run-dir artifact (run.toml / result.toml / run.log /
//   FINISHED). The no-leak invariant is asserted at THIS channel, not at the
//   run-dir writer (that's β.1's surface).
//
// Pure ESM (node:fs/os/path only) so the SAME module is importable by the
// extension (esbuild-bundled, typed via llm_creds.d.mts), by the standalone
// healthcheck.mjs (raw node), and by the vitest suite — one source of truth for
// the signal both consumers must agree on.
// ============================================================================
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** provider → the env var opencode reads to resolve that provider at boot. */
const PROVIDER_ENV = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  'amazon-bedrock': 'AWS_BEARER_TOKEN_BEDROCK',
}

/** Env vars / files that mean "a provider credential is already resolvable"
 *  WITHOUT the canonical store — the β-era "creds happen to be in env" path,
 *  kept for back-compat (notably Bedrock via ~/.aws, which has no single key
 *  to put in the store). */
const LEGACY_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_ACCESS_KEY_ID',
  'AWS_PROFILE',
]

/** Absolute path to the canonical credential store. */
export function credStorePath(home) {
  return join(home, '.amico', 'llm.json')
}

/**
 * Read the canonical store.
 *   - missing file        → null            (not configured via the store)
 *   - present + valid      → {provider,key}
 *   - present + malformed  → {error}         (sentinel — never throws)
 * "Malformed" = unparseable JSON, unknown provider, or an empty/missing key.
 */
export function loadLlmCred(home) {
  const p = credStorePath(home)
  if (!existsSync(p)) return null
  let raw
  try {
    raw = JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return { error: `${p} is not valid JSON` }
  }
  const provider = raw && typeof raw.provider === 'string' ? raw.provider : undefined
  const key = raw && typeof raw.key === 'string' ? raw.key : undefined
  if (!provider || !(provider in PROVIDER_ENV)) {
    return { error: `${p}: "provider" must be one of ${Object.keys(PROVIDER_ENV).join(', ')}` }
  }
  if (!key) {
    return { error: `${p}: "key" must be a non-empty string` }
  }
  return { provider, key }
}

/** True iff the value is a valid loaded credential (not null, not a sentinel). */
function isCred(c) {
  return !!c && typeof c === 'object' && typeof c.key === 'string' && typeof c.provider === 'string'
}

/**
 * The injection payload: env vars to overlay onto the opencode spawn so the
 * stored provider resolves with no interactive prompt. Empty for null / a
 * malformed sentinel (nothing to inject — the inherited env stands).
 */
export function credSpawnEnv(cred) {
  if (!isCred(cred)) return {}
  const envVar = PROVIDER_ENV[cred.provider]
  return envVar ? { [envVar]: cred.key } : {}
}

/** Does the ambient env (or ~/.aws) already carry a usable provider credential? */
function legacyEnvResolves(home, env) {
  if (LEGACY_ENV_KEYS.some((k) => env[k])) return true
  return existsSync(join(home, '.aws', 'credentials')) || existsSync(join(home, '.aws', 'config'))
}

/**
 * The single configured/missing signal shared by healthcheck.probeCreds and the
 * extension's chat-not-ready gate. Resolution order: canonical store →
 * back-compat env/~/.aws → not configured.
 *   ok:    { ok:true, provider, source:'store'|'env' }
 *   not:   { ok:false, reason, fix }   (one explicit signal — never a silent hang)
 */
export function resolveLlmCreds({ home, env }) {
  const cred = loadLlmCred(home)
  if (cred && cred.error) {
    return { ok: false, reason: `~/.amico/llm.json is malformed (${cred.error})`, fix: 'fix or remove it — {"provider":"anthropic","key":"sk-…"} (RUNBOOK §4)' }
  }
  if (isCred(cred)) {
    return { ok: true, provider: cred.provider, source: 'store' }
  }
  if (legacyEnvResolves(home, env)) {
    return { ok: true, provider: 'env', source: 'env' }
  }
  return {
    ok: false,
    reason: 'LLM creds not configured',
    fix: 'store a provider key in ~/.amico/llm.json — {"provider":"anthropic","key":"sk-…"} (RUNBOOK §4)',
  }
}
