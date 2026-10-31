import { describe, expect, test } from "bun:test"
import {
  buildCardViews,
  initialExpanded,
  isLongBody,
  keyAction,
  lastSeenStorageKey,
  notesLink,
  summaryLine,
  toggleIn,
  whatsNewKeyHandler,
  type WhatsNewCard,
  type WhatsNewPayload,
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
    expect(p?.since).toBe("0.3.10")
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

// ── amicode#2020: the pinned-frame page — expand/collapse, clamp, ordering, keys ──
const card = (version: string, over: Partial<WhatsNewCard> = {}): WhatsNewCard => ({
  version,
  date: "2026-10-29",
  highlights: [{ title: `${version} headline`, body: "short" }],
  notes: null,
  body: "",
  ...over,
})
const payload = (over: Partial<WhatsNewPayload> = {}): WhatsNewPayload => ({
  current: "0.4.0",
  since: "0.3.10",
  show: true,
  welcome: false,
  cards: [card("0.4.0"), card("0.3.11"), card("0.3.10")],
  newForYou: [],
  ...over,
})
const LONG = "word ".repeat(60).trim()

describe("expanded state (newest open, older collapsed)", () => {
  test("with 3 cards only the newest starts expanded", () => {
    const cards = payload().cards
    expect(initialExpanded(cards)).toEqual(["0.4.0"])
    const views = buildCardViews(payload(), initialExpanded(cards), [])
    expect(views.map((v) => v.expanded)).toEqual([true, false, false])
    expect(views.map((v) => v.version)).toEqual(["0.4.0", "0.3.11", "0.3.10"])
  })

  test("toggling expands an older card, and collapses it again; the original is not mutated", () => {
    const start = initialExpanded(payload().cards)
    const open = toggleIn(start, "0.3.11")
    expect(open).toEqual(["0.4.0", "0.3.11"])
    expect(start).toEqual(["0.4.0"])
    expect(buildCardViews(payload(), open, []).map((v) => v.expanded)).toEqual([true, true, false])
    expect(toggleIn(open, "0.3.11")).toEqual(["0.4.0"])
    expect(toggleIn(open, "0.4.0")).toEqual(["0.3.11"])
  })

  test("no cards → nothing expanded", () => expect(initialExpanded([])).toEqual([]))
})

describe("highlight body clamp (~2 lines + Show more)", () => {
  test("a short body is never clamped and offers no Show more", () => {
    expect(isLongBody("one line")).toBe(false)
    const [v] = buildCardViews(payload(), ["0.4.0"], [])
    expect(v.highlights[0]).toMatchObject({ clamped: false, canToggle: false })
  })

  test("a long body is clamped with Show more until toggled", () => {
    expect(isLongBody(LONG)).toBe(true)
    expect(isLongBody("a\nb\nc")).toBe(true)
    const p = payload({ cards: [card("0.4.0", { highlights: [{ title: "t", body: LONG }] })] })
    const [closed] = buildCardViews(p, ["0.4.0"], [])
    expect(closed.highlights[0]).toMatchObject({ clamped: true, canToggle: true, key: "0.4.0:0" })
    const [open] = buildCardViews(p, ["0.4.0"], ["0.4.0:0"])
    expect(open.highlights[0]).toMatchObject({ clamped: false, canToggle: true })
  })

  test("the card's free-text body clamps the same way", () => {
    const p = payload({ cards: [card("0.4.0", { body: LONG })] })
    expect(buildCardViews(p, ["0.4.0"], [])[0].bodyClamped).toBe(true)
    expect(buildCardViews(p, ["0.4.0"], ["0.4.0:body"])[0].bodyClamped).toBe(false)
  })
})

describe("New for you", () => {
  const arrivals = [{ provider: "anthropic", model: "claude-new", first_ok_at: 5 }]

  test("rides on the newest card only, and only when there are arrivals", () => {
    const views = buildCardViews(payload({ newForYou: arrivals }), ["0.4.0"], [])
    expect(views.map((v) => v.newForYou.length)).toEqual([1, 0, 0])
    expect(buildCardViews(payload(), ["0.4.0"], [])[0].newForYou).toEqual([])
  })
})

describe("header + footer copy", () => {
  test("summary line leads with what changed since the last-seen version", () => {
    expect(summaryLine(payload())).toBe("What changed since 0.3.10")
    expect(summaryLine(payload({ since: null }))).toBe("Version 0.4.0")
    expect(summaryLine(payload({ since: "0.0.0" }))).toBe("Version 0.4.0")
    expect(summaryLine(payload({ welcome: true }))).toBe("Version 0.4.0")
  })

  test("the footer's release-notes link is the newest card that has one", () => {
    expect(notesLink(payload())).toBeNull()
    const p = payload({ cards: [card("0.4.0"), card("0.3.11", { notes: "https://n/0.3.11" })] })
    expect(notesLink(p)).toBe("https://n/0.3.11")
  })
})

describe("keys: Enter and Esc both dismiss", () => {
  test("keyAction", () => {
    expect(keyAction({ key: "Escape" })).toBe("dismiss")
    expect(keyAction({ key: "Enter" })).toBe("dismiss")
    expect(keyAction({ key: "Enter", target: { tag: "DIV" } })).toBe("dismiss")
    expect(keyAction({ key: "Enter", target: { tag: "BUTTON", continue: true } })).toBe("dismiss")
    // Enter in an input / on another control belongs to that control
    expect(keyAction({ key: "Enter", target: { tag: "INPUT" } })).toBeNull()
    expect(keyAction({ key: "Enter", target: { tag: "TEXTAREA" } })).toBeNull()
    expect(keyAction({ key: "Enter", target: { tag: "DIV", editable: true } })).toBeNull()
    expect(keyAction({ key: "Enter", target: { tag: "BUTTON" } })).toBeNull()
    expect(keyAction({ key: "Enter", target: { tag: "A" } })).toBeNull()
    // Esc always dismisses, even from an input; other keys do nothing
    expect(keyAction({ key: "Escape", target: { tag: "INPUT" } })).toBe("dismiss")
    expect(keyAction({ key: "a" })).toBeNull()
  })

  test("the handler dismisses on Enter and on Esc, swallowing the event", () => {
    let dismissed = 0
    const h = whatsNewKeyHandler(() => dismissed++)
    for (const key of ["Enter", "Escape"]) {
      let prevented = 0
      let stopped = 0
      h({ key, target: null, preventDefault: () => prevented++, stopPropagation: () => stopped++ })
      expect([prevented, stopped]).toEqual([1, 1])
    }
    expect(dismissed).toBe(2)
    h({ key: "x", target: null, preventDefault: () => {}, stopPropagation: () => {} })
    expect(dismissed).toBe(2)
  })
})
