import { describe, it, expect } from 'vitest'
import { Scheduler, type SchedulerEvent } from '../src/scheduler.js'
import { ConfigError, type Executor, type Finished, type RunEvent, type RunHandle, type SubmitOpts } from '../src/types.js'
import { EventQueue } from '../src/event_queue.js'

// 1.1 Scheduler (#56) — serial queue built TO the ratified Executor contract
// (Track C spec, locked 2026-07-02). The load-bearing behaviors under test:
//   - serial: entry N+1 submits only after entry N's `finished` RESOLVES;
//   - (b) abort() is a REQUEST, not a kill — post-abort() the run is still
//     alive and the queue must NOT advance until `finished` lands;
//   - (c) no warming timeout — the Scheduler owns no timers at all;
//   - S12 — downstream sees only the executor's RunHandle, passed through.

/** Controllable fake executor: each submit() returns a handle whose `finished`
 *  the TEST resolves. Records submit order/args. */
class FakeExecutor implements Executor {
  submits: Array<{ scriptPath: string; opts?: SubmitOpts }> = []
  handles: Array<{ handle: RunHandle; finish: (f: Finished) => void; aborted: boolean[] }> = []
  /** scripts whose submit() should throw ConfigError */
  failFor = new Set<string>()

  async submit(scriptPath: string, opts?: SubmitOpts): Promise<RunHandle> {
    this.submits.push({ scriptPath, opts })
    if (this.failFor.has(scriptPath)) throw new ConfigError(`bad config: ${scriptPath}`)
    const n = this.submits.length
    let finish!: (f: Finished) => void
    const finished = new Promise<Finished>(r => { finish = r })
    const aborted: boolean[] = []
    const handle: RunHandle = {
      runId: `run-${n}`,
      runDir: `/runs/run-${n}`,
      events: new EventQueue<RunEvent>(),
      finished,
      // Contract (b): abort resolves only when finished does (request, not kill).
      abort: async () => { aborted.push(true); await finished },
    }
    this.handles.push({ handle, finish, aborted })
    return handle
  }
}

const tick = () => new Promise<void>(r => setTimeout(r, 0))

function collect(s: Scheduler): SchedulerEvent[] {
  const seen: SchedulerEvent[] = []
  s.onEvent(e => seen.push(e))
  return seen
}

describe('Scheduler — serial queue (#56)', () => {
  it('runs entries strictly serially: N+1 submits only after N `finished` resolves', async () => {
    const ex = new FakeExecutor()
    const s = new Scheduler(ex)
    const a = s.enqueue({ scriptPath: 'a.jl' })
    const b = s.enqueue({ scriptPath: 'b.jl' })
    await tick()
    expect(ex.submits.map(x => x.scriptPath)).toEqual(['a.jl'])   // b NOT submitted yet
    ex.handles[0].finish({ status: 'completed', exitCode: 0 })
    await tick()
    expect(ex.submits.map(x => x.scriptPath)).toEqual(['a.jl', 'b.jl'])
    const [ha, hb] = [await a.handle, await b.handle]
    expect(ha.runId).toBe('run-1')
    expect(hb.runId).toBe('run-2')
  })

  it('S12: the resolved handle IS the executor RunHandle (identity passthrough)', async () => {
    const ex = new FakeExecutor()
    const s = new Scheduler(ex)
    const r = s.enqueue({ scriptPath: 'a.jl' })
    await tick()
    expect(await r.handle).toBe(ex.handles[0].handle)
  })

  it('passes SubmitOpts through to executor.submit verbatim', async () => {
    const ex = new FakeExecutor()
    const s = new Scheduler(ex)
    const opts: SubmitOpts = { lab: 'lab-7', runsRoot: '/tmp/rr', julia: { project: '/p' } }
    s.enqueue({ scriptPath: 'a.jl', opts })
    await tick()
    expect(ex.submits[0].opts).toBe(opts)
  })

  it('contract (b): abort() does NOT advance the queue — only `finished` does', async () => {
    const ex = new FakeExecutor()
    const s = new Scheduler(ex)
    const a = s.enqueue({ scriptPath: 'a.jl' })
    s.enqueue({ scriptPath: 'b.jl' })
    await tick()
    const ha = await a.handle
    void ha.abort()                       // request termination…
    await tick(); await tick()
    expect(ex.submits).toHaveLength(1)    // …but the run is still alive: b must NOT start
    ex.handles[0].finish({ status: 'aborted', exitCode: 143 })   // FINISHED lands
    await tick()
    expect(ex.submits).toHaveLength(2)    // now b starts
  })

  it('emits the lifecycle: queued → started → finished, with queue position', async () => {
    const ex = new FakeExecutor()
    const s = new Scheduler(ex)
    const seen = collect(s)
    s.enqueue({ scriptPath: 'a.jl' })
    s.enqueue({ scriptPath: 'b.jl' })
    await tick()
    ex.handles[0].finish({ status: 'completed', exitCode: 0 })
    await tick()
    ex.handles[1].finish({ status: 'failed', exitCode: 1 })
    await tick()
    expect(seen).toEqual([
      { kind: 'queued', queueId: 'q1', position: 0 },
      { kind: 'queued', queueId: 'q2', position: 1 },
      { kind: 'started', queueId: 'q1', runId: 'run-1', runDir: '/runs/run-1' },
      { kind: 'finished', queueId: 'q1', runId: 'run-1', status: 'completed', exitCode: 0 },
      { kind: 'started', queueId: 'q2', runId: 'run-2', runDir: '/runs/run-2' },
      { kind: 'finished', queueId: 'q2', runId: 'run-2', status: 'failed', exitCode: 1 },
    ])
  })

  it('cancel() while queued: never submitted, cancelled event, handle rejects', async () => {
    const ex = new FakeExecutor()
    const s = new Scheduler(ex)
    const seen = collect(s)
    s.enqueue({ scriptPath: 'a.jl' })
    const b = s.enqueue({ scriptPath: 'b.jl' })
    await tick()
    expect(b.cancel()).toBe(true)
    ex.handles[0].finish({ status: 'completed', exitCode: 0 })
    await tick()
    expect(ex.submits.map(x => x.scriptPath)).toEqual(['a.jl'])   // b never ran
    expect(seen.some(e => e.kind === 'cancelled' && e.queueId === 'q2')).toBe(true)
    await expect(b.handle).rejects.toThrow(/cancel/i)
  })

  it('cancel() after start returns false and the run is untouched (abort via the handle instead)', async () => {
    const ex = new FakeExecutor()
    const s = new Scheduler(ex)
    const a = s.enqueue({ scriptPath: 'a.jl' })
    await tick()
    await a.handle
    expect(a.cancel()).toBe(false)
    expect(ex.handles[0].aborted).toHaveLength(0)   // cancel is NOT an abort
  })

  it('a submit() ConfigError rejects that handle, emits error, and the queue advances', async () => {
    const ex = new FakeExecutor()
    ex.failFor.add('bad.jl')
    const s = new Scheduler(ex)
    const seen = collect(s)
    const bad = s.enqueue({ scriptPath: 'bad.jl' })
    const ok = s.enqueue({ scriptPath: 'ok.jl' })
    await tick()
    await expect(bad.handle).rejects.toThrow(/bad config/)
    expect(seen.some(e => e.kind === 'error' && e.queueId === 'q1')).toBe(true)
    await tick()
    expect(ex.submits.map(x => x.scriptPath)).toEqual(['bad.jl', 'ok.jl'])   // queue not wedged
    expect((await ok.handle).runId).toBe('run-2')   // FakeExecutor counts the failed submit too
  })

  it('concurrent: true is a NAMED SEAM — rejected loudly (parallel lane is Phase 4)', () => {
    const s = new Scheduler(new FakeExecutor())
    expect(() => s.enqueue({ scriptPath: 'a.jl' }, { concurrent: true })).toThrow(ConfigError)
    expect(() => s.enqueue({ scriptPath: 'a.jl' }, { concurrent: true })).toThrow(/Phase 4/)
  })

  it('multiple listeners both receive events; a disposed listener stops receiving', async () => {
    const ex = new FakeExecutor()
    const s = new Scheduler(ex)
    const a: SchedulerEvent[] = []
    const b: SchedulerEvent[] = []
    const disposeA = s.onEvent(e => a.push(e))
    s.onEvent(e => b.push(e))
    s.enqueue({ scriptPath: 'x.jl' })
    await tick()
    expect(a.length).toBeGreaterThan(0)
    expect(b.length).toBe(a.length)
    disposeA()
    ex.handles[0].finish({ status: 'completed', exitCode: 0 })
    await tick()
    expect(b.length).toBeGreaterThan(a.length)   // b kept receiving after a disposed
  })

  it('a throwing listener cannot wedge the pump or starve other listeners', async () => {
    const ex = new FakeExecutor()
    const s = new Scheduler(ex)
    const good: SchedulerEvent[] = []
    s.onEvent(() => { throw new Error('bad listener') })
    s.onEvent(e => good.push(e))
    s.enqueue({ scriptPath: 'x.jl' })
    await tick()
    ex.handles[0].finish({ status: 'completed', exitCode: 0 })
    await tick()
    expect(good.some(e => e.kind === 'finished')).toBe(true)   // pump survived
  })

  it('contract (c): the Scheduler owns no timers (no warming timeout to hard-code)', async () => {
    // Structural pin: remote cold-start ≫ local seconds, so ANY scheduler-side
    // timeout would violate the per-executor warming budget. Assert the source
    // has no timer calls at all.
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const src = readFileSync(fileURLToPath(new URL('../src/scheduler.ts', import.meta.url)), 'utf8')
    expect(src).not.toMatch(/setTimeout|setInterval/)
  })
})
