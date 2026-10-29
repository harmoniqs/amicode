import { describe, expect, test } from "bun:test"
import {
  lastSeenStorageKey,
  parseReleasesBody,
  readLastSeenLocal,
  releasesRoute,
  requestWhatsNew,
  onWhatsNewRequest,
  resolveLastSeen,
  writeLastSeenLocal,
} from "./whats-new-model"

function memStorage() {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    m,
  }
}

describe("last-seen storage (web clients) is keyed by host", () => {
  test("two hosts never share a last-seen version", () => {
    const s = memStorage()
    writeLastSeenLocal(s, "https://hub-a.example:4096/", "0.4.0")
    expect(readLastSeenLocal(s, "https://hub-a.example:4096")).toBe("0.4.0")
    expect(readLastSeenLocal(s, "https://hub-b.example")).toBeNull()
    expect(lastSeenStorageKey("https://hub-a.example:4096/x")).toBe("amicode.whatsNew.lastSeen:hub-a.example:4096")
  })

  test("a junk stored value reads as never-seen", () => {
    const s = memStorage()
    s.setItem(lastSeenStorageKey("http://h"), "<script>")
    expect(readLastSeenLocal(s, "http://h")).toBeNull()
  })
})

describe("resolveLastSeen", () => {
  test("framed in VS Code: the extension's globalState answer wins", async () => {
    const s = memStorage()
    writeLastSeenLocal(s, "http://h", "0.3.9")
    const v = await resolveLastSeen({ framed: true, query: async () => "0.3.10", storage: s, serverUrl: "http://h" })
    expect(v).toBe("0.3.10")
  })

  test("framed but the host never answers (deck pane / older extension): falls back to localStorage", async () => {
    const s = memStorage()
    writeLastSeenLocal(s, "http://h", "0.3.9")
    expect(await resolveLastSeen({ framed: true, query: async () => undefined, storage: s, serverUrl: "http://h" })).toBe(
      "0.3.9",
    )
  })

  test("framed and the extension says fresh install (null) → null", async () => {
    const s = memStorage()
    expect(await resolveLastSeen({ framed: true, query: async () => null, storage: s, serverUrl: "http://h" })).toBeNull()
  })

  test("web client: localStorage only", async () => {
    const s = memStorage()
    writeLastSeenLocal(s, "http://h", "0.4.0")
    expect(await resolveLastSeen({ framed: false, storage: s, serverUrl: "http://h" })).toBe("0.4.0")
  })
})

describe("the route + body", () => {
  test("since rides the query; a fresh install omits it", () => {
    expect(releasesRoute("0.3.10")).toBe("/amicode/releases?since=0.3.10")
    expect(releasesRoute(null)).toBe("/amicode/releases")
  })

  test("parses the service body; junk → undefined", () => {
    const body = {
      ok: true,
      current: "0.4.0",
      since: "0.3.10",
      show: true,
      welcome: false,
      cards: [
        { version: "0.4.0", date: "2026-10-29", highlights: [{ title: "t", body: "b" }], links: { notes: null }, body: "" },
        { version: 4 },
      ],
      new_for_you: { models: [{ provider: "anthropic", model: "claude-new", first_ok_at: 5 }, { provider: 1 }] },
      error: null,
    }
    const p = parseReleasesBody(body)
    expect(p?.current).toBe("0.4.0")
    expect(p?.show).toBe(true)
    expect(p?.cards.map((c) => c.version)).toEqual(["0.4.0"])
    expect(p?.newForYou).toEqual([{ provider: "anthropic", model: "claude-new", first_ok_at: 5 }])
    expect(parseReleasesBody({ ok: false, error: "x" })).toBeUndefined()
    expect(parseReleasesBody("nope")).toBeUndefined()
  })
})

describe("reopen requests (palette command + status popover)", () => {
  test("requestWhatsNew notifies every subscriber; unsubscribe stops it", () => {
    let n = 0
    const off = onWhatsNewRequest(() => n++)
    requestWhatsNew()
    expect(n).toBe(1)
    off()
    requestWhatsNew()
    expect(n).toBe(1)
  })
})
