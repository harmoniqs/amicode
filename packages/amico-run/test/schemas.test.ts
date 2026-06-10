import { describe, it, expect } from 'vitest'
import { validateManifest, validateFinished, validateResult } from '../src/schemas.js'

const goodManifest = {
  schema_version: '1', run_id: 'r20260610-101245Z-ab12', script_path: '/s.jl',
  lab: 'default', lab_id: 'default', created_at: '2026-06-10T10:12:45Z',
  orchestrator_version: '0.1.0', julia: { binary: 'julia' },
}

describe('validateManifest', () => {
  it('accepts a conforming manifest', () =>
    expect(validateManifest(goodManifest)).toEqual({ ok: true, errors: [] }))
  it('reports each missing/mistyped field by path', () => {
    const r = validateManifest({ ...goodManifest, run_id: 42, julia: {} })
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toContain('run_id')
    expect(r.errors.join(' ')).toContain('julia.binary')
  })
  it('rejects unknown schema_version', () =>
    expect(validateManifest({ ...goodManifest, schema_version: '2' }).ok).toBe(false))
})

describe('validateFinished', () => {
  it('accepts {status, exit_code}', () =>
    expect(validateFinished({ status: 'aborted', exit_code: 143 }).ok).toBe(true))
  it('rejects bad status and non-integer exit_code', () => {
    expect(validateFinished({ status: 'ok', exit_code: 0 }).ok).toBe(false)
    expect(validateFinished({ status: 'failed', exit_code: 1.5 }).ok).toBe(false)
  })
})

describe('validateResult (reader-side)', () => {
  it('requires fidelity number, iterations integer', () => {
    expect(validateResult({ fidelity: 0.999, iterations: 200, wall_seconds: 12.5 }).ok).toBe(true)
    expect(validateResult({ iterations: 200 }).ok).toBe(false)
  })
})
