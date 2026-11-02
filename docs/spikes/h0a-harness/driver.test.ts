import { describe, expect, test } from "bun:test"
import { durableOf, endedByPoll, plannedSubscribers, reconnectInMs, takeSseData, terminalOf, thinkMs } from "./driver.ts"

describe("SSE and event parsing", () => {
  test("takeSseData returns whole data lines and keeps the partial tail", () => {
    const first = takeSseData('data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"c"')
    expect(first.data).toEqual(['{"a":1}', '{"b":2}'])
    expect(first.rest).toBe('data: {"c"')
    const second = takeSseData(first.rest + ':3}\n\n')
    expect(second.data).toEqual(['{"c":3}'])
  })
  test("terminalOf recognises exactly the three terminal execution events", () => {
    const frame = (type: string) => `{"id":"evt","type":"${type}","data":{"sessionID":"ses_abc"},"durable":{"aggregateID":"ses_abc","seq":9,"version":1}}`
    expect(terminalOf(frame("session.execution.succeeded"))).toEqual({ sessionID: "ses_abc", outcome: "succeeded" })
    expect(terminalOf(frame("session.execution.failed"))).toEqual({ sessionID: "ses_abc", outcome: "failed" })
    expect(terminalOf(frame("session.execution.interrupted"))).toEqual({ sessionID: "ses_abc", outcome: "interrupted" })
    expect(terminalOf(frame("session.execution.started"))).toBeUndefined()
    expect(terminalOf(frame("session.tool.failed"))).toBeUndefined()
    expect(terminalOf(frame("session.text.delta"))).toBeUndefined()
  })
  test("durableOf extracts the aggregate and sequence", () => {
    expect(durableOf('"durable":{"aggregateID":"ses_x","seq":42,"version":1}')).toEqual({ aggregate: "ses_x", seq: 42 })
    expect(durableOf('{"type":"session.text.delta"}')).toBeUndefined()
  })
})

describe("polling fallback: has the session finished a turn that began at startedAt?", () => {
  const start = 1_000_000
  test("busy after start and idle after busy: ended, with the host's outcome", () => {
    expect(endedByPoll({ outcome: "succeeded", time: { busy: start + 300, idle: start + 5000 } }, start)).toBe("succeeded")
    expect(endedByPoll({ outcome: "failed", time: { busy: start + 300, idle: start + 5000 } }, start)).toBe("failed")
    expect(endedByPoll({ outcome: "interrupted", time: { busy: start + 300, idle: start + 5000 } }, start)).toBe("interrupted")
  })
  test("still busy (idle older than busy): not ended", () => {
    expect(endedByPoll({ outcome: "succeeded", time: { busy: start + 300, idle: start - 4000 } }, start)).toBeUndefined()
  })
  test("the previous turn's idle is not this turn's end", () => {
    expect(endedByPoll({ outcome: "succeeded", time: { busy: start - 9000, idle: start - 4000 } }, start)).toBeUndefined()
  })
  test("no timing info: not ended", () => {
    expect(endedByPoll(undefined, start)).toBeUndefined()
    expect(endedByPoll({ outcome: "succeeded", time: {} }, start)).toBeUndefined()
  })
})

describe("seeded schedules", () => {
  test("think-time is 1-6 s, deterministic, and varies", () => {
    const draws = Array.from({ length: 200 }, (_, i) => thinkMs(5, 3, i))
    expect(Math.min(...draws)).toBeGreaterThanOrEqual(1000)
    expect(Math.max(...draws)).toBeLessThanOrEqual(6000)
    expect(new Set(draws).size).toBeGreaterThan(150)
    expect(thinkMs(5, 3, 9)).toBe(thinkMs(5, 3, 9))
    expect(thinkMs(6, 3, 9)).not.toBe(thinkMs(5, 3, 9))
  })
  test("reconnect interval is 2-5 min by default", () => {
    for (let c = 0; c < 100; c++) {
      const ms = reconnectInMs(1, 2, c, 120, 300)
      expect(ms).toBeGreaterThanOrEqual(120_000)
      expect(ms).toBeLessThanOrEqual(300_000)
    }
  })
  test("one subscriber per third of the sessions, plus the global; about 10 % reconnect, at least one", () => {
    const l1 = plannedSubscribers(12, 1)
    expect(l1.perSession).toEqual([0, 3, 6, 9])
    expect(l1.total).toBe(5)
    expect(l1.chaos.length).toBe(1)
    const l3 = plannedSubscribers(36, 1)
    expect(l3.perSession.length).toBe(12)
    expect(l3.chaos.length).toBe(1)
    expect(plannedSubscribers(4, 1).chaos.length).toBe(1)
    expect(plannedSubscribers(1, 1).perSession).toEqual([0])
    expect(plannedSubscribers(36, 1).chaos).toEqual(plannedSubscribers(36, 1).chaos)
  })
})
