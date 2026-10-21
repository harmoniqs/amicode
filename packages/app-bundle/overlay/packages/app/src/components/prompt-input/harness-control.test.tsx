import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { ServerConnection } from "@/context/server"
import { adoptHarnessState, harnessRoute, liveHarnessState, refreshHarnessState } from "./harness"

// amicode#1799 — the harness composer control never rendered in the hub-client
// posture. The composer's mount-path fetch was the ONLY instance-scoped ask in
// the app that carried no ?directory= placement key: /amicode/harness is an
// INSTANCE route (routes/instance/httpapi), and every other instance-scoped
// fetch the composer makes (/agent, /provider, /command, /question…) carries
// the location directory — the key the hub frontdoor routes instance requests
// by. In the LOCAL posture the panel origin is the extension service, whose
// #1549 exception forwards the bare ask to its bound engine (one engine, one
// instance), so the bare route worked. In the hub-client posture (#1784) the
// panel origin IS the hub frontdoor: a directory-less instance ask cannot be
// placed and lands on the default backend, which answers 200 text/html with
// the SPA index document (verified live: bare /amicode/harness → text/html,
// /amicode/harness?directory=… → application/json registry). The HTML answer
// fails amicodeGet's .json() parse, the catch adopts undefined, and
// liveHarnessState() — the control's render gate — stays never-true: zero
// renders while /agent and /provider fetch fine.
//
// The component's behavioral substance (route construction + fetch + adopt)
// lives in the state module (./harness) so the mount path is testable without
// a DOM (the solver-toggle decision-helper split; bun's transpiler runs no
// Solid JSX transform — see lineage-ledger-panel.test.tsx). This suite drives
// that seam under BOTH postures' server contexts and pins the composer wiring.

const READY_MENU = {
  ok: true,
  harness: "opencode",
  status: "ready",
  options: [
    { id: "opencode", displayName: "opencode (default)", state: "ready", detail: "The default harness.", disabled: false },
    { id: "telaio", displayName: "telaio", state: "needs-setup", detail: "Requires the telaio binary.", disabled: true, reason: "telaio binary not installed" },
  ],
}

// The P4 hub-client posture's server context: the framed app derives its
// ENTIRE registry from the document origin — registry IS {hub}, a single http
// connection, no local sidecar (#1784). The context object the control reads
// is structurally its `.current` accessor.
const HUB_ORIGIN = "http://127.0.0.1:4097"
const HUB_CONN = { type: "http", http: { url: HUB_ORIGIN } } as ServerConnection.Any
const DIRECTORY = "/home/aaron/harmoniqs/opencode"

// What the hub answered the bare ask with, verbatim shape (200 text/html).
const SPA_INDEX = "<!doctype html><html><head><title>OpenCode</title></head></html>"

const registryJson = () =>
  new Response(JSON.stringify(READY_MENU), { status: 200, headers: { "content-type": "application/json" } })
const spaIndexHtml = () => new Response(SPA_INDEX, { status: 200, headers: { "content-type": "text/html" } })

// The DOM lib's `typeof fetch` now requires a `preconnect` member (lib drift):
// a bare async wrapper is not assignable, and casting it papered over the
// gap. Compose the mock with the real fetch's preconnect — the mock then IS a
// fetch, no cast (the server-protocol.test.ts idiom).
const mockFetch = (run: (input: RequestInfo | URL) => Promise<Response>): typeof fetch =>
  Object.assign(run, { preconnect: globalThis.fetch.preconnect })

/** The hub frontdoor's placement semantics for the harness route, as observed
 *  live (#1799): a directory-carrying ask is placed to the directory's member
 *  engine and answered with the registry JSON; a directory-less ask lands on
 *  the default backend and is answered with the SPA index document. */
const hubFrontdoor = (recorded: string[]) =>
  mockFetch(async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    recorded.push(url.pathname + url.search)
    if (url.pathname !== "/amicode/harness") throw new Error(`unexpected probe route: ${url.pathname}`)
    return url.searchParams.has("directory") ? registryJson() : spaIndexHtml()
  })

describe("#1799 harnessRoute — the placement-correct ask", () => {
  test("carries the instance placement directory, the key every other instance-scoped composer fetch rides", () => {
    expect(harnessRoute(DIRECTORY)).toBe(`/amicode/harness?directory=${encodeURIComponent(DIRECTORY)}`)
  })

  test("a missing directory keeps the bare ask — the local posture's original behavior", () => {
    expect(harnessRoute("")).toBe("/amicode/harness")
  })
})

describe("#1799 the mount-path refresh in the hub-client posture (the framed app's registry IS {hub})", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    adoptHarnessState(undefined)
  })

  test("renders the control: the ask is placed by directory and the registry adopts (RED on the bare ask)", async () => {
    const recorded: string[] = []
    globalThis.fetch = hubFrontdoor(recorded)
    await refreshHarnessState({ current: HUB_CONN }, DIRECTORY)
    // The live RED: the old bare ask got the SPA index → no state → the
    // control's <Show when={liveHarnessState()}> gate stayed never-true.
    expect(liveHarnessState()?.harness).toBe("opencode")
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toContain("directory=")
  })

  test("the old bare ask collapses: the hub's 200 text/html SPA answer adopts no state — the never-render, reproduced", async () => {
    const recorded: string[] = []
    globalThis.fetch = hubFrontdoor(recorded)
    await refreshHarnessState({ current: HUB_CONN }, "")
    expect(liveHarnessState()).toBeUndefined()
    expect(recorded).toEqual(["/amicode/harness"])
  })

  test("no connection → stays hidden, no fetch (the server.current guard's degradation, unchanged)", async () => {
    const recorded: string[] = []
    globalThis.fetch = hubFrontdoor(recorded)
    await refreshHarnessState({ current: undefined }, DIRECTORY)
    expect(liveHarnessState()).toBeUndefined()
    expect(recorded).toHaveLength(0)
  })
})

describe("#1799 the mount-path refresh in the local posture — unchanged", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    adoptHarnessState(undefined)
  })

  test("the service origin forwards the ask to the bound engine (query preserved) — the control mounts", async () => {
    const recorded: string[] = []
    globalThis.fetch = mockFetch(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      recorded.push(url.pathname + url.search)
      if (url.pathname !== "/amicode/harness") throw new Error(`unexpected probe route: ${url.pathname}`)
      return registryJson()
    })
    await refreshHarnessState({ current: { type: "http", http: { url: "http://127.0.0.1:4095" } } as ServerConnection.Any }, DIRECTORY)
    expect(liveHarnessState()?.harness).toBe("opencode")
    expect(recorded).toHaveLength(1)
  })

  test("route absent → stays hidden (the stock-engine degradation contract)", async () => {
    globalThis.fetch = mockFetch(
      async () => new Response(JSON.stringify({ ok: false, error: "no route" }), { status: 404 }),
    )
    await refreshHarnessState({ current: HUB_CONN }, DIRECTORY)
    expect(liveHarnessState()).toBeUndefined()
  })
})

describe("#1799 the refresh sequence — only the LATEST ask adopts", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    adoptHarnessState(undefined)
  })

  test("a stale in-flight answer never clobbers a newer ask's state (the two mount effects can race)", async () => {
    // Live shape: the mount effects (server-change + stream-connect) can both
    // have asks in flight; during a member switch one answer came back the
    // SPA index while the other carried the registry — last-writer-wins on
    // the module singleton made renders racy. Only the latest ask may adopt.
    const gates: Array<(response: Response) => void> = []
    globalThis.fetch = mockFetch(async () => new Promise<Response>((resolve) => gates.push(resolve)))
    const first = refreshHarnessState({ current: HUB_CONN }, DIRECTORY)
    const second = refreshHarnessState({ current: HUB_CONN }, DIRECTORY)
    gates[1]?.(registryJson())
    await second
    gates[0]?.(spaIndexHtml())
    await first
    expect(liveHarnessState()?.harness).toBe("opencode")
  })
})

describe("#1799 the composer control's wiring (the mount effects + the switch write)", () => {
  const source = readFileSync(resolve(__dirname, "harness-control.tsx"), "utf8")

  test("the mount effects keep the server.current and stream-connected guards AND thread the placement directory", () => {
    expect(source).toContain("if (server.current) void refreshHarnessState(server, directory())")
    expect(source).toContain('if (sdk().event.status() === "connected") void refreshHarnessState(server, directory())')
  })

  test("the placement directory comes from the per-directory SDK context — the same source every other instance-scoped composer fetch rides", () => {
    expect(source).toContain("const dirSdk = useSDK()")
    expect(source).toContain("dirSdk().directory")
  })

  test("the switch POST carries the placement route too (the write path is the same instance route)", () => {
    expect(source).toContain("amicodePost(conn, harnessRoute(directory())")
  })

  test("the fetch/parse/adopt body lives in the testable state module, not inlined in the component", () => {
    expect(source).not.toContain("amicodeGet(server.current")
    expect(source).not.toContain("adoptHarnessState(parseHarnessState(")
  })
})
