import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadLlmCred, credSpawnEnv, resolveLlmCreds } from '../src/llm_creds.mjs'
import { buildOpencodeSpawnEnv } from '../src/opencode_config'

// 0.3 — the single-user LLM credential: canonical store at ~/.amico/llm.json,
// injected into the opencode spawn env at boot, with ONE configured/missing
// signal shared by the healthcheck and the chat-not-ready gate. The credential
// must never leave the spawn-env handoff (never into a run-dir artifact).

let home: string
const writeStore = (obj: unknown) => {
  mkdirSync(join(home, '.amico'), { recursive: true })
  writeFileSync(join(home, '.amico', 'llm.json'), typeof obj === 'string' ? obj : JSON.stringify(obj))
}
// opencode model selection lives in the user's global opencode config — the
// signal requires it (a provider can't resolve with no model selected).
const writeModel = (provider: string) => {
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true })
  writeFileSync(join(home, '.config', 'opencode', 'opencode.json'), JSON.stringify({ model: `${provider}/some-model` }))
}
const writeRawConfig = (s: string) => {
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true })
  writeFileSync(join(home, '.config', 'opencode', 'opencode.json'), s)
}

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'amico-creds-')) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

describe('loadLlmCred', () => {
  it('returns null when no store file exists', () => {
    expect(loadLlmCred(home)).toBeNull()
  })
  it('parses a valid {provider,key} store', () => {
    writeStore({ provider: 'anthropic', key: 'sk-ant-secret' })
    expect(loadLlmCred(home)).toEqual({ provider: 'anthropic', key: 'sk-ant-secret' })
  })
  it('flags malformed JSON with an error sentinel (not a throw)', () => {
    writeStore('{ not json')
    const c = loadLlmCred(home) as { error: string }
    expect(c.error).toBeTruthy()
  })
  it('flags an unknown provider as malformed', () => {
    writeStore({ provider: 'pied-piper', key: 'x' })
    expect((loadLlmCred(home) as { error: string }).error).toBeTruthy()
  })
  it('flags an empty/missing key as malformed', () => {
    writeStore({ provider: 'anthropic', key: '' })
    expect((loadLlmCred(home) as { error: string }).error).toBeTruthy()
  })
  it('flags non-string provider/key (wrong type) as malformed', () => {
    writeStore({ provider: 123, key: {} })
    expect((loadLlmCred(home) as { error: string }).error).toBeTruthy()
  })
})

describe('credSpawnEnv — the injection payload (handoff channel)', () => {
  it('maps anthropic → ANTHROPIC_API_KEY', () => {
    expect(credSpawnEnv({ provider: 'anthropic', key: 'sk-ant-X' })).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-X' })
  })
  it('maps openai → OPENAI_API_KEY', () => {
    expect(credSpawnEnv({ provider: 'openai', key: 'sk-oai-Y' })).toEqual({ OPENAI_API_KEY: 'sk-oai-Y' })
  })
  it('maps amazon-bedrock → AWS_BEARER_TOKEN_BEDROCK', () => {
    expect(credSpawnEnv({ provider: 'amazon-bedrock', key: 'brk-Z' })).toEqual({ AWS_BEARER_TOKEN_BEDROCK: 'brk-Z' })
  })
  it('injects nothing for null (no store) — env is inherited as-is', () => {
    expect(credSpawnEnv(null)).toEqual({})
  })
  it('injects nothing for a malformed sentinel', () => {
    expect(credSpawnEnv({ error: 'bad' } as never)).toEqual({})
  })
})

describe('resolveLlmCreds — the shared configured/missing signal', () => {
  it('ok from the canonical store when the model provider matches (source=store)', () => {
    writeModel('anthropic')
    writeStore({ provider: 'anthropic', key: 'sk-ant-secret' })
    const r = resolveLlmCreds({ home, env: {} })
    expect(r.ok).toBe(true)
    expect(r).toMatchObject({ provider: 'anthropic', source: 'store' })
  })
  it('AC2 — the stored key is re-read from disk each call (no re-entry on a fresh boot)', () => {
    writeModel('anthropic')
    writeStore({ provider: 'anthropic', key: 'sk-ant-secret' })
    // First "boot": resolves. Second "boot" = a fresh call with a clean env and
    // no in-process state — still resolves because the file is re-read, not cached.
    expect(resolveLlmCreds({ home, env: { ANTHROPIC_API_KEY: 'transient' } }).ok).toBe(true)
    expect(resolveLlmCreds({ home, env: {} })).toMatchObject({ ok: true, source: 'store' })
  })
  it('not configured → ONE explicit signal, not a silent pass (AC3)', () => {
    writeModel('anthropic')
    const r = resolveLlmCreds({ home, env: {} })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toMatch(/not configured/i)
      expect(r.fix).toMatch(/llm\.json/)
    }
  })
  it('malformed store → explicit error signal (not a false ok)', () => {
    writeModel('anthropic')
    writeStore('{ broken')
    const r = resolveLlmCreds({ home, env: {} })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/malformed/i)
  })
  it('precedence: a malformed store FAILS LOUD even when env would resolve', () => {
    writeModel('anthropic')
    writeStore('{ broken')
    // ANTHROPIC_API_KEY present, but the corrupt canonical file wins (fail-loud).
    const r = resolveLlmCreds({ home, env: { ANTHROPIC_API_KEY: 'sk-ant-env' } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/malformed/i)
  })
  it('provider mismatch (stored ≠ model) → explicit fail (the demo-killer scenario)', () => {
    writeModel('amazon-bedrock')
    writeStore({ provider: 'anthropic', key: 'sk-ant-secret' })
    const r = resolveLlmCreds({ home, env: {} })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/≠|provider/i)
  })
  it('no opencode config (no model selected) → explicit fail even with a valid store', () => {
    writeStore({ provider: 'anthropic', key: 'sk-ant-secret' })
    const r = resolveLlmCreds({ home, env: {} })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/model/i)
  })
  it('opencode config present but no "model" field → explicit fail', () => {
    writeRawConfig(JSON.stringify({ theme: 'dark' }))
    writeStore({ provider: 'anthropic', key: 'sk-ant-secret' })
    const r = resolveLlmCreds({ home, env: {} })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/no model/i)
  })
  it('unparseable opencode config → explicit fail', () => {
    writeRawConfig('{ not json')
    writeStore({ provider: 'anthropic', key: 'sk-ant-secret' })
    const r = resolveLlmCreds({ home, env: {} })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/not parseable/i)
  })
  it('back-compat: a provider key in env matching the model passes (source=env)', () => {
    writeModel('anthropic')
    const r = resolveLlmCreds({ home, env: { ANTHROPIC_API_KEY: 'sk-ant-env' } })
    expect(r).toMatchObject({ ok: true, source: 'env' })
  })
  it('back-compat: AWS bedrock env passes for a bedrock model (source=env)', () => {
    writeModel('amazon-bedrock')
    const r = resolveLlmCreds({ home, env: { AWS_BEARER_TOKEN_BEDROCK: 'brk' } })
    expect(r.ok).toBe(true)
  })
  it('store wins over env when both present and provider matches the model', () => {
    writeModel('openai')
    writeStore({ provider: 'openai', key: 'sk-oai-store' })
    const r = resolveLlmCreds({ home, env: { OPENAI_API_KEY: 'sk-oai-env' } })
    expect(r).toMatchObject({ provider: 'openai', source: 'store' })
  })
})

describe('no-leak invariant (AC6) + injection wiring (AC1) — buildOpencodeSpawnEnv', () => {
  const SECRET = 'sk-ant-DO-NOT-LEAK'
  const base = { amicoRunBinDir: '/bin/launcher', basePath: '/usr/bin', agentsPath: '/x/AGENTS.md', templatePath: '/x/templates/solve_template.jl' }

  it('AC1: a stored credential actually lands in the spawn env (provider var)', () => {
    const env = buildOpencodeSpawnEnv({ ...base, cred: { provider: 'anthropic', key: SECRET } })
    expect(env.ANTHROPIC_API_KEY).toBe(SECRET)
  })
  it('AC6: the secret appears in EXACTLY ONE env value — never PATH or OPENCODE_CONFIG_CONTENT', () => {
    const env = buildOpencodeSpawnEnv({ ...base, cred: { provider: 'anthropic', key: SECRET } })
    expect(env.PATH).not.toContain(SECRET)
    expect(env.OPENCODE_CONFIG_CONTENT).not.toContain(SECRET)
    const carriers = Object.entries(env).filter(([, v]) => v.includes(SECRET)).map(([k]) => k)
    expect(carriers).toEqual(['ANTHROPIC_API_KEY'])
  })
  it('no credential → no provider var injected (only PATH + config)', () => {
    const env = buildOpencodeSpawnEnv({ ...base, cred: null })
    expect(Object.keys(env).sort()).toEqual(['OPENCODE_CONFIG_CONTENT', 'PATH'])
  })
  it('a malformed sentinel injects nothing (no provider var)', () => {
    const env = buildOpencodeSpawnEnv({ ...base, cred: { error: 'bad' } as never })
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
  })
})
