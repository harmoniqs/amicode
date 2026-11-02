// The H0a load driver: N concurrent sessions, each looping prompt -> wait for the turn to end -> think-time -> repeat,
// plus event subscribers (one global, one per third of the sessions, some of which abort and reconnect) and the
// dashboards' periodic `GET /api/session` + `GET /api/info` poll. Records its OWN event-loop drift so a saturated
// driver cannot be mistaken for host lag.
//
// How a turn is known to have ended: the global `/api/event` stream carries `session.execution.succeeded|failed|
// interrupted` for the session. That stream is volatile by contract (a slow consumer is cut off; frames during a
// disconnection are missed), so a turn whose end event has not arrived after EVENT_WAIT_MS is checked by polling
// `GET /api/session/:id` (`time.busy` / `time.idle` / `outcome`). A turn with no visible end after TURN_LIMIT_MS is
// recorded as `lost`: the thing criterion 4 forbids.
import fs from "node:fs"
import { args, basic, ndjson, rngFor, uniform } from "./common.ts"

export const EVENT_WAIT_MS = 45_000
export const TURN_LIMIT_MS = 180_000
export const POLL_EVERY_MS = 3_000
export const TERMINAL = ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"] as const
export type Outcome = "succeeded" | "failed" | "interrupted"

/** Pull complete `data:` payloads out of a growing SSE buffer; returns the payload lines and the unconsumed tail. */
export function takeSseData(buffer: string) {
  const lines = buffer.split("\n")
  const rest = lines.pop() ?? ""
  return { data: lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()), rest }
}

/** The terminal turn event in an SSE payload, if it is one. A cheap substring test before any JSON.parse. */
export function terminalOf(payload: string): { sessionID: string; outcome: Outcome } | undefined {
  const hit = TERMINAL.find((type) => payload.includes(`"type":"${type}"`))
  if (!hit) return undefined
  const sessionID = /"sessionID":"([^"]+)"/.exec(payload)?.[1]
  return sessionID ? { sessionID, outcome: hit.slice("session.execution.".length) as Outcome } : undefined
}

/** durable (aggregate, seq) of an SSE payload, for counting frames a reconnecting subscriber missed. */
export function durableOf(payload: string) {
  const match = /"aggregateID":"([^"]+)","seq":(\d+)/.exec(payload)
  return match ? { aggregate: match[1]!, seq: Number(match[2]) } : undefined
}

/** Did the session finish a turn that began at or after `startedAt`? From `GET /api/session/:id` -> data. */
export function endedByPoll(info: { outcome?: string; time?: { busy?: number; idle?: number } } | undefined, startedAt: number): Outcome | undefined {
  const busy = info?.time?.busy
  const idle = info?.time?.idle
  if (busy === undefined || idle === undefined || busy < startedAt - 1000 || idle < busy) return undefined
  return info?.outcome === "succeeded" ? "succeeded" : info?.outcome === "interrupted" ? "interrupted" : "failed"
}

export const thinkMs = (seed: number, session: number, turn: number) => Math.round(uniform(rngFor(seed, 7, session, turn), 1000, 6000))
export const reconnectInMs = (seed: number, subscriber: number, count: number, minS: number, maxS: number) => Math.round(uniform(rngFor(seed, 11, subscriber, count), minS * 1000, maxS * 1000))

/** Which sessions get their own subscriber (every third), and which subscribers abort and reconnect (10 %, at least one). */
export function plannedSubscribers(sessions: number, seed: number) {
  const perSession = Array.from({ length: sessions }, (_, i) => i).filter((i) => i % 3 === 0)
  const total = 1 + perSession.length
  const chaosCount = Math.max(1, Math.round(total * 0.1))
  const random = rngFor(seed, 13)
  const chosen = new Set(
    [...perSession]
      .map((i) => ({ i, k: random() }))
      .sort((a, b) => a.k - b.k)
      .slice(0, Math.min(chaosCount, perSession.length))
      .map((x) => x.i),
  )
  return { perSession, chaos: perSession.filter((i) => chosen.has(i)), total }
}

export async function runDriver(options: {
  url: string
  password: string
  dir: string
  work: string
  out: string
  sessions: number
  durationS: number
  warmupS: number
  seed: number
  provider: string
  model: string
  reconnectMinS: number
  reconnectMaxS: number
  pollEveryMs: number
}) {
  const headers = { authorization: basic(options.password), "x-opencode-directory": options.work, "content-type": "application/json" }
  const turnsOut = ndjson(`${options.out}/turns.ndjson`)
  const lagOut = ndjson(`${options.out}/driver-lag.ndjson`)
  const pollsOut = ndjson(`${options.out}/driver-polls.ndjson`)
  const subsOut = ndjson(`${options.out}/driver-subscribers.ndjson`)
  const stats = { turns_started: 0, succeeded: 0, failed: 0, interrupted: 0, lost: 0, via_poll: 0, post_errors: 0, unfinished_at_stop: 0, session_create_errors: 0, polls: 0, poll_errors: 0, subscribers: {} as Record<string, { frames: number; connects: number; disconnects: number; planned_aborts: number; unplanned_ends: number; seq_gaps: number; seq_gap_frames: number }> }
  let stopping = false // no new turns
  let killed = false // SIGTERM: leave now
  const waiters = new Map<string, (outcome: Outcome) => void>()

  // ---- the driver's own event-loop drift
  const lag = (() => {
    let expected = performance.now() + 100
    const tick = () => {
      const now = performance.now()
      lagOut.write({ t: Date.now(), d: Math.max(0, Math.round((now - expected) * 10) / 10) })
      expected = now + 100
      timer = setTimeout(tick, 100)
    }
    let timer = setTimeout(tick, 100)
    return () => clearTimeout(timer)
  })()

  // ---- subscribers
  const abortAll = new AbortController()
  const subscribe = async (name: string, opts: { chaos: boolean; index: number; session?: string; resolve: boolean }) => {
    const s = (stats.subscribers[name] = { frames: 0, connects: 0, disconnects: 0, planned_aborts: 0, unplanned_ends: 0, seq_gaps: 0, seq_gap_frames: 0 })
    let cycle = 0
    const lastSeq = new Map<string, number>()
    while (!stopping && !killed) {
      const controller = new AbortController()
      abortAll.signal.addEventListener("abort", () => controller.abort(), { once: true })
      let planned = false
      const reconnectTimer = opts.chaos
        ? setTimeout(() => {
            planned = true
            controller.abort()
          }, reconnectInMs(options.seed, opts.index, cycle++, options.reconnectMinS, options.reconnectMaxS))
        : undefined
      try {
        const res = await fetch(`${options.url}/api/event`, { headers: { ...headers, accept: "text/event-stream" }, signal: controller.signal })
        if (res.status !== 200 || !res.body) throw new Error(`event stream ${res.status}`)
        s.connects++
        const decoder = new TextDecoder()
        let buffer = ""
        for await (const chunk of res.body) {
          buffer += decoder.decode(chunk, { stream: true })
          const taken = takeSseData(buffer)
          buffer = taken.rest
          for (const payload of taken.data) {
            s.frames++
            if (opts.resolve) {
              const end = terminalOf(payload)
              if (end) waiters.get(end.sessionID)?.(end.outcome)
            }
            const durable = durableOf(payload)
            if (durable) {
              const last = lastSeq.get(durable.aggregate)
              if (last !== undefined && durable.seq > last + 1) {
                s.seq_gaps++
                s.seq_gap_frames += durable.seq - last - 1
              }
              lastSeq.set(durable.aggregate, Math.max(last ?? 0, durable.seq))
            }
          }
        }
        if (!planned && !stopping && !killed) s.unplanned_ends++
      } catch {
        if (!planned && !stopping && !killed) s.unplanned_ends++
      }
      if (reconnectTimer) clearTimeout(reconnectTimer)
      s.disconnects++
      if (planned) s.planned_aborts++
      subsOut.write({ t: Date.now(), subscriber: name, event: planned ? "planned_abort" : stopping || killed ? "stopped" : "unplanned_end", session: opts.session })
      if (stopping || killed) break
      await Bun.sleep(planned ? 250 : 1000)
    }
  }

  // ---- sessions
  const plan = plannedSubscribers(options.sessions, options.seed)
  const ids: string[] = []
  const createSession = async (i: number) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await fetch(`${options.url}/api/session`, {
        method: "POST",
        headers,
        body: JSON.stringify({ title: `h0a-${i}`, location: { directory: options.work }, model: { providerID: options.provider, id: options.model } }),
        signal: AbortSignal.timeout(30_000),
      }).catch(() => undefined)
      const body = res?.status === 200 ? ((await res.json().catch(() => undefined)) as { data?: { id?: string } } | undefined) : undefined
      if (body?.data?.id) return body.data.id
      stats.session_create_errors++
      await Bun.sleep(1000)
    }
    throw new Error(`could not create session ${i}`)
  }

  // The global subscriber runs from the start so no turn end can fall before it is listening.
  const subscribers: Promise<void>[] = [subscribe("global", { chaos: false, index: 0, resolve: true })]
  for (let i = 0; i < options.sessions; i++) ids.push(await createSession(i))
  for (const i of plan.perSession) subscribers.push(subscribe(`session-${i}`, { chaos: plan.chaos.includes(i), index: i + 1, session: ids[i], resolve: false }))

  const t0 = Date.now()
  const measureFrom = t0 + options.warmupS * 1000
  const stopAt = measureFrom + options.durationS * 1000
  console.log(JSON.stringify({ event: "window", t0, measure_from: measureFrom, measure_until: stopAt, sessions: ids.length, subscribers: plan.total, chaos_subscribers: plan.chaos }))

  const turnLoop = async (i: number) => {
    const id = ids[i]!
    for (let turn = 1; !stopping && !killed && Date.now() < stopAt; turn++) {
      const start = Date.now()
      stats.turns_started++
      let resolveEnd!: (outcome: Outcome) => void
      const eventEnd = new Promise<Outcome>((resolve) => (resolveEnd = resolve))
      waiters.set(id, resolveEnd)
      const post = await fetch(`${options.url}/api/session/${id}/prompt`, { method: "POST", headers, body: JSON.stringify({ text: `h0a ${i}.${turn}` }), signal: AbortSignal.timeout(30_000) }).catch(() => undefined)
      const result = { outcome: "lost" as Outcome | "lost", via: "event" }
      if (post?.status !== 200) {
        stats.post_errors++
        result.outcome = "failed" // refused or errored visibly at admission: a visible end, but not a completion
        result.via = "post_error"
      } else {
        const first = await Promise.race([eventEnd, Bun.sleep(EVENT_WAIT_MS).then(() => undefined)])
        if (first) result.outcome = first
        else {
          result.via = "poll"
          // The end event did not arrive: ask the host directly until the turn ends or the limit passes.
          while (!killed && result.outcome === "lost" && Date.now() - start < TURN_LIMIT_MS) {
            const info = await fetch(`${options.url}/api/session/${id}`, { headers, signal: AbortSignal.timeout(10_000) })
              .then((r) => (r.status === 200 ? (r.json() as Promise<{ data?: Parameters<typeof endedByPoll>[0] }>) : undefined))
              .catch(() => undefined)
            const ended = endedByPoll(info?.data, start)
            if (ended) {
              result.outcome = ended
              stats.via_poll++
              break
            }
            await Promise.race([eventEnd.then((o) => ((result.outcome = o), (result.via = "event-late"))), Bun.sleep(POLL_EVERY_MS)])
          }
        }
      }
      waiters.delete(id)
      if (killed) {
        stats.unfinished_at_stop++
        return
      }
      stats[result.outcome]++
      turnsOut.write({ session: id, start, end: result.outcome === "lost" ? null : Date.now(), outcome: result.outcome, via: result.via })
      if (!stopping && Date.now() < stopAt) await Bun.sleep(thinkMs(options.seed, i, turn))
    }
  }

  // ---- the dashboards: session list + server info every pollEveryMs
  const poller = (async () => {
    while (!stopping && !killed) {
      for (const endpoint of ["/api/session", "/api/info"]) {
        const started = performance.now()
        const res = await fetch(options.url + endpoint, { headers, signal: AbortSignal.timeout(10_000) }).catch(() => undefined)
        await res?.arrayBuffer().catch(() => undefined)
        stats.polls++
        if (res?.status !== 200) stats.poll_errors++
        pollsOut.write({ t: Date.now(), ep: endpoint, ms: Math.round(performance.now() - started), status: res?.status ?? 0 })
      }
      await Bun.sleep(options.pollEveryMs)
    }
  })()

  process.on("SIGTERM", () => (killed = true))
  process.on("SIGINT", () => (killed = true))
  await Promise.all(ids.map((_, i) => turnLoop(i)))

  // Everything started has now ended (or been written as lost). Stop the chatter.
  stopping = true
  abortAll.abort()
  await Promise.all([...subscribers, poller])
  lag()
  for (const out of [turnsOut, lagOut, pollsOut, subsOut]) out.close()
  fs.writeFileSync(`${options.out}/driver-stats.json`, JSON.stringify({ ...stats, killed }, null, 2) + "\n")
  return stats
}

if (import.meta.main) {
  const a = args(process.argv.slice(2))
  const need = (key: string) => {
    const v = a[key]
    if (!v) throw new Error(`--${key} is required`)
    return v
  }
  await runDriver({
    url: need("url"),
    password: fs.readFileSync(need("password-file"), "utf8").trim(),
    dir: need("out"),
    out: need("out"),
    work: need("work"),
    sessions: Number(a.sessions ?? 12),
    durationS: Number(need("duration-s")),
    warmupS: Number(a["warmup-s"] ?? 300),
    seed: Number(a.seed ?? 1),
    provider: a.provider ?? "fake",
    model: a.model ?? "m",
    reconnectMinS: Number(a["reconnect-min-s"] ?? 120),
    reconnectMaxS: Number(a["reconnect-max-s"] ?? 300),
    pollEveryMs: Number(a["poll-every-s"] ?? 5) * 1000,
  })
  process.exit(0)
}
