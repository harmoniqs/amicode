import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpRoot, fakeJulia, readToml } from './helpers.js'
import { LocalExecutor } from '../src/local_executor.js'
import { validateManifest, validateFinished } from '../src/schemas.js'
import type { RunEvent } from '../src/types.js'

const CLEAN = `
console.log('AMICODE_ITER iter=1 f=1.0e-2')
console.log('AMICODE_ITER iter=2 f=3.0e-4')
console.log('DONE fidelity=0.9999')
`

async function collect(events: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = []
  for await (const e of events) out.push(e)
  return out
}

describe('LocalExecutor happy path', () => {
  it('produces a conforming run dir and ordered event stream', async () => {
    const root = tmpRoot()
    const julia = fakeJulia(root, 'julia-clean', CLEAN)
    const script = fakeJulia(root, 'solve.jl', '')   // content irrelevant; must exist
    const h = await new LocalExecutor().submit(script, {
      lab: 'testlab', runsRoot: join(root, 'runs'), julia: { julia },
    })

    // manifest observable before events finish — submit() resolved, so it must exist NOW
    const manifest = readToml(join(h.runDir, 'manifest.toml'))
    expect(validateManifest(manifest).ok).toBe(true)
    expect(manifest.lab_id).toBe('testlab')

    const evs = await collect(h.events)
    expect(evs.filter(e => e.kind === 'iter')).toHaveLength(2)
    expect(evs.filter(e => e.kind === 'done')).toHaveLength(1)
    const fin = evs.at(-1)!
    expect(fin).toEqual({ kind: 'finished', status: 'completed', exitCode: 0 })
    expect(await h.finished).toEqual({ status: 'completed', exitCode: 0 })

    const finished = readToml(join(h.runDir, 'FINISHED'))
    expect(validateFinished(finished).ok).toBe(true)
    expect(finished.status).toBe('completed')

    // run.log mirrors stdout verbatim; index has exactly one line; latest points at the run
    expect(readFileSync(join(h.runDir, 'run.log'), 'utf8')).toContain('AMICODE_ITER iter=2')
    expect(readFileSync(join(root, 'runs', 'index'), 'utf8').trim().split('\n')).toHaveLength(1)
    // no temp files left anywhere in the run dir
    expect(readdirSync(h.runDir).filter(f => f.includes('.tmp-'))).toHaveLength(0)
  })

  it('config errors reject BEFORE any run dir exists (exit-64 class)', async () => {
    const root = tmpRoot()
    await expect(new LocalExecutor().submit(join(root, 'nope.jl'), { runsRoot: join(root, 'runs') }))
      .rejects.toThrow(/script not found/)
    expect(existsSync(join(root, 'runs'))).toBe(false)
  })

  it('passes --project/--sysimage through and runs with cwd = runDir', async () => {
    const root = tmpRoot()
    const julia = fakeJulia(root, 'julia-echo',
      `console.log('ARGS ' + process.argv.slice(2).join(' ')); console.log('CWD ' + process.cwd())`)
    const script = fakeJulia(root, 's.jl', '')
    const h = await new LocalExecutor().submit(script, {
      runsRoot: join(root, 'runs'), julia: { julia, project: '/proj', sysimage: '/img.so' },
    })
    const evs = await collect(h.events)
    const argLine = evs.find(e => e.kind === 'log' && e.line.startsWith('ARGS')) as Extract<RunEvent, { kind: 'log' }>
    expect(argLine.line).toContain('--project=/proj')
    expect(argLine.line).toContain('--sysimage=/img.so')
    const cwdLine = evs.find(e => e.kind === 'log' && e.line.startsWith('CWD')) as Extract<RunEvent, { kind: 'log' }>
    expect(cwdLine.line).toContain(h.runDir)
  })
})
