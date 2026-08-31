import { describe, expect, test } from "bun:test"
import { formModel, parseDashboardResponse, parseWidgetsResponse } from "./widget-schema"
import { allowAction, allowFetch } from "./widget-allowlist"

describe("parseWidgetsResponse", () => {
  test("maps the wire shape defensively", () => {
    const widgets = parseWidgetsResponse({
      ok: true,
      widgets: [
        {
          id: "pulse-bank",
          name: "Pulse bank",
          size: "tile",
          height: 96,
          bridge: 1,
          builtin: true,
          overridden: false,
          hash: "abc",
          path: null,
          config: { plot: { type: "select", options: ["a"], default: "a" }, junk: "no", bad: { type: "wat" } },
        },
        { id: 42 }, // dropped
      ],
    })
    expect(widgets).toHaveLength(1)
    expect(widgets[0].config.plot?.type).toBe("select")
    expect("junk" in widgets[0].config).toBe(false)
    expect("bad" in widgets[0].config).toBe(false)
  })
  test("garbage → empty", () => {
    expect(parseWidgetsResponse(undefined)).toEqual([])
    expect(parseWidgetsResponse({ ok: false })).toEqual([])
  })
})

describe("parseDashboardResponse", () => {
  test("parses entries, defaults key to id, keeps missing flag", () => {
    const d = parseDashboardResponse({
      ok: true,
      dashboard: {
        version: 1,
        widget: [
          { key: "w-1", id: "a", hidden: true, config: { x: 1 } },
          { id: "b", missing: true },
          { id: 42 },
        ],
      },
    })
    expect(d?.widget).toHaveLength(2)
    expect(d?.widget[0].hidden).toBe(true)
    expect(d?.widget[1].key).toBe("b")
    expect(d?.widget[1].missing).toBe(true)
  })
  test("garbage → undefined", () => {
    expect(parseDashboardResponse({ ok: true, dashboard: { widget: "x" } })).toBeUndefined()
    expect(parseDashboardResponse("nope")).toBeUndefined()
  })

  test("reserved keys pass through the client parse (spec T3.6)", () => {
    const d = parseDashboardResponse({
      ok: true,
      dashboard: {
        version: 1,
        views: [{ id: "lab", name: "Lab" }],
        scope: "home",
        widget: [{ key: "w-1", id: "a", hidden: false, config: {}, group: "lab" }],
      },
    }) as Record<string, unknown> & { widget: Record<string, unknown>[] }
    expect(d.views).toEqual([{ id: "lab", name: "Lab" }])
    expect(d.scope).toBe("home")
    expect(d.widget[0].group).toBe("lab")
  })
})

describe("formModel", () => {
  const schema = {
    stats: { type: "multi-select", options: ["a", "b"], default: ["a"] },
    plot: { type: "select", options: ["p", "o"], default: "p" },
    on: { type: "boolean", default: true },
  } as const
  test("valid stored values win; invalid fall back to defaults", () => {
    const fields = formModel(schema as any, { stats: ["b"], plot: "3d", on: "yes" })
    expect(fields.find((f) => f.key === "stats")?.value).toEqual(["b"])
    expect(fields.find((f) => f.key === "plot")?.value).toBe("p")
    expect(fields.find((f) => f.key === "on")?.value).toBe(true)
  })
  test("empty schema → no fields", () => {
    expect(formModel({}, { a: 1 })).toEqual([])
  })
})

describe("allowFetch", () => {
  test("exact routes and query variants pass", () => {
    expect(allowFetch("/amicode/profile")).toBe(true)
    expect(allowFetch("/amicode/run-series?run=r1&lab=default")).toBe(true)
    expect(allowFetch("/amicode/dashboard")).toBe(true)
  })
  test("campaign routes pass (list + drill-down with query)", () => {
    expect(allowFetch("/amicode/campaigns")).toBe(true)
    expect(allowFetch("/amicode/campaign?slug=session-20260830-skill-health")).toBe(true)
  })
  test("prefix rides and foreign paths rejected", () => {
    expect(allowFetch("/amicode/problem-x")).toBe(false)
    expect(allowFetch("/amicode/problemx?slug=s")).toBe(false)
    expect(allowFetch("/amicode/campaign-x")).toBe(false)
    expect(allowFetch("/amicode/campaignx?slug=s")).toBe(false)
    expect(allowFetch("/amicode/campaigns-extra")).toBe(false)
    expect(allowFetch("/session")).toBe(false)
    expect(allowFetch("http://evil.example/amicode/profile")).toBe(false)
    expect(allowFetch(42)).toBe(false)
  })
})

describe("allowAction", () => {
  test("the eight verbs pass, others rejected", () => {
    for (const v of [
      "resume-session",
      "save-profile",
      "lookup-institution",
      "resolve-logo",
      "open-external",
      "upload-library",
      "open-gallery",
      "warm-start",
    ])
      expect(allowAction(v)).toBe(true)
    expect(allowAction("rm-rf")).toBe(false)
    expect(allowAction(1)).toBe(false)
  })
})
