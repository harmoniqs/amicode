import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ingestRunDir } from '../src/run_dir_reader'   // pure β.1-contract reader (vscode-free)

function stageRun(opts: { status: string; exit: number; iters: number[]; fidelity?: number }): string {
  const root = mkdtempSync(join(tmpdir(), 'runs-'))
  const runId = 'r20260615-000000Z-ab12'
  const dir = join(root, runId); mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.toml'),
    `schema_version = "1"\nrun_id = "${runId}"\nscript_path = "/s.jl"\nlab = "default"\nlab_id = "default"\ncreated_at = "2026-06-15T00:00:00Z"\norchestrator_version = "0.1.0"\n[julia]\nbinary = "julia"\n`)
  for (const k of opts.iters) writeFileSync(join(dir, `iter_${k}.png`), 'PNG')
  writeFileSync(join(dir, 'run.log'), opts.iters.map(k => `AMICODE_ITER iter=${k} f=0.1 inf_pr=1e-8 inf_du=1e-6`).join('\n') + '\n')
  if (opts.fidelity !== undefined) writeFileSync(join(dir, 'result.toml'), `fidelity = ${opts.fidelity}\niterations = ${Math.max(...opts.iters, 0)}\n`)
  writeFileSync(join(dir, 'FINISHED'), `status = "${opts.status}"\nexit_code = ${opts.exit}\n`)
  return dir
}

const fakeSink = () => ({ image: vi.fn(), iter: vi.fn(), run: vi.fn(), promote: vi.fn() })

describe('ingestRunDir — β.1 contract reading (replay)', () => {
  it('completed run: identity from manifest, unbounded iter digits, run.log→iter, FINISHED→completed, promote on F≥0.99', () => {
    const sink = fakeSink()
    ingestRunDir(stageRun({ status: 'completed', exit: 0, iters: [1, 7, 142], fidelity: 0.9991 }), sink)
    expect(sink.image).toHaveBeenCalled()                          // iter_142.png accepted (3 digits)
    expect(sink.iter).toHaveBeenCalledWith(expect.objectContaining({ iter: 142 }))  // run.log parsed on REPLAY
    expect(sink.run).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed', fidelity: 0.9991 }))
    expect(sink.promote).toHaveBeenCalled()
  })
  it('failed run: FINISHED→failed, no promote', () => {
    const sink = fakeSink()
    ingestRunDir(stageRun({ status: 'failed', exit: 3, iters: [1], fidelity: 0.4 }), sink)
    expect(sink.run).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }))
    expect(sink.promote).not.toHaveBeenCalled()
  })
  it('aborted run: FINISHED→aborted, no promote', () => {
    const sink = fakeSink()
    ingestRunDir(stageRun({ status: 'aborted', exit: 143, iters: [] }), sink)
    expect(sink.run).toHaveBeenCalledWith(expect.objectContaining({ status: 'aborted' }))
    expect(sink.promote).not.toHaveBeenCalled()
  })
  it('completed but F<0.99: no promote', () => {
    const sink = fakeSink()
    ingestRunDir(stageRun({ status: 'completed', exit: 0, iters: [1], fidelity: 0.5 }), sink)
    expect(sink.promote).not.toHaveBeenCalled()
  })
})
