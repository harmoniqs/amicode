import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, readlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'smol-toml'
import { validateManifest, validateFinished } from '@amicode/amico-run'
import { stageDemoRun } from '../src/demo_replay'

function fakeDemo(): string {
  const d = mkdtempSync(join(tmpdir(), 'demo-'))
  writeFileSync(join(d, 'run.toml'),
    `schema_version = "1"\nrun_id = "rDEMO"\nscript_path = "/demo.jl"\nlab = "default"\nlab_id = "default"\ncreated_at = "2026-06-17T00:00:00Z"\norchestrator_version = "0.1.0"\n[julia]\nbinary = "julia"\n`)
  writeFileSync(join(d, 'run.log'), 'AMICODE_ITER iter=10 f=0.1 inf_pr=1e-8 inf_du=1e-6\n')
  writeFileSync(join(d, 'iter_0010.png'), 'PNG')
  writeFileSync(join(d, 'result.toml'), 'schema_version = "1"\nfidelity = 0.9999\niterations = 10\n')
  writeFileSync(join(d, 'FINISHED'), 'status = "completed"\nexit_code = 0\n')
  return d
}

describe('stageDemoRun', () => {
  it('stages the demo into a fresh runId, rewrites manifest run_id, swings latest', () => {
    const demo = fakeDemo()
    const runsRoot = mkdtempSync(join(tmpdir(), 'runs-'))
    const runDir = stageDemoRun(demo, runsRoot)
    const runId = runDir.split('/').pop()!
    expect(runId).toMatch(/^r\d{8}-\d{6}Z-[0-9a-f]{4}$/)            // β.1 runId format
    expect(existsSync(join(runDir, 'iter_0010.png'))).toBe(true)
    const m = parse(readFileSync(join(runDir, 'run.toml'), 'utf8')) as Record<string, unknown>
    expect(validateManifest(m).ok).toBe(true)
    expect(m.run_id).toBe(runId)                                    // rewritten to match the dir
    expect(validateFinished(parse(readFileSync(join(runDir, 'FINISHED'), 'utf8'))).ok).toBe(true)
    expect(readlinkSync(join(runsRoot, 'latest'))).toBe(runId)      // the watcher will follow this
    expect(readFileSync(join(runsRoot, 'index'), 'utf8')).toContain(runId)  // appended to the index
  })
})
