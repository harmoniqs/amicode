import { describe, it, expect, afterAll } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { buildOpencodeConfigContent, prepareOpencodeProject, resolveJuliaProject } from '../../src/opencode_config'

// ============================================================================
// T13 e2e — pulse-designer interview against the REAL vendored binary.
//
// Boots `opencode serve` with the SAME OPENCODE_CONFIG_CONTENT injection the
// extension performs (real builder import — no transcribed config, no drift;
// the sanctioned pattern from test/opencode_config.test.ts), extended with the
// Layer-0 registration: the pulse-designer agent block + the amicode_* plugin.
//
// Tiers (each skips independently, so the suite is green in any machine state):
//   A. creds-free, hermetic HOME — agent registration visible via GET /agent
//   B. creds-free, hermetic HOME — plugin module loads on session creation
//   C. creds-gated, REAL HOME    — two live interview turns (one-question
//      cadence + LaTeX). Needs `opencode auth login` (or ANTHROPIC_API_KEY).
//
// NOTE: /health is NOT a real route at v1.17.3 (SPA fallback answers it) —
// readiness is polled on `GET /` + the listening log line instead.
// ============================================================================

const EXT = join(__dirname, '..', '..')
const OC_BIN = join(EXT, 'vendor', 'opencode', `${process.platform}-${process.arch}`, 'opencode')
const PLUGIN = join(EXT, 'opencode-plugin', 'amicode_tools.ts')
const AGENTS_SRC = join(EXT, 'AGENTS.md')

const AUTH_JSON = join(homedir(), '.local', 'share', 'opencode', 'auth.json')
function hasCreds(): boolean {
  if (process.env.AMICODE_E2E_LIVE === '1') return true // force: e.g. opencode's free anonymous tier resolves without auth.json
  if (process.env.ANTHROPIC_API_KEY) return true
  try {
    return Object.keys(JSON.parse(readFileSync(AUTH_JSON, 'utf8'))).length > 0
  } catch {
    return false
  }
}

/** The extension's real config content — since the L0 registration landed in
 *  buildOpencodeConfigContent itself (agent block + plugin path), the builder
 *  output is used verbatim: zero test-local drift. */
function layer0Config(agentsPath: string): string {
  return buildOpencodeConfigContent(agentsPath, join(EXT, 'templates', 'solve_template.jl'))
}

interface Server { child: ChildProcess; url: string; log: () => string }
const servers: ChildProcess[] = []

async function serve(opts: { hermetic: boolean; port: number }): Promise<Server> {
  let env: NodeJS.ProcessEnv
  let agentsPath: string
  if (opts.hermetic) {
    const home = mkdtempSync(join(tmpdir(), 'e2ehome-'))
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true })
    writeFileSync(join(home, '.config', 'opencode', 'opencode.json'), JSON.stringify({}))
    agentsPath = join(home, 'AGENTS.md')
    writeFileSync(agentsPath, readFileSync(AGENTS_SRC, 'utf8')) // unsubstituted is fine for A/B
    env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share') }
  } else {
    // Real home: user creds + global config load (deliberate, tiers C/D). AGENTS.md
    // goes through the extension's REAL session prep so {{TEMPLATE_PATH}} /
    // {{JULIA_PROJECT}} are substituted — stage 6 depends on the real paths.
    const project = prepareOpencodeProject({
      agentsSrc: AGENTS_SRC,
      templateSrc: join(EXT, 'templates', 'solve_template.jl'),
      juliaProject: resolveJuliaProject(''),
    })
    agentsPath = project.agentsPath
    env = { ...process.env }
  }
  env.OPENCODE_CONFIG_CONTENT = layer0Config(agentsPath)
  let buf = ''
  const child = spawn(OC_BIN, ['serve', '--port', String(opts.port)], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  servers.push(child)
  child.stdout!.on('data', (c) => (buf += c))
  child.stderr!.on('data', (c) => (buf += c))
  const url = `http://127.0.0.1:${opts.port}`
  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      const r = await fetch(url + '/', { signal: AbortSignal.timeout(1000) })
      if (r.ok) break
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`serve not ready in 30s; log:\n${buf.slice(0, 2000)}`)
    await new Promise((r) => setTimeout(r, 300))
  }
  return { child, url, log: () => buf }
}

afterAll(() => {
  for (const c of servers) {
    c.kill('SIGTERM')
  }
})

describe.skipIf(!existsSync(OC_BIN))('L0 registration against the real binary (creds-free)', () => {
  it('A: pulse-designer appears in GET /agent', { timeout: 60_000 }, async () => {
    const s = await serve({ hermetic: true, port: 14310 })
    const agents = (await (await fetch(s.url + '/agent')).json()) as Array<{ name: string }>
    expect(agents.map((a) => a.name)).toContain('pulse-designer')
  })

  it.skipIf(!existsSync(PLUGIN))('B: amicode_tools plugin loads on session creation', { timeout: 60_000 }, async () => {
    const s = await serve({ hermetic: true, port: 14311 })
    const r = await fetch(s.url + '/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(r.ok).toBe(true)
    const deadline = Date.now() + 15_000
    while (!s.log().includes('[amicode-tools]') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 300))
    expect(s.log(), 'plugin load line in serve log').toContain('[amicode-tools]')
  })
})

describe.skipIf(!existsSync(OC_BIN) || !hasCreds())('live interview turns (creds required)', () => {
  it('C: opens with ONE platform question, then LaTeX on "transmon"', { timeout: 300_000 }, async () => {
    const s = await serve({ hermetic: false, port: 14312 })
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

    const q1 = await turn('help me design a pulse')
    expect(q1.toLowerCase()).toMatch(/system|platform/)
    // One question AT A TIME = stage 1 only. Multiple "?" inside the platform
    // question (listing options) is fine; asking stage-2+ topics in the same
    // breath is the real protocol violation.
    expect(q1.toLowerCase(), 'no stage-batching in turn 1').not.toMatch(/max_iter|timestep|objective|constraint|drive_max|how many levels/)

    const q2 = await turn('transmon')
    expect(q2).toMatch(/\\hat|H\s*\/\s*\\hbar|hamiltonian/i)

    writeFileSync(
      join(tmpdir(), `amicode-e2e-transcript-${Date.now()}.md`),
      `# tier C transcript\n\n## turn 1 (help me design a pulse)\n\n${q1}\n\n## turn 2 (transmon)\n\n${q2}\n`,
    )
  })

  it.skipIf(process.env.AMICODE_E2E_FULLCHAIN !== '1')(
    'D: full chain — interview through a REAL launched solve (MVP DoD)',
    { timeout: 900_000 },
    async () => {
      const RUNS = join(homedir(), '.amico', 'runs', 'default')
      const before = new Set(existsSync(RUNS) ? require('node:fs').readdirSync(RUNS) : [])

      const s = await serve({ hermetic: false, port: 14314 })
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

      // Keyword-routed answers — the model controls stage order, we answer whatever
      // it asks. Bounded turns; exit as soon as it reports the launch.
      const route = (q: string): string => {
        const l = q.toLowerCase()
        if (/launched|run inspector/.test(l)) return ''
        if (/system|platform/.test(l) && !/frequency|levels/.test(l)) return 'transmon'
        if (/omega|frequency|\\omega|delta|anharmonicity/.test(l)) return 'omega = 4.8 GHz, delta = -0.2 GHz'
        if (/levels|parameteriz|drive_max|drive bound|amplitude/.test(l)) return '3 levels, default drives'
        if (/simulate|warm start|straight to solve|mode/.test(l)) return 'straight to solve, no warm start'
        if (/gate|target|state prep|problem/.test(l)) return 'an X gate'
        if (/objective|constraint/.test(l)) return 'defaults are fine'
        if (/max_iter|iterations|gate time|timesteps|solve param|\bT\b|\bN\b/.test(l)) return 'T = 10 ns, N = 50, max_iter = 60 — launch it'
        return 'defaults are fine — continue'
      }

      const transcript: string[] = []
      let reply = await turn('help me design a pulse for my transmon — walk me through it')
      transcript.push(`## turn 1\n\n${reply}`)
      let launched = /solve launched|run inspector/i.test(reply)
      for (let t = 2; t <= 14 && !launched; t++) {
        const answer = route(reply)
        reply = await turn(answer)
        transcript.push(`## turn ${t} (sent: ${answer})\n\n${reply}`)
        launched = /solve launched|run inspector/i.test(reply)
      }
      writeFileSync(join(tmpdir(), `amicode-e2e-fullchain-${Date.now()}.md`), transcript.join('\n\n'))
      expect(launched, 'agent reported the launch').toBe(true)

      // A NEW run-dir appears and completes.
      const deadline = Date.now() + 420_000
      let newRun: string | undefined
      for (;;) {
        const now = existsSync(RUNS) ? (require('node:fs').readdirSync(RUNS) as string[]) : []
        newRun = now.find((d) => !before.has(d) && d.startsWith('r'))
        if (newRun && existsSync(join(RUNS, newRun, 'FINISHED'))) break
        if (Date.now() > deadline) throw new Error(`no FINISHED run-dir (newRun=${newRun})`)
        await new Promise((r) => setTimeout(r, 5000))
      }
      const result = readFileSync(join(RUNS, newRun!, 'result.toml'), 'utf8')
      const fidelity = Number(/fidelity\s*=\s*([0-9.eE+-]+)/.exec(result)?.[1])
      expect(fidelity, `fidelity from ${newRun}`).toBeGreaterThan(0.99)

      // Entity bookkeeping (soft — free-tier models may skip tool calls; a miss is
      // a prompt-strength finding, not a chain failure).
      const entDir = join(homedir(), '.amico', 'runs', 'default', '_entities')
      if (!existsSync(join(entDir, 'system.toml'))) {
        console.warn('[tier D] amicode_pick_system was not called — record as prompt-strength finding')
      }
    },
  )
})
