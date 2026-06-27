import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ingestRunDir, AMICODE_ITER_RE, parseAmicoNum, SinkDedup } from '../src/run_dir_reader'   // pure β.1-contract reader (vscode-free)

function stageRun(opts: { status: string; exit: number; iters: number[]; fidelity?: number }): string {
  const root = mkdtempSync(join(tmpdir(), 'runs-'))
  const runId = 'r20260615-000000Z-ab12'
  const dir = join(root, runId); mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'run.toml'),
    `schema_version = "1"\nrun_id = "${runId}"\nscript_path = "/s.jl"\nlab = "default"\nlab_id = "default"\ncreated_at = "2026-06-15T00:00:00Z"\norchestrator_version = "0.1.0"\n[julia]\nbinary = "julia"\n`)
  for (const k of opts.iters) writeFileSync(join(dir, `iter_${k}.png`), 'PNG')
  writeFileSync(join(dir, 'run.log'), opts.iters.map(k => `AMICODE_ITER iter=${k} f=0.1 inf_pr=1e-8 inf_du=1e-6`).join('\n') + '\n')
  if (opts.fidelity !== undefined) writeFileSync(join(dir, 'result.toml'), `schema_version = "1"\nfidelity = ${opts.fidelity}\niterations = ${Math.max(...opts.iters, 0)}\n`)
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
  it('returns the run.log byte offset (so the live tailer attaches without skipping iters)', () => {
    const sink = fakeSink()
    const bytes = ingestRunDir(stageRun({ status: 'completed', exit: 0, iters: [1, 2], fidelity: 0.999 }), sink)
    expect(bytes).toBeGreaterThan(0)   // = byte length of run.log consumed during replay
  })
})

describe('AMICODE_ITER parsing — Inf/NaN are kept, not dropped', () => {
  it('matches blow-up / stagnation iters (Inf, -Inf, NaN), matching amico-run', () => {
    expect(AMICODE_ITER_RE.test('AMICODE_ITER iter=3 f=Inf inf_pr=NaN inf_du=-Inf')).toBe(true)
    expect(AMICODE_ITER_RE.test('AMICODE_ITER iter=4 f=1.2e-03 inf_pr=5e-9 inf_du=2.3')).toBe(true)
  })
  it('parseAmicoNum maps Julia Inf/NaN to JS values', () => {
    expect(parseAmicoNum('Inf')).toBe(Infinity)
    expect(parseAmicoNum('-Inf')).toBe(-Infinity)
    expect(Number.isNaN(parseAmicoNum('NaN'))).toBe(true)
    expect(parseAmicoNum('1.5e-3')).toBeCloseTo(0.0015)
  })
})

// The live inspector path (LiveRunSink) delegates frame/iter dedup to SinkDedup.
// This is the exact gap Jack flagged on #9 ("no test covering the live status-bar
// / incremental inspector path") — and where a regression silently blanked every
// frame: run.log lines advanced a shared counter past the lagging PNG frames, so
// every image() call was deduped away.
describe('SinkDedup — live frame/iter dedup (the path that blanked the inspector)', () => {
  it('accepts a strictly-increasing frame, rejects re-delivery (poll + fs.watch overlap)', () => {
    const d = new SinkDedup()
    expect(d.acceptFrame(6)).toBe(true)
    expect(d.acceptFrame(6)).toBe(false)   // same frame re-seen by the poll backstop
    expect(d.acceptFrame(12)).toBe(true)
    expect(d.acceptFrame(7)).toBe(false)   // an older frame can't clobber a newer one
  })

  it('log-line iters do NOT suppress lagging frames (regression guard)', () => {
    const d = new SinkDedup()
    // run.log streams iter=1..60 (fast) before the iter_0006.png frame lands.
    for (let k = 1; k <= 60; k++) d.noteIter(k)
    // The frame for iter 6 must STILL display — it dedups on frames, not log lines.
    expect(d.acceptFrame(6)).toBe(true)
    expect(d.acceptFrame(12)).toBe(true)
    expect(d.acceptFrame(60)).toBe(true)
  })

  it('high() tracks the max across both sources (status bar / completion iter N)', () => {
    const d = new SinkDedup()
    expect(d.high).toBe(-1)
    d.acceptFrame(6)
    d.noteIter(42)
    expect(d.high).toBe(42)
    d.acceptFrame(60)
    expect(d.high).toBe(60)
  })
})
