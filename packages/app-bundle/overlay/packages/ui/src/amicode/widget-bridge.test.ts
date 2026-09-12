import { describe, expect, test } from "bun:test"
import { handleWidgetMessage, type BridgeDeps } from "./widget-bridge"

function deps(over: Partial<BridgeDeps> = {}) {
  const calls: Record<string, unknown[]> = { fetch: [], action: [], prompt: [], open: [], post: [], height: [], empty: [], error: [], ready: [] }
  const d: BridgeDeps = {
    fetch: async (p) => {
      calls.fetch.push(p)
      return { ok: true }
    },
    action: async (v, payload) => {
      calls.action.push([v, payload])
      return { done: true }
    },
    prompt: (t) => void calls.prompt.push(t),
    open: (e) => void calls.open.push(e),
    ready: () => void calls.ready.push(true),
    height: (h) => void calls.height.push(h),
    empty: (e) => void calls.empty.push(e),
    error: (m) => void calls.error.push(m),
    post: (m) => void calls.post.push(m),
    ...over,
  }
  return { d, calls }
}

describe("handleWidgetMessage", () => {
  test("allowed fetch → deps.fetch called, ok result posted with id", async () => {
    const { d, calls } = deps()
    await handleWidgetMessage({ t: "amc:fetch", id: 7, path: "/amicode/profile" }, d)
    expect(calls.fetch).toEqual(["/amicode/profile"])
    expect(calls.post[0]).toEqual({ t: "amc:result", id: 7, ok: true, data: { ok: true } })
  })

  test("disallowed fetch → error result, fetcher NOT called", async () => {
    const { d, calls } = deps()
    await handleWidgetMessage({ t: "amc:fetch", id: 8, path: "/session" }, d)
    expect(calls.fetch).toEqual([])
    expect((calls.post[0] as any).ok).toBe(false)
  })

  test("fetch failure → error result, never throws", async () => {
    const { d, calls } = deps({
      fetch: async () => {
        throw new Error("HTTP 500")
      },
    })
    await handleWidgetMessage({ t: "amc:fetch", id: 9, path: "/amicode/profile" }, d)
    expect((calls.post[0] as any).error).toBe("HTTP 500")
  })

  test("allowed action routed with payload; disallowed rejected", async () => {
    const { d, calls } = deps()
    await handleWidgetMessage({ t: "amc:action", id: 1, verb: "save-profile", payload: { name: "A" } }, d)
    expect(calls.action[0]).toEqual(["save-profile", { name: "A" }])
    await handleWidgetMessage({ t: "amc:action", id: 2, verb: "rm-rf" }, d)
    expect(calls.action).toHaveLength(1)
    expect((calls.post[1] as any).ok).toBe(false)
  })

  test("prompt / open / height / empty / error / ready routed", async () => {
    const { d, calls } = deps()
    await handleWidgetMessage({ t: "amc:prompt", text: "hi" }, d)
    await handleWidgetMessage({ t: "amc:open", entity: "run" }, d)
    await handleWidgetMessage({ t: "amc:height", h: 120 }, d)
    await handleWidgetMessage({ t: "amc:empty", empty: true }, d)
    await handleWidgetMessage({ t: "amc:empty", empty: false }, d)
    await handleWidgetMessage({ t: "amc:error", message: "boom" }, d)
    await handleWidgetMessage({ t: "amc:ready" }, d)
    expect(calls.prompt).toEqual(["hi"])
    expect(calls.open).toEqual(["run"])
    expect(calls.height).toEqual([120])
    expect(calls.empty).toEqual([true, false])
    expect(calls.error).toEqual(["boom"])
    expect(calls.ready).toEqual([true])
  })

  test("malformed messages ignored (frames are untrusted)", async () => {
    const { d, calls } = deps()
    await handleWidgetMessage(null, d)
    await handleWidgetMessage({ t: "amc:height", h: "tall" }, d)
    await handleWidgetMessage({ t: "amc:empty", empty: "yes" }, d)
    await handleWidgetMessage({ t: "amc:fetch", path: "/amicode/profile" }, d) // no id
    await handleWidgetMessage({ t: "wat" }, d)
    expect(calls.post).toEqual([])
    expect(calls.height).toEqual([])
    expect(calls.fetch).toEqual([])
  })
})
