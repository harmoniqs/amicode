import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { tmpRoot, fakeJulia, readToml } from './helpers.js'
import { LocalExecutor } from '../src/local_executor.js'

const HANG = `setInterval(() => {}, 1000)`                                          // dies on SIGTERM → 143
// prints READY only after the SIGTERM handler is installed — the test must not abort
// before then, or the signal hits node's default disposition during interpreter boot (→ 143)
const HANG_IGNORE = `process.on('SIGTERM', () => {}); console.log('READY'); setInterval(() => {}, 1000)`

describe('abort lane (spec §3/§6)', () => {
  it('abort() on a hanging run → FINISHED{aborted, 143} (SIGTERM)', async () => {
    const root = tmpRoot()
    const h = await new LocalExecutor().submit(fakeJulia(root, 's.jl', ''), {
      runsRoot: join(root, 'runs'), julia: { julia: fakeJulia(root, 'j', HANG) },
    })
    await h.abort()
    expect(await h.finished).toEqual({ status: 'aborted', exitCode: 143 })
    expect(readToml(join(h.runDir, 'FINISHED'))).toEqual({ status: 'aborted', exit_code: 143 })
  })

  it('SIGTERM-ignoring script is SIGKILLed after grace → FINISHED{aborted, 137}', async () => {
    const root = tmpRoot()
    const h = await new LocalExecutor().submit(fakeJulia(root, 's.jl', ''), {
      runsRoot: join(root, 'runs'),
      julia: { julia: fakeJulia(root, 'j', HANG_IGNORE) },
      graceMs: 200,                       // test knob — spec default is 5000
    })
    for await (const e of h.events) {
      if (e.kind === 'log' && e.line === 'READY') void h.abort()   // handler installed — now abort
    }
    expect(await h.finished).toEqual({ status: 'aborted', exitCode: 137 })
  }, 15000)

  it('abort() is idempotent and a no-op after completion', async () => {
    const root = tmpRoot()
    const h = await new LocalExecutor().submit(fakeJulia(root, 's.jl', ''), {
      runsRoot: join(root, 'runs'), julia: { julia: fakeJulia(root, 'j', 'process.exit(0)') },
    })
    await h.finished
    await expect(h.abort()).resolves.toBeUndefined()
    expect(readToml(join(h.runDir, 'FINISHED')).status).toBe('completed')
  })
})
