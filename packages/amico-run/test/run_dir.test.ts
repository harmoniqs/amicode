import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readlinkSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpRoot, readToml } from './helpers.js'
import {
  deriveLabId, generateRunId, atomicWriteFile,
  writeManifest, writeFinished, appendIndex, updateLatest,
} from '../src/run_dir.js'
import { ConfigError } from '../src/types.js'
import { validate } from '@amicode/schema'

describe('deriveLabId', () => {
  it('uses id pointers verbatim', () => expect(deriveLabId('schuster')).toBe('schuster'))
  it('derives from parent dir of a lab.toml path', () =>
    expect(deriveLabId('/labs/schuster/lab.toml')).toBe('schuster'))
  it('rejects pointers that fit neither rule', () =>
    expect(() => deriveLabId('Bad Lab!')).toThrow(ConfigError))
})

describe('generateRunId', () => {
  it('matches r<YYYYMMDD-HHMMSSZ>-<4hex> and avoids collisions', () => {
    const root = tmpRoot()
    const id = generateRunId(root, new Date('2026-06-10T10:12:45.678Z'))
    expect(id).toMatch(/^r20260610-101245Z-[0-9a-f]{4}$/)
    mkdirSync(join(root, id))
    const id2 = generateRunId(root, new Date('2026-06-10T10:12:45.678Z'))
    expect(id2).not.toBe(id)
  })
})

describe('writers', () => {
  it('manifest round-trips through a TOML parser with exact snake_case keys', () => {
    const root = tmpRoot()
    writeManifest(root, {
      schema_version: '1', run_id: 'r1', script_path: '/s.jl',
      lab: '/labs/x/lab.toml', lab_id: 'x',
      created_at: '2026-06-10T10:12:45Z', orchestrator_version: '0.1.0',
      julia: { binary: 'julia', project: '/proj' },
    })
    const m = readToml(join(root, 'run.toml'))
    expect(m.schema_version).toBe('1')
    expect(m.lab_id).toBe('x')
    expect((m.julia as Record<string, unknown>).project).toBe('/proj')
    expect(m).not.toHaveProperty('sizeClass')   // spec §5: intentionally absent
  })
  it('manifest v2: tier + [hashes] emitted only when present; validates as "run" v2 (spec C)', () => {
    const root = tmpRoot()
    const base = {
      run_id: 'r1', script_path: '/s.jl', lab: 'default', lab_id: 'default',
      created_at: '2026-07-03T00:00:00Z', orchestrator_version: '0.1.0',
      julia: { binary: 'julia' },
    }
    // bare (v1) output is byte-stable: no tier/hashes lines at all
    writeManifest(root, { schema_version: '1', ...base })
    const v1text = readFileSync(join(root, 'run.toml'), 'utf8')
    expect(v1text).not.toContain('tier')
    expect(v1text).not.toContain('[hashes]')
    // spec-driven (v2)
    writeManifest(root, {
      schema_version: '2', ...base, tier: 'free',
      hashes: { system_hash: 'sha256:ab', spec_hash: 'sha256:cd' },
    })
    const m = readToml(join(root, 'run.toml'))
    expect(m.schema_version).toBe('2')
    expect(m.tier).toBe('free')
    expect((m.hashes as Record<string, unknown>).spec_hash).toBe('sha256:cd')
    expect(validate(m, 'run').errors).toEqual([])
  })
  it('FINISHED carries status + exit_code (snake_case)', () => {
    const root = tmpRoot()
    writeFinished(root, 'failed', 7)
    expect(readToml(join(root, 'FINISHED'))).toEqual({ status: 'failed', exit_code: 7 })
  })
  it('atomicWriteFile leaves no temp file behind', () => {
    const root = tmpRoot()
    atomicWriteFile(root, 'f.toml', 'a = 1\n')
    expect(readFileSync(join(root, 'f.toml'), 'utf8')).toBe('a = 1\n')
    expect(existsSync(join(root, `.f.toml.tmp-${process.pid}`))).toBe(false)
  })
  it('index appends one tab-separated line per run; latest symlink swings', () => {
    const root = tmpRoot()
    appendIndex(root, 'r1', 't1', '/a.jl'); appendIndex(root, 'r2', 't2', '/b.jl')
    expect(readFileSync(join(root, 'index'), 'utf8')).toBe('r1\tt1\t/a.jl\nr2\tt2\t/b.jl\n')
    mkdirSync(join(root, 'r2'))
    updateLatest(root, 'r2')
    expect(readlinkSync(join(root, 'latest'))).toBe('r2')
  })
  it('sanitizes tab/newline in the script path so the TSV index stays one line per run', () => {
    const root = tmpRoot()
    appendIndex(root, 'r1', 't1', '/weird\tpath\nwith/ctrl.jl')
    const lines = readFileSync(join(root, 'index'), 'utf8').trimEnd().split('\n')
    expect(lines).toHaveLength(1)                         // not corrupted into multiple rows
    expect(lines[0].split('\t')).toHaveLength(3)          // exactly runId/createdAt/path fields
  })
})
