import { ConfigError, type Executor, type RunHandle, type RunStatus, type SubmitOpts } from './types.js'

// ============================================================================
// Scheduler (Phase 1.1, #56) — a serial run queue built TO the ratified
// Executor contract (Track C spec, locked 2026-07-02), so the cloud
// RemoteExecutor (Δ8/#32) drops in with zero reshape:
//
//   - S12: downstream (RunsManager / Inspector / Catalog) sees ONLY the
//     executor's RunHandle — enqueue() resolves to it untouched; nothing here
//     branches on executor type.
//   - (b) abort() is a REQUEST, not a kill: the queue advances ONLY when a
//     run's `finished` resolves (a FINISHED — or executor-inferred terminal —
//     landed). Post-abort() the run is still live; the Scheduler never treats
//     abort as terminal.
//   - (c) per-executor warming budget: the Scheduler owns NO timers. However
//     long a run takes to warm/finish (remote cold-start ≫ local seconds) is
//     between the executor and its handle; the queue just awaits `finished`.
//   - (d) terminal resolution is the executor's job (`finished` never rejects
//     per the contract); the Scheduler defensively survives a rogue rejection
//     rather than wedging the queue.
//
// Serial by default; `{concurrent: true}` is the NAMED Phase-4 seam (§4.2) —
// rejected loudly today so nothing silently serializes when callers expect a
// parallel lane later.
// ============================================================================

/** What to run when this entry reaches the head of the queue. */
export interface SubmitSpec {
  scriptPath: string
  /** Passed to Executor.submit verbatim (lab pointer, runsRoot, julia opts…). */
  opts?: SubmitOpts
}

export interface EnqueueOpts {
  /** Phase-4 seam (opt-in parallel lane) — NOT implemented; throws ConfigError. */
  concurrent?: boolean
}

/** Run lifecycle the RunsManager / StatusBar consume (1.2). `queueId` is the
 *  Scheduler's own id (assigned at enqueue, before any run exists); `runId`
 *  appears once the executor has admitted the run. */
export type SchedulerEvent =
  | { kind: 'queued'; queueId: string; position: number }
  | { kind: 'started'; queueId: string; runId: string; runDir: string }
  | { kind: 'finished'; queueId: string; runId: string; status: RunStatus; exitCode: number }
  | { kind: 'cancelled'; queueId: string }
  | { kind: 'error'; queueId: string; message: string }

export interface ScheduledRun {
  queueId: string
  /** Resolves with the executor's RunHandle when this entry reaches the head
   *  of the queue and submit() succeeds. Rejects if the entry is cancelled
   *  before starting, or if submit() throws (e.g. ConfigError). */
  handle: Promise<RunHandle>
  /** Dequeue BEFORE start: true iff the entry was still queued (it will never
   *  run). False in every other case — already started, already cancelled, or
   *  mid-submit (shifted but `started` not yet emitted; `handle` may still
   *  REJECT if that submit fails). To stop a live run, `await handle` (in a
   *  try/catch) and call RunHandle.abort() — a request, per contract (b);
   *  never via the queue. */
  cancel(): boolean
}

interface Entry {
  queueId: string
  spec: SubmitSpec
  resolve: (h: RunHandle) => void
  reject: (e: Error) => void
}

export class Scheduler {
  private readonly queue: Entry[] = []
  private running = false
  private nextId = 1
  private readonly listeners = new Set<(e: SchedulerEvent) => void>()

  constructor(private readonly executor: Executor) {}

  /** Subscribe to lifecycle events. Returns a dispose function. Multi-consumer
   *  (RunsManager + StatusBar); a throwing listener is isolated. */
  onEvent(listener: (e: SchedulerEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Queued + running entries — 0 means an enqueue() would start immediately. */
  get depth(): number {
    return this.queue.length + (this.running ? 1 : 0)
  }

  enqueue(spec: SubmitSpec, opts: EnqueueOpts = {}): ScheduledRun {
    if (opts.concurrent) {
      throw new ConfigError('Scheduler: the parallel lane (concurrent: true) is deferred to Phase 4 — runs are serial')
    }
    const queueId = `q${this.nextId++}`
    let resolve!: (h: RunHandle) => void
    let reject!: (e: Error) => void
    const handle = new Promise<RunHandle>((res, rej) => { resolve = res; reject = rej })
    // The Scheduler itself observes failures (error event) — callers that only
    // consume events must not trip an unhandled-rejection on the same promise.
    handle.catch(() => {})
    const entry: Entry = { queueId, spec, resolve, reject }
    this.queue.push(entry)
    this.emit({ kind: 'queued', queueId, position: this.queue.length - 1 + (this.running ? 1 : 0) })
    void this.pump()
    return {
      queueId,
      handle,
      cancel: (): boolean => {
        const i = this.queue.indexOf(entry)
        if (i === -1) return false          // already started (or done) — abort via the handle
        this.queue.splice(i, 1)
        this.emit({ kind: 'cancelled', queueId })
        entry.reject(new Error(`Scheduler: ${queueId} cancelled before start`))
        return true
      },
    }
  }

  // -------- internal --------

  private emit(e: SchedulerEvent): void {
    for (const l of this.listeners) {
      try { l(e) } catch { /* a bad listener must not wedge the pump */ }
    }
  }

  /** The serial pump: one entry at a time; advances ONLY on `finished`
   *  resolution (contract (b) — never on abort(), which is just a request). */
  private async pump(): Promise<void> {
    if (this.running) return
    const entry = this.queue.shift()
    if (!entry) return
    this.running = true
    try {
      let handle: RunHandle
      try {
        handle = await this.executor.submit(entry.spec.scriptPath, entry.spec.opts)
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e))
        this.emit({ kind: 'error', queueId: entry.queueId, message: err.message })
        entry.reject(err)
        return   // finally advances the queue — a config failure must not wedge it
      }
      this.emit({ kind: 'started', queueId: entry.queueId, runId: handle.runId, runDir: handle.runDir })
      entry.resolve(handle)
      try {
        const fin = await handle.finished   // contract: never rejects…
        this.emit({ kind: 'finished', queueId: entry.queueId, runId: handle.runId, status: fin.status, exitCode: fin.exitCode })
      } catch (e) {
        // …but a rogue executor breaking that must not deadlock every queued run.
        const msg = e instanceof Error ? e.message : String(e)
        this.emit({ kind: 'error', queueId: entry.queueId, message: `finished rejected: ${msg}` })
      }
    } finally {
      this.running = false
      // Microtask deferral, NOT a direct call: a contract-violating executor
      // whose submit() throws SYNCHRONOUSLY would otherwise make this finally
      // direct recursion — a long backlog of such failures blows the stack and
      // strands the rest of the queue. Deferring one microtask keeps the chain
      // flat regardless of how the executor misbehaves.
      queueMicrotask(() => void this.pump())
    }
  }
}
