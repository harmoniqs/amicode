import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadLlmCred, credSpawnEnv, resolveLlmCreds } from '../src/llm_creds.mjs'
import { buildOpencodeConfigContent } from '../src/opencode_config'

// 0.3 — the single-user LLM credential: canonical store at ~/.amico/llm.json,
// injected into the opencode spawn env at boot, with ONE configured/missing
// signal shared by the healthcheck and the chat-not-ready gate. The credential
// must never leave the spawn-env handoff (never into a run-dir artifact).

let home: string
const writeStore = (obj: unknown) => {
  mkdirSync(join(home, '.amico'), { recursive: true })
  writeFileSync(join(home, '.amico', 'llm.json'), typeof obj === 'string' ? obj : JSON.stringify(obj))
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
  it('ok from the canonical store (source=store)', () => {
    writeStore({ provider: 'anthropic', key: 'sk-ant-secret' })
    const r = resolveLlmCreds({ home, env: {} })
    expect(r.ok).toBe(true)
    expect(r).toMatchObject({ provider: 'anthropic', source: 'store' })
  })
  it('a freshly-stored key resolves on a subsequent call with a clean env (AC2)', () => {
    writeStore({ provider: 'anthropic', key: 'sk-ant-secret' })
    expect(resolveLlmCreds({ home, env: {} }).ok).toBe(true)
  })
  it('not configured → ONE explicit signal, not a silent pass (AC3)', () => {
    const r = resolveLlmCreds({ home, env: {} })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toMatch(/not configured/i)
      expect(r.fix).toMatch(/llm\.json/)
    }
  })
  it('malformed store → explicit error signal (not a false ok)', () => {
    writeStore('{ broken')
    const r = resolveLlmCreds({ home, env: {} })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/malformed/i)
  })
  it('back-compat: a provider key already in env passes (source=env)', () => {
    const r = resolveLlmCreds({ home, env: { ANTHROPIC_API_KEY: 'sk-ant-env' } })
    expect(r.ok).toBe(true)
    expect(r).toMatchObject({ source: 'env' })
  })
  it('back-compat: AWS bedrock env passes (source=env)', () => {
    const r = resolveLlmCreds({ home, env: { AWS_BEARER_TOKEN_BEDROCK: 'brk' } })
    expect(r.ok).toBe(true)
  })
  it('store wins over env (canonical location is authoritative)', () => {
    writeStore({ provider: 'openai', key: 'sk-oai-store' })
    const r = resolveLlmCreds({ home, env: { ANTHROPIC_API_KEY: 'sk-ant-env' } })
    expect(r).toMatchObject({ provider: 'openai', source: 'store' })
  })
})

describe('no-leak invariant (AC6) — the secret stays in the spawn-env handoff', () => {
  const SECRET = 'sk-ant-DO-NOT-LEAK'
  it('the credential reaches the injection payload', () => {
    expect(credSpawnEnv({ provider: 'anthropic', key: SECRET })).toEqual({ ANTHROPIC_API_KEY: SECRET })
  })
  it('the opencode CONFIG handoff (which can end up logged) never carries the secret', () => {
    // buildOpencodeConfigContent is the OTHER thing handed to opencode; it must
    // be a pure function of paths — structurally incapable of carrying the key.
    const cfg = buildOpencodeConfigContent('/x/AGENTS.md', '/x/templates/solve_template.jl')
    expect(cfg).not.toContain(SECRET)
  })
})
