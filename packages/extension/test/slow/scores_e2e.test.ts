import { describe, it, expect, afterAll } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { buildOpencodeConfigContent, prepareOpencodeProject, resolveJuliaProject } from '../../src/opencode_config'
import { loadState } from '../../src/scores/interview_state'
import { readUsage, reconstructTraversal } from '../../src/scores/usage'

// ============================================================================
// Scores-runtime e2e — router → score #0 → pinned interview_state + usage funnel.
//
// Follows test/slow/interview_e2e.test.ts exactly (same serve/turn pattern, same
// live-gating: skips without AMICODE_E2E_LIVE=1 / creds — a SKIP is not a PASS).
// Differences: AGENTS.md goes through the REAL prepareOpencodeProject, which now
// splices the onset router + compiled score #0 and writes the score_manifest
// transport; AMICODE_ENTITIES_DIR is pinned to a fresh tmp dir so the Bun-side
// guard state (interview_state.json, usage.jsonl) is hermetic and assertable.
// No solve is run here — tier D of the night e2e owns that.
// ============================================================================

const EXT = join(__dirname, '..', '..')
const OC_BIN = join(EXT, 'vendor', 'opencode', `${process.platform}-${process.arch}`, 'opencode')

const AUTH_JSON = join(homedir(), '.local', 'share', 'opencode', 'auth.json')
function hasCreds(): boolean {
  if (process.env.AMICODE_E2E_LIVE === '1') return true
  if (process.env.ANTHROPIC_API_KEY) return true
  try {
    return Object.keys(JSON.parse(readFileSync(AUTH_JSON, 'utf8'))).length > 0
  } catch {
    return false
  }
}

const ENTITIES = mkdtempSync(join(tmpdir(), 'scores-e2e-entities-'))
const servers: ChildProcess[] = []
afterAll(() => {
  for (const c of servers) c.kill('SIGTERM')
})

async function serveWithScores(port: number) {
  // entitiesDir must match between the extension-side builder (permission grant +
  // manifest transport) and the Bun-side plugin — pin it before either runs.
  process.env.AMICODE_ENTITIES_DIR = ENTITIES
  const project = prepareOpencodeProject({
    agentsSrc: join(EXT, 'AGENTS.md'),
    templateSrc: join(EXT, 'templates', 'solve_template.jl'),
    juliaProject: resolveJuliaProject(''),
    entitlementsDir: mkdtempSync(join(tmpdir(), 'scores-e2e-noents-')), // no code → public repertoire
  })
  const env = { ...process.env, AMICODE_ENTITIES_DIR: ENTITIES }
  env.OPENCODE_CONFIG_CONTENT = buildOpencodeConfigContent(project.agentsPath, join(EXT, 'templates', 'solve_template.jl'), join(homedir(), '.amico', 'runs', 'default'))
  let buf = ''
  const child = spawn(OC_BIN, ['serve', '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  servers.push(child)
  child.stdout!.on('data', (c) => (buf += c))
  child.stderr!.on('data', (c) => (buf += c))
  const url = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      const r = await fetch(url + '/', { signal: AbortSignal.timeout(1000) })
      if (r.ok) break
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`serve not ready in 30s; log:\n${buf.slice(0, 2000)}`)
    await new Promise((r) => setTimeout(r, 300))
  }
  return { url, log: () => buf, agentsPath: project.agentsPath }
}

describe.skipIf(!existsSync(OC_BIN) || !hasCreds())('scores runtime live e2e (creds required)', () => {
  it('router opens, score #0 interview starts, state pinned + usage funnel recorded', { timeout: 300_000 }, async () => {
    const s = await serveWithScores(14320)

    // Sanity: the session prep actually compiled the score (not the fallback).
    const agents = readFileSync(s.agentsPath, 'utf8')
    expect(agents).toContain('## Onset router')
    expect(agents).toContain('Compiled from score `pulse-designer` v1')

    const ses = (await (
      await fetch(s.url + '/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    ).json()) as { id: string }
    const turn = async (text: string): Promise<string> => {
      const r = await fetch(`${s.url}/session/${ses.id}/message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent: 'pulse-designer', parts: [{ type: 'text', text }] }),
      })
      expect(r.ok, `message POST ${r.status}`).toBe(true)
      const msg = (await r.json()) as { parts?: Array<{ type: string; text?: string }> }
      return (msg.parts ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('\n')
    }

    const transcript: string[] = []

    // Turn 1: open-ended → the onset router's options (or a proactive stage-1 kickoff —
    // both are protocol-legal; what matters is it offers a way in, one question only).
    const t1 = await turn('hi — what can I do here?')
    transcript.push(`## turn 1 (hi — what can I do here?)\n\n${t1}`)
    expect(t1.toLowerCase()).toMatch(/start from a system|design.*pulse|what do you want to do|platform|system/)
    expect(t1.toLowerCase(), 'no stage-batching in turn 1').not.toMatch(/max_iter|timestep|objective|constraint|drive_max/)

    // Turn 2: choose the system-first path → the PLATFORM question, alone.
    const t2 = await turn('start from a system — walk me through designing a pulse')
    transcript.push(`## turn 2 (start from a system)\n\n${t2}`)
    expect(t2.toLowerCase()).toMatch(/system|platform/)
    expect(t2.toLowerCase(), 'no stage-batching in turn 2').not.toMatch(/max_iter|timestep|objective|constraint|drive_max/)

    // Turn 3: answer → LaTeX confirm + amicode_pick_system records stage/platform.
    const t3 = await turn('transmon')
    transcript.push(`## turn 3 (transmon)\n\n${t3}`)
    expect(t3).toMatch(/\\hat|H\s*\/\s*\\hbar|hamiltonian/i)

    // The guard state is written by the plugin when the tool fires; free-tier models
    // occasionally skip the tool call — one explicit nudge turn is allowed before
    // the hard assertion (rerun-once policy covers residual sampling noise).
    if (!loadState(ENTITIES)) {
      const t4 = await turn('please record that with your amicode tools before we continue')
      transcript.push(`## turn 4 (nudge)\n\n${t4}`)
    }
    writeFileSync(join(tmpdir(), `scores-e2e-transcript-${Date.now()}.md`), transcript.join('\n\n'))

    // Success criterion 1+8 (scores spec §10): pinned state + reconstructable funnel.
    const state = loadState(ENTITIES)
    expect(state, 'interview_state.json written by the guard').toBeDefined()
    expect(state!.score_id).toBe('pulse-designer')
    expect(state!.score_version).toBe(1)

    const traversal = reconstructTraversal(readUsage(ENTITIES))
    expect(traversal.score_id).toBe('pulse-designer')
    expect(traversal.funnel.map((f) => f.stage)).toContain('platform')
  })
})
