import { afterEach, describe, expect, test } from "bun:test"
import * as Http from "node:http"
import * as Net from "node:net"
import { Effect } from "effect"
import { EventPaths } from "../../src/server/routes/instance/httpapi/groups/event"
import {
  armSseSocketKeepalive,
  readTcpKeepalive,
  resetTcpKeepaliveNotices,
  resetTcpKeepaliveSink,
  setTcpKeepaliveSink,
  tcpKeepaliveKnobs,
  tcpKeepalivePlan,
} from "../../src/server/shared/tcp-keepalive"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

// ── #1810: kernel-level corpse detection — SO_KEEPALIVE + TCP_USER_TIMEOUT ────
//
// The #1798 corpse class (half-dead sockets blocking fan-out writes) is
// detected today by application-level dead-men on a 60s cadence. This slice
// arms the layer-4 fix: aggressive keepalives (idle 30s, interval 5s, count 3
// → the OS reaps a FIN-less corpse in ≤45s) plus TCP_USER_TIMEOUT (~30s — a
// write to a socket whose data cannot drain errors instead of blocking).
//
// Every assertion here reads the options BACK from the kernel (getsockopt via
// the module's own read-back), never trusting that the setter ran.
//
// The honest runtime boundary this file pins: raw node:net sockets under bun
// expose `_handle.fd` (real kernel socket, full option surface), while
// bun's node:http server sockets are the native-shim family (no fd, no
// option surface — the same runtime gap family as the 2026-10-14
// res.destroy-sends-no-FIN measurement in handlers/event.ts). The module
// arms the former and degrades LOUDLY (never silently) on the latter.

const openPair = () =>
  new Promise<{ client: Net.Socket; server: Net.Socket; close: () => void }>((resolve) => {
    let client: Net.Socket | undefined
    const listener = Net.createServer({ pauseOnConnect: true }, (server) => {
      resolve({
        client: client!,
        server,
        close: () => {
          server.destroy()
          client?.destroy()
          listener.close()
        },
      })
    })
    listener.listen(0, "127.0.0.1", () => {
      const port = (listener.address() as Net.AddressInfo).port
      client = Net.connect({ host: "127.0.0.1", port })
    })
  })

describe("tcp keepalive module (#1810)", () => {
  const savedEnv = new Map<string, string | undefined>()
  const setEnv = (key: string, value: string) => {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key])
    process.env[key] = value
  }

  afterEach(() => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    savedEnv.clear()
    resetTcpKeepaliveSink()
    resetTcpKeepaliveNotices()
  })

  test("arms a real accepted socket; the kernel reads the briefed values back", () => {
    const lines: Array<string> = []
    setTcpKeepaliveSink((line) => lines.push(line))

    return openPair().then((pair) => {
      const report = armSseSocketKeepalive(pair.server, "/event")

      // The read-back is the contract: getsockopt on the same socket, not
      // trust in the setter. SO_KEEPALIVE + idle 30s / interval 5s / count 3
      // + TCP_USER_TIMEOUT 30000ms (the briefed defaults).
      expect(readTcpKeepalive(pair.server)).toEqual({
        keepalive: true,
        keepIdleS: 30,
        keepIntvlS: 5,
        keepCnt: 3,
        userTimeoutMs: 30_000,
      })
      expect(report.fdArmed).toBe(true)
      expect(report.keepalive).toBe(true)
      expect(report.userTimeoutArmed).toBe(true)
      expect(report.shimFallback).toBe(false)

      // The armed telemetry line carries the kernel's OWN read-back values.
      expect(lines.some((line) => /^SSE-KEEPALIVE route=\/event fd=\d+ keepalive=1 keepidle_s=30 keepintvl_s=5 keepcnt=3 user_timeout_ms=30000$/.test(line))).toBe(true)

      pair.close()
    })
  })

  test("env knobs tune the options (AC3)", () => {
    setEnv("AMICODE_TCP_KEEPIDLE_S", "12")
    setEnv("AMICODE_TCP_KEEPINTVL_S", "4")
    setEnv("AMICODE_TCP_KEEPCNT", "9")
    setEnv("AMICODE_TCP_USER_TIMEOUT_MS", "45000")
    expect(tcpKeepaliveKnobs()).toEqual({ keepIdleS: 12, keepIntvlS: 4, keepCnt: 9, userTimeoutMs: 45_000 })

    return openPair().then((pair) => {
      armSseSocketKeepalive(pair.server, "/event")
      expect(readTcpKeepalive(pair.server)).toEqual({
        keepalive: true,
        keepIdleS: 12,
        keepIntvlS: 4,
        keepCnt: 9,
        userTimeoutMs: 45_000,
      })
      pair.close()
    })
  })

  test("invalid knob values keep the briefed defaults (AC3)", () => {
    setEnv("AMICODE_TCP_KEEPIDLE_S", "abc")
    setEnv("AMICODE_TCP_KEEPINTVL_S", "-3")
    setEnv("AMICODE_TCP_KEEPCNT", "x9")
    setEnv("AMICODE_TCP_USER_TIMEOUT_MS", "0")
    expect(tcpKeepaliveKnobs()).toEqual({ keepIdleS: 30, keepIntvlS: 5, keepCnt: 3, userTimeoutMs: 30_000 })

    return openPair().then((pair) => {
      armSseSocketKeepalive(pair.server, "/event")
      expect(readTcpKeepalive(pair.server)).toEqual({
        keepalive: true,
        keepIdleS: 30,
        keepIntvlS: 5,
        keepCnt: 3,
        userTimeoutMs: 30_000,
      })
      pair.close()
    })
  })

  test("a platform without the TCP_USER_TIMEOUT knob degrades to keepalives only (AC4)", () => {
    const lines: Array<string> = []
    setTcpKeepaliveSink((line) => lines.push(line))
    // bun shares one process across test files: the once-per-process gap
    // limiter must not swallow this test's telemetry.
    resetTcpKeepaliveNotices()

    return openPair().then((pair) => {
      // 999 is never a valid IPPROTO_TCP optname on Linux → ENOPROTOOPT at
      // the kernel: the forced shape of a platform without the knob.
      const report = armSseSocketKeepalive(pair.server, "/event", { options: { userTimeout: 999 } })
      expect(report.keepalive).toBe(true)
      expect(report.userTimeoutArmed).toBe(false)

      // keepalives only — no crash, no silent skip of the keepalive family.
      expect(readTcpKeepalive(pair.server)).toEqual({
        keepalive: true,
        keepIdleS: 30,
        keepIntvlS: 5,
        keepCnt: 3,
        userTimeoutMs: 0,
      })
      expect(lines.some((line) => line.includes("user_timeout_ms=0"))).toBe(true)
      pair.close()
    })
  })

  test("the platform plan is linux-both / other-keepalives-only (AC4)", () => {
    expect(tcpKeepalivePlan("linux")).toEqual({ keepalives: true, userTimeout: true })
    expect(tcpKeepalivePlan("darwin")).toEqual({ keepalives: true, userTimeout: false })
  })

  test("a socket whose fd is unreachable (bun's node:http shim) degrades LOUDLY, never silently", () => {
    const lines: Array<string> = []
    setTcpKeepaliveSink((line) => lines.push(line))
    resetTcpKeepaliveNotices()

    const server = Http.createServer((req, res) => {
      // bun's node:http hands the handler a NodeHTTPServerSocket: native
      // handle with no fd, no option surface — measured (see the module's
      // header). The arm must degrade without throwing and SAY so.
      const report = armSseSocketKeepalive(req.socket, "/event")
      expect(report.shimFallback).toBe(true)
      expect(readTcpKeepalive(req.socket)).toBeUndefined()
      res.end("ok")
      server.close()
    })
    return new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        const port = (server.address() as Net.AddressInfo).port
        const client = Net.connect({ host: "127.0.0.1", port })
        client.on("error", reject)
        // The handler (and its arm) has provably run once the response lands.
        client.on("data", () => resolve())
        client.on("close", () => resolve())
        client.on("connect", () => client.write("GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"))
      })
      server.on("error", reject)
    }).then(() => {
      expect(lines.some((line) => line.startsWith("SSE-KEEPALIVE-GAP route=/event"))).toBe(true)
    })
  })
})

// ── the production routes run the arm at SSE connection setup ──────────────────
//
// The route-level contract: opening the real SSE route arms the subscriber
// socket at setup. Under THIS runtime the accepted route socket is bun's
// node:http shim (fd unreachable) — so the route's honest behavior is the
// LOUD degradation line, and the stream must serve normally regardless (the
// arm can never break the route).

const it = testEffect(httpApiLayer)

describe("SSE route keepalive wiring (#1810)", () => {
  afterEach(async () => {
    await disposeAllInstances()
    await resetDatabase()
    resetTcpKeepaliveSink()
    resetTcpKeepaliveNotices()
  })

  it.instance(
    "the /event route arms the subscriber socket at SSE setup",
    () =>
      Effect.gen(function* () {
        const lines: Array<string> = []
        setTcpKeepaliveSink((line) => lines.push(line))
        resetTcpKeepaliveNotices()

        const { directory } = yield* TestInstance
        const response = yield* requestInDirectory(EventPaths.event, directory)
        expect(response.status).toBe(200)

        // The arm runs inside the handler before the response lands: some
        // SSE-KEEPALIVE line must exist naming the route — the armed line on
        // runtimes that expose the socket fd, the GAP line on this one.
        expect(lines.some((line) => /^SSE-KEEPALIVE(-GAP|-FAILED)? route=\/event\b/.test(line))).toBe(true)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "the /global/event route arms the subscriber socket at SSE setup",
    () =>
      Effect.gen(function* () {
        const lines: Array<string> = []
        setTcpKeepaliveSink((line) => lines.push(line))
        resetTcpKeepaliveNotices()

        const response = yield* requestInDirectory("/global/event", "/")
        expect(response.status).toBe(200)
        expect(lines.some((line) => /^SSE-KEEPALIVE(-GAP|-FAILED)? route=\/global\/event\b/.test(line))).toBe(true)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})
