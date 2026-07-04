import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync, execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpRoot, fakeJulia, readToml } from './helpers.js'

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
  it('--spec: gate failure → 64, one-line stderr reason, NO run dir (spec C)', () => {
    const root = tmpRoot()
    const script = fakeJulia(root, 's.jl', '')
    writeFileSync(join(root, 'bad.json'), JSON.stringify({ nope: true }))
    const r = run([script, '--runs-root', join(root, 'runs'), '--spec', join(root, 'bad.json'),
                   '--julia', fakeJulia(root, 'j', '')])
    expect(r.code).toBe(64)
    expect(r.stderr).toMatch(/solvespec schema/)
    expect(existsSync(join(root, 'runs'))).toBe(false)
  })
  it('--spec pass: solvespec.json persisted canonical + run.toml v2 stamped (spec C)', () => {
    const root = tmpRoot()
    const script = fakeJulia(root, 's.jl', '')
    const spec = {
      schema_version: '2', script_path: script, lab_id: 'default',
      executor: 'local', tier: 'vetted',
      hashes: { system_hash: 'sha256:ab' },
    }
    writeFileSync(join(root, 'spec.json'), JSON.stringify(spec))
    const r = run([script, '--runs-root', join(root, 'runs'), '--spec', join(root, 'spec.json'),
                   '--julia', fakeJulia(root, 'j', `console.log('DONE f=0.99')`)])
    expect(r.code).toBe(0)
    const match = /runDir=(\S+)/.exec(r.stdout)
    expect(match).toBeTruthy()
    const runDir = match![1]
    const persisted = JSON.parse(readFileSync(join(runDir, 'solvespec.json'), 'utf8'))
    expect(persisted).toMatchObject({ tier: 'vetted', lab_id: 'default' })
    const manifest = readToml(join(runDir, 'run.toml'))
    expect(manifest.schema_version).toBe('2')
    expect(manifest.tier).toBe('vetted')
    expect((manifest.hashes as Record<string, unknown>).system_hash).toBe('sha256:ab')
    expect((manifest.hashes as Record<string, unknown>).spec_hash).toMatch(/^sha256:/)
  })
  it('--spec env.kind=project sets the julia --project arg from env.project (spec C)', () => {
    const root = tmpRoot()
    const script = fakeJulia(root, 's.jl', '')
    const env = join(root, 'env')
    mkdirSync(env, { recursive: true })
    writeFileSync(join(env, 'Project.toml'), `[deps]\n`)
    writeFileSync(join(env, 'Manifest.toml'), `julia_version = "1.11.0"\n`)
    const spec = {
      schema_version: '2', script_path: script, lab_id: 'default',
      tier: 'vetted', env: { kind: 'project', project: env },
    }
    writeFileSync(join(root, 'spec.json'), JSON.stringify(spec))
    const julia = fakeJulia(root, 'j', `console.log('ARGS ' + process.argv.slice(2).join(' '))`)
    const r = run([script, '--runs-root', join(root, 'runs'), '--spec', join(root, 'spec.json'), '--julia', julia])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain(`--project=${env}`)
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
