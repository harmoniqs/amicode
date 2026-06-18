import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync, execFile } from 'node:child_process'
import { join } from 'node:path'
import { tmpRoot, fakeJulia } from './helpers.js'

const BUNDLE = join(__dirname, '..', 'dist', 'amico-run.js')
beforeAll(() => {
  execFileSync('node', [join(__dirname, '..', 'esbuild.config.mjs')], { cwd: join(__dirname, '..') })
})

function run(args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('node', [BUNDLE, ...args], { encoding: 'utf8' })
    return { code: 0, stdout, stderr: '' }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { code: err.status ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
  }
}

describe('amico-run CLI', () => {
  it('clean solve: relays iter lines, prints AMICODE_FINISHED, exits 0', () => {
    const root = tmpRoot()
    const julia = fakeJulia(root, 'j', `console.log('AMICODE_ITER iter=1 f=0.5'); console.log('DONE f=0.99')`)
    const script = fakeJulia(root, 's.jl', '')
    const r = run([script, '--runs-root', join(root, 'runs'), '--julia', julia])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('AMICODE_ITER iter=1 f=0.5')
    expect(r.stdout).toMatch(/AMICODE_FINISHED status=completed exitCode=0 runDir=.+/)
  })
  it('julia rc 7 passes through as exit 7', () => {
    const root = tmpRoot()
    const r = run([fakeJulia(root, 's.jl', ''), '--runs-root', join(root, 'runs'),
                   '--julia', fakeJulia(root, 'j', 'process.exit(7)')])
    expect(r.code).toBe(7)
    expect(r.stdout).toContain('status=failed exitCode=7')
  })
  it('missing script → 64, stderr one-liner, no run dir', () => {
    const root = tmpRoot()
    const r = run([join(root, 'nope.jl'), '--runs-root', join(root, 'runs')])
    expect(r.code).toBe(64)
    expect(r.stderr).toMatch(/script not found/)
  })
  it('unknown flag → 64 (never silently swallowed, spec Q68)', () => {
    const root = tmpRoot()
    const r = run([fakeJulia(root, 's.jl', ''), '--gates', 'X'])
    expect(r.code).toBe(64)
    expect(r.stderr).toMatch(/unknown flag/)
  })
  it('--executor remote → 64 (only local in β)', () => {
    const root = tmpRoot()
    const r = run([fakeJulia(root, 's.jl', ''), '--executor', 'remote'])
    expect(r.code).toBe(64)
  })
  it('SIGTERM to the CLI → abort lane, exit 130', async () => {
    const root = tmpRoot()
    const julia = fakeJulia(root, 'j', `console.log('READY'); setInterval(() => {}, 1000)`)
    const script = fakeJulia(root, 's.jl', '')
    const code: number = await new Promise(resolveP => {
      const child = execFile('node', [BUNDLE, script, '--runs-root', join(root, 'runs'), '--julia', julia])
      child.stdout!.on('data', (d: string) => { if (d.includes('READY')) child.kill('SIGTERM') })
      child.on('exit', c => resolveP(c ?? -1))
    })
    expect(code).toBe(130)
  }, 15000)
})
