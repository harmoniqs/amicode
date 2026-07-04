import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateManifest, validateFinished, validateResult } from '../src/schemas.js'

// These wrappers delegate to the shared @amicode/schema (single source of truth);
// this suite is the delegation smoke + the field-precise contract they expose.
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
    expect(r.errors.join(' ')).toContain('run_id')      // wrong-typed top-level field
    expect(r.errors.join(' ')).toContain('binary')      // /julia missing required "binary"
  })
  it('rejects unknown schema_version (v2 is now valid — spec C bump)', () => {
    expect(validateManifest({ ...goodManifest, schema_version: '99' }).ok).toBe(false)
    expect(validateManifest({ ...goodManifest, schema_version: '2' }).ok).toBe(true)
  })
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
  it('requires schema_version, fidelity number, iterations integer', () => {
    // The formalized contract carries schema_version on result.toml (0.1a adds the
    // emit; the Julia round-trip enforces it). An artifact lacking it is rejected.
    expect(validateResult({ schema_version: '1', fidelity: 0.999, iterations: 200, wall_seconds: 12.5 }).ok).toBe(true)
    expect(validateResult({ fidelity: 0.999, iterations: 200 }).ok).toBe(false)   // no schema_version
    expect(validateResult({ schema_version: '1', iterations: 200 }).ok).toBe(false) // no fidelity
  })
})

// Anti-regression (N4): schemas.ts must remain a thin DELEGATION, never re-define
// a schema/validator. Guards the "one validator path" invariant (#15 AC7).
describe('schemas.ts is delegation-only (no re-introduced schema)', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'schemas.ts'), 'utf8')
  it('imports the shared @amicode/schema', () =>
    expect(src).toMatch(/from ["']@amicode\/schema["']/))
  it('does not hand-roll validation (no local check helper / additionalProperties / required arrays)', () => {
    expect(src).not.toMatch(/additionalProperties/)
    expect(src).not.toMatch(/function check\b/)
    expect(src).not.toMatch(/errors\.push/)
  })
})
