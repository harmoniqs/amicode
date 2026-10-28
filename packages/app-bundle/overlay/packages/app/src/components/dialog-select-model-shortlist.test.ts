// amicode#1987 (#1979 S4): the picker's short-list view — pure, so ordering,
// dedupe, the cap, the allowlist hard-filter and search reach are pinned
// without mounting the SolidJS picker.
import { describe, expect, test } from "bun:test"
import {
  SHORTLIST_CAP,
  buildModelShortlist,
  isAllowed,
  parseShortlistConfig,
  type ShortlistConfig,
} from "./dialog-select-model-shortlist"

type Item = { id: string; name: string; provider: { id: string; name: string } }
const item = (provider: string, id: string): Item => ({ id, name: id, provider: { id: provider, name: provider } })
const keyOf = (x: Item) => ({ providerID: x.provider.id, modelID: x.id })
const ref = (providerID: string, modelID: string) => ({ providerID, modelID })
const ids = (xs: readonly Item[]) => xs.map((x) => `${x.provider.id}/${x.id}`)
const searchText = (x: Item) => [x.name, x.id, x.provider.name]

const base = {
  keyOf,
  searchText,
  hidden: [] as Item[],
  showUnavailable: false,
  favorites: [] as ReturnType<typeof ref>[],
  recents: [] as ReturnType<typeof ref>[],
  config: undefined as ShortlistConfig | undefined,
  query: "",
}

const many = (n: number, provider = "p") => Array.from({ length: n }, (_, i) => item(provider, `m${i}`))

describe("parseShortlistConfig", () => {
  test("a well-formed body parses recommended + allowlist", () => {
    const cfg = parseShortlistConfig({
      ok: true,
      model: {
        recommended: [
          { model: "anthropic/claude-sonnet", role: "default" },
          { model: "openrouter/meta/llama-3", role: "open-weight" },
        ],
        allowlist: ["anthropic/*", "openrouter/meta/llama-3"],
      },
    })
    expect(cfg).toEqual({
      recommended: [
        { ref: ref("anthropic", "claude-sonnet"), role: "default" },
        // the model id keeps everything after the FIRST slash
        { ref: ref("openrouter", "meta/llama-3"), role: "open-weight" },
      ],
      allowlist: ["anthropic/*", "openrouter/meta/llama-3"],
    })
  })

  test("route unavailable / ok:false / malformed → undefined (no config)", () => {
    expect(parseShortlistConfig(undefined)).toBeUndefined()
    expect(parseShortlistConfig("x")).toBeUndefined()
    expect(parseShortlistConfig({ ok: false, error: "x" })).toBeUndefined()
  })

  test("bad entries are dropped, never guessed: unknown role, no slash, non-string", () => {
    const cfg = parseShortlistConfig({
      ok: true,
      model: {
        recommended: [
          { model: "a/x", role: "turbo" },
          { model: "noslash", role: "fast" },
          { model: 3, role: "fast" },
          { model: "a/y" },
          { model: "a/z", role: "strong" },
        ],
        allowlist: ["a/*", 7, "", "noslash"],
      },
    })
    expect(cfg?.recommended).toEqual([{ ref: ref("a", "z"), role: "strong" }])
    expect(cfg?.allowlist).toEqual(["a/*"])
  })

  test("no allowlist key → undefined allowlist (no filter); no recommended → none invented", () => {
    const cfg = parseShortlistConfig({ ok: true, model: {} })
    expect(cfg).toEqual({ recommended: [], allowlist: undefined })
  })
})

describe("isAllowed", () => {
  test("no allowlist (or an empty one) allows everything", () => {
    expect(isAllowed(ref("a", "x"), undefined)).toBe(true)
    expect(isAllowed(ref("a", "x"), [])).toBe(true)
  })
  test("exact provider/id and provider/* wildcard", () => {
    const list = ["a/*", "b/keep", "c/ns/deep"]
    expect(isAllowed(ref("a", "anything"), list)).toBe(true)
    expect(isAllowed(ref("b", "keep"), list)).toBe(true)
    expect(isAllowed(ref("b", "drop"), list)).toBe(false)
    expect(isAllowed(ref("c", "ns/deep"), list)).toBe(true)
    expect(isAllowed(ref("d", "x"), list)).toBe(false)
  })
})

describe("buildModelShortlist — default view", () => {
  const shown = [item("a", "fav1"), item("a", "rec-fast"), item("b", "rec-default"), item("b", "recent1"), item("c", "rest")]
  const config: ShortlistConfig = {
    recommended: [
      { ref: ref("a", "rec-fast"), role: "fast" },
      { ref: ref("b", "rec-default"), role: "default" },
    ],
    allowlist: undefined,
  }

  test("Favorites → Recommended (by role: default, fast, strong, open-weight) → Recent", () => {
    const view = buildModelShortlist({
      ...base,
      shown,
      config,
      favorites: [ref("a", "fav1")],
      recents: [ref("b", "recent1")],
    })
    expect(view.mode).toBe("shortlist")
    expect(view.groups.map((g) => g.kind + (g.role ? `:${g.role}` : ""))).toEqual([
      "favorites",
      "recommended:default",
      "recommended:fast",
      "recent",
    ])
    expect(ids(view.items)).toEqual(["a/fav1", "b/rec-default", "a/rec-fast", "b/recent1"])
    // everything else is behind search
    expect(view.rest).toBe(1)
  })

  test("favorites keep their stored order", () => {
    const view = buildModelShortlist({ ...base, shown, favorites: [ref("b", "recent1"), ref("a", "fav1")] })
    expect(ids(view.items)).toEqual(["b/recent1", "a/fav1"])
  })

  test("dedupe: a model appears once, at its first (highest) section", () => {
    const view = buildModelShortlist({
      ...base,
      shown,
      config: {
        recommended: [...config.recommended, { ref: ref("a", "fav1"), role: "strong" }, { ref: ref("a", "rec-fast"), role: "strong" }],
        allowlist: undefined,
      },
      favorites: [ref("a", "fav1"), ref("a", "fav1")],
      recents: [ref("a", "fav1"), ref("b", "rec-default"), ref("b", "recent1")],
    })
    expect(ids(view.items)).toEqual(["a/fav1", "b/rec-default", "a/rec-fast", "b/recent1"])
    expect(view.groups.find((g) => g.role === "strong")).toBeUndefined()
  })

  test("refs to models not in the list (disconnected / hidden by visibility) are skipped", () => {
    const view = buildModelShortlist({ ...base, shown, favorites: [ref("zz", "gone")], recents: [ref("a", "nope")] })
    expect(view.items).toEqual([])
  })

  test(`capped at ${SHORTLIST_CAP} entries across sections, in section order`, () => {
    expect(SHORTLIST_CAP).toBe(12)
    const all = many(30)
    const view = buildModelShortlist({
      ...base,
      shown: all,
      favorites: all.slice(0, 8).map(keyOf),
      config: { recommended: all.slice(8, 14).map((x) => ({ ref: keyOf(x), role: "default" as const })), allowlist: undefined },
      recents: all.slice(14, 19).map(keyOf),
    })
    expect(view.items.length).toBe(12)
    expect(ids(view.items)).toEqual(ids(all.slice(0, 12)))
    expect(view.groups.map((g) => g.kind)).toEqual(["favorites", "recommended"])
    expect(view.rest).toBe(30 - 12)
  })

  test("no favorites, no recommended, no recents → mode all: every shown model (nothing invented)", () => {
    const view = buildModelShortlist({ ...base, shown })
    expect(view.mode).toBe("all")
    expect(ids(view.items)).toEqual(ids(shown))
    expect(view.groups.map((g) => g.kind)).toEqual(["other"])
    expect(view.rest).toBe(0)
  })

  test("hidden (unreachable) favorites stay out unless show-unavailable is on", () => {
    const dead = item("a", "dead-fav")
    const off = buildModelShortlist({ ...base, shown, hidden: [dead], favorites: [keyOf(dead)] })
    expect(ids(off.items)).not.toContain("a/dead-fav")
    const on = buildModelShortlist({ ...base, shown, hidden: [dead], favorites: [keyOf(dead)], showUnavailable: true })
    expect(ids(on.items)).toEqual(["a/dead-fav"])
  })

  test("the allowlist hard-filters favorites, recommended and recents", () => {
    const view = buildModelShortlist({
      ...base,
      shown,
      config: { ...config, allowlist: ["b/*"] },
      favorites: [ref("a", "fav1")],
      recents: [ref("b", "recent1")],
    })
    expect(ids(view.items)).toEqual(["b/rec-default", "b/recent1"])
    expect(view.rest).toBe(0)
  })
})

describe("buildModelShortlist — search", () => {
  test("search reaches everything shown, beyond the cap, grouped by role with Other last", () => {
    const all = [...many(20), item("q", "rec")]
    const config: ShortlistConfig = { recommended: [{ ref: ref("q", "rec"), role: "strong" }], allowlist: undefined }
    const view = buildModelShortlist({
      ...base,
      shown: all,
      favorites: all.slice(0, 12).map(keyOf),
      config,
      query: "m1",
    })
    expect(view.mode).toBe("search")
    // m1, m10..m19 — including the ones past the 12 cap
    expect(ids(view.items)).toEqual(["p/m1", ...Array.from({ length: 10 }, (_, i) => `p/m1${i}`)])
    expect(view.groups.map((g) => g.kind)).toEqual(["other"])

    const all2 = buildModelShortlist({ ...base, shown: all, config, query: "rec" })
    expect(all2.groups.map((g) => `${g.kind}:${g.role ?? ""}`)).toEqual(["recommended:strong"])
  })

  test("search results group by role: default, fast, strong, open-weight, then Other", () => {
    const shown = [item("p", "x-other"), item("p", "x-ow"), item("p", "x-strong"), item("p", "x-default")]
    const view = buildModelShortlist({
      ...base,
      shown,
      config: {
        recommended: [
          { ref: ref("p", "x-ow"), role: "open-weight" },
          { ref: ref("p", "x-strong"), role: "strong" },
          { ref: ref("p", "x-default"), role: "default" },
        ],
        allowlist: undefined,
      },
      query: "x",
    })
    expect(view.groups.map((g) => g.role ?? g.kind)).toEqual(["default", "strong", "open-weight", "other"])
    expect(ids(view.items)).toEqual(["p/x-default", "p/x-strong", "p/x-ow", "p/x-other"])
  })

  test("hidden models are searchable only with show-unavailable on", () => {
    const shown = [item("p", "alive")]
    const hidden = [item("p", "alive-but-dead")]
    const off = buildModelShortlist({ ...base, shown, hidden, query: "alive" })
    expect(ids(off.items)).toEqual(["p/alive"])
    const on = buildModelShortlist({ ...base, shown, hidden, query: "alive", showUnavailable: true })
    expect(ids(on.items)).toEqual(["p/alive", "p/alive-but-dead"])
  })

  test("the allowlist hard-filters search too", () => {
    const shown = [item("a", "same"), item("b", "same")]
    const view = buildModelShortlist({ ...base, shown, config: { recommended: [], allowlist: ["b/same"] }, query: "same" })
    expect(ids(view.items)).toEqual(["b/same"])
  })

  test("whitespace-only query is the default view", () => {
    const shown = [item("a", "x")]
    const view = buildModelShortlist({ ...base, shown, favorites: [ref("a", "x")], query: "   " })
    expect(view.mode).toBe("shortlist")
  })
})
