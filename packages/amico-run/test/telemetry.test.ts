import { describe, it, expect } from 'vitest'
import { classifyLine } from '../src/telemetry.js'

describe('classifyLine', () => {
  it('parses AMICODE_ITER key=value fields', () => {
    const ev = classifyLine('AMICODE_ITER iter=12 f=3.4e-5 inf_pr=1.2e-8', 'stdout')
    expect(ev).toEqual({
      kind: 'iter',
      raw: 'AMICODE_ITER iter=12 f=3.4e-5 inf_pr=1.2e-8',
      fields: { iter: '12', f: '3.4e-5', inf_pr: '1.2e-8' },
    })
  })
  it('classifies DONE as done', () => {
    expect(classifyLine('DONE fidelity=0.9999', 'stdout').kind).toBe('done')
  })
  it('AMICODE_ITER on stderr is just log (convention is stdout-only)', () => {
    expect(classifyLine('AMICODE_ITER iter=1', 'stderr').kind).toBe('log')
  })
  it('malformed tokens are skipped, never throw', () => {
    const ev = classifyLine('AMICODE_ITER iter=1 ====garbage', 'stdout')
    expect(ev.kind).toBe('iter')
  })
  it('everything else is log with stream tagged', () => {
    expect(classifyLine('Ipopt banner', 'stderr')).toEqual({
      kind: 'log', stream: 'stderr', line: 'Ipopt banner',
    })
  })
})
