import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { acquireLock, lockPathFor, LockHeldError } from "../src/lock.ts"
import { cleanup, deadPid, makeSandbox } from "./helpers.ts"

afterAll(cleanup)

describe("exclusive start lock keyed by the database path", () => {
  test("the lock file lives next to the database and names this pid", async () => {
    const sb = makeSandbox("lock")
    const lock = await acquireLock(sb.db, { waitMs: 0 })
    expect(lock.path).toBe(lockPathFor(sb.db))
    expect(path.dirname(lock.path)).toBe(path.dirname(sb.db))
    expect(JSON.parse(fs.readFileSync(lock.path, "utf8")).pid).toBe(process.pid)
    lock.release()
    expect(fs.existsSync(lock.path)).toBe(false)
  })

  test("a second acquire while the holder is alive waits, then fails naming the holder pid", async () => {
    const sb = makeSandbox("lock")
    const first = await acquireLock(sb.db, { waitMs: 0 })
    const started = Date.now()
    const second = acquireLock(sb.db, { waitMs: 400 })
    await expect(second).rejects.toThrow(LockHeldError)
    await expect(acquireLock(sb.db, { waitMs: 50 })).rejects.toThrow(String(process.pid))
    expect(Date.now() - started).toBeGreaterThanOrEqual(400)
    first.release()
  })

  test("a waiter takes the lock once the holder releases within the wait", async () => {
    const sb = makeSandbox("lock")
    const first = await acquireLock(sb.db, { waitMs: 0 })
    setTimeout(() => first.release(), 300)
    const second = await acquireLock(sb.db, { waitMs: 5000 })
    expect(second.takeover).toBeUndefined()
    second.release()
  })

  test("a stale lock (dead pid) is taken over and reported", async () => {
    const sb = makeSandbox("lock")
    const pid = await deadPid()
    fs.writeFileSync(lockPathFor(sb.db), JSON.stringify({ pid, token: "stale", startedAt: 1, procStart: "1" }))
    const lock = await acquireLock(sb.db, { waitMs: 0 })
    expect(lock.takeover).toEqual({ pid })
    expect(JSON.parse(fs.readFileSync(lock.path, "utf8")).pid).toBe(process.pid)
    lock.release()
  })

  test("a garbage lock file is taken over only after the grace period", async () => {
    const sb = makeSandbox("lock")
    fs.writeFileSync(lockPathFor(sb.db), "{not json")
    await expect(acquireLock(sb.db, { waitMs: 0, garbageGraceMs: 5000 })).rejects.toThrow(LockHeldError)
    const lock = await acquireLock(sb.db, { waitMs: 2000, garbageGraceMs: 100 })
    expect(JSON.parse(fs.readFileSync(lock.path, "utf8")).pid).toBe(process.pid)
    lock.release()
  })

  test("release never removes a lock that someone else now owns", async () => {
    const sb = makeSandbox("lock")
    const mine = await acquireLock(sb.db, { waitMs: 0 })
    fs.writeFileSync(mine.path, JSON.stringify({ pid: process.pid, token: "someone-else", startedAt: 1 }))
    mine.release()
    expect(fs.existsSync(mine.path)).toBe(true)
    expect(JSON.parse(fs.readFileSync(mine.path, "utf8")).token).toBe("someone-else")
  })

  test("locks are keyed by database path: different databases do not contend", async () => {
    const sb = makeSandbox("lock")
    const a = await acquireLock(path.join(sb.data, "a.db"), { waitMs: 0 })
    const b = await acquireLock(path.join(sb.data, "b.db"), { waitMs: 0 })
    a.release()
    b.release()
  })

  test("racing acquirers over a stale lock: exactly one wins at a time", async () => {
    const sb = makeSandbox("lock")
    const pid = await deadPid()
    fs.writeFileSync(lockPathFor(sb.db), JSON.stringify({ pid, token: "stale", startedAt: 1, procStart: "1" }))
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => acquireLock(sb.db, { waitMs: 0 })))
    const winners = results.filter((r) => r.status === "fulfilled")
    expect(winners.length).toBe(1)
    for (const r of results) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(LockHeldError)
    for (const w of winners) w.value.release()
  })
})
