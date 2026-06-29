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
// HANDOFF: the secret flows into the spawned opencode process's env, via
//   credSpawnEnv() → the provider's well-known API-key var (e.g.
//   ANTHROPIC_API_KEY). 0.3 puts the secret in NO other channel it owns: not in
//   OPENCODE_CONFIG_CONTENT, not in any run-dir artifact. amico-run is argv-only
//   (S37) so 0.3 never hands it the value either. (The provider key is present
//   in opencode's child env and inherited by descendants — that's how opencode
//   resolves the provider — but nothing 0.3 owns persists it to a run-dir file;
//   a run.log env-dump would be β.1's surface, out of scope here.)
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

// Strip JSONC comments before JSON.parse — string-aware so `//` inside a string
// (e.g. the "$schema": "https://…" URL, or a model id) is preserved, and a
// `"model"` mentioned inside a real // or /* */ comment can't false-pass.
function stripJsonc(s) {
  return s.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_m, str) => str ?? '')
}

/**
 * The model opencode will use, read from ~/.config/opencode/opencode.{jsonc,json}.
 * opencode merges our OPENCODE_CONFIG_CONTENT OVER this file but preserves its
 * `model`, so this is where the provider selection lives.
 *   { model } | { missing:true } | { parseError:true }
 */
function readOpencodeModel(home) {
  const cfgPath = [
    join(home, '.config', 'opencode', 'opencode.jsonc'),
    join(home, '.config', 'opencode', 'opencode.json'),
  ].find(existsSync)
  if (!cfgPath) return { missing: true }
  let cfg
  try {
    cfg = JSON.parse(stripJsonc(readFileSync(cfgPath, 'utf8')))
  } catch {
    return { parseError: true }
  }
  return { model: typeof cfg.model === 'string' ? cfg.model : undefined }
}

/** opencode model ids are `provider/model-id` — the provider is the prefix. */
function providerOfModel(model) {
  return model.split('/')[0]
}

/** Does the ambient env (or ~/.aws) already carry a credential for `provider`? */
function envResolvesForProvider(provider, home, env) {
  if (provider === 'amazon-bedrock') {
    if (env.AWS_ACCESS_KEY_ID || env.AWS_PROFILE || env.AWS_BEARER_TOKEN_BEDROCK) return true
    return existsSync(join(home, '.aws', 'credentials')) || existsSync(join(home, '.aws', 'config'))
  }
  const envVar = PROVIDER_ENV[provider]
  return !!(envVar && env[envVar])
}

/**
 * The single configured/missing signal shared by healthcheck.probeCreds and the
 * extension's chat-not-ready gate. For chat to resolve a provider with no
 * prompt, ALL must hold: opencode has a `model` selected, a credential for that
 * model's provider resolves (canonical store → back-compat env/~/.aws), and a
 * stored provider matches the selected model.
 *   ok:  { ok:true, provider, source:'store'|'env' }
 *   not: { ok:false, reason, fix }   (one explicit signal — never a silent hang)
 *
 * Precedence: a MALFORMED store is reported first (fail loud on a file the user
 * clearly intended to use, rather than silently falling back to env creds for a
 * possibly-different provider).
 */
export function resolveLlmCreds({ home, env }) {
  const cred = loadLlmCred(home)
  if (cred && cred.error) {
    return { ok: false, reason: `~/.amico/llm.json is malformed (${cred.error})`, fix: 'fix or remove it — {"provider":"anthropic","key":"sk-…"} (RUNBOOK §4)' }
  }

  // opencode must have a model selected — without one, no provider resolves
  // regardless of stored creds (a Q129 cause).
  const m = readOpencodeModel(home)
  if (m.missing) return { ok: false, reason: 'no opencode config (model not selected)', fix: 'create ~/.config/opencode/opencode.jsonc with a "model" (RUNBOOK §4b)' }
  if (m.parseError) return { ok: false, reason: 'opencode config not parseable', fix: 'fix the JSON(C) in ~/.config/opencode/opencode.{jsonc,json}' }
  if (!m.model) return { ok: false, reason: 'no model in opencode config', fix: 'set "model" in ~/.config/opencode/opencode.jsonc (RUNBOOK §4b)' }
  const provider = providerOfModel(m.model)

  if (isCred(cred)) {
    if (cred.provider !== provider) {
      return { ok: false, reason: `stored provider "${cred.provider}" ≠ opencode model provider "${provider}"`, fix: 'make ~/.amico/llm.json provider match the opencode model, or change the model (RUNBOOK §4)' }
    }
    return { ok: true, provider: cred.provider, source: 'store' }
  }

  if (envResolvesForProvider(provider, home, env)) {
    return { ok: true, provider, source: 'env' }
  }

  return {
    ok: false,
    reason: 'LLM creds not configured',
    fix: `store a ${provider} key in ~/.amico/llm.json — {"provider":"${provider}","key":"…"} (RUNBOOK §4)`,
  }
}
