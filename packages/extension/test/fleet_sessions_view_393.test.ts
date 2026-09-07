// Issue amicissimo#393 — Slice C (spec spec-20260905-193000-local-shell-data-plane,
// rev 2): the native MERGED sessions view ships. The view renders the
// /amicode/fleet/sessions merged projection (D2 — both stores, provenance-tagged
// per store), honors the live posture from /amicode/fleet/status (D6 — degraded
// and the hub-down pointer surfaced honestly, never a silent fallback look), and
// rides D2's currency-over-what-is-fetched semantics (refetch-before-first-render
// on every posture transition, keyed on the refetch epoch).
//
// The view-model is pure and solid-free so it unit-tests headless; the Solid
// component (fleet-sessions-view.tsx) is its thin consumer, and the home
// flyout renders it around the base list verbatim.
//
// Entitlement honesty (the H3 discipline at the view layer): without the
// amicissimo entitlement the staged status route answers the base no-route 404 —
// the view-model's exists=false — and the view renders NOTHING: the base
// sessions list is byte-identical to base.
import { describe, expect, test } from "vitest"
import {
  currencyTokensCompatible,
  fleetProjectionView,
  fleetSessionsListState,
  fleetStatusView,
} from "../../app-bundle/overlay/packages/app/src/pages/home/fleet-sessions"

const status = (posture: Record<string, unknown> | undefined, mode = "fleet") => ({
  ok: true,
  mode,
  ...(posture === undefined ? {} : { posture }),
})

const posture = (state: string, refetch_epoch: number, extra: Record<string, unknown> = {}) => ({
  state,
  pointer: state === "standalone" ? "hub-down: the hub is unreachable" : null,
  refetch_epoch,
  parity: { version: "v1", previous_version: null, changed: false },
  ...extra,
})

const projection = (sessions: unknown[], opts: Record<string, unknown> = {}) => ({
  ok: true,
  mode: "fleet",
  sessions,
  sources: {
    local: { source: "local", present: true, count: 1, max: 200, sum: 200, version: "v1" },
    hub: { source: "hub", present: true, count: 1, max: 300, sum: 300, version: "hub-v1" },
    ...((opts.sources as unknown) ?? {}),
  },
  currency: { token: "cur-a", sources: ["hub", "local"], derived_over: "fetched", ...opts.currency },
})

const hubSession = (id: string, updated: number) => ({
  id,
  directory: "/home/aaron/AmicodeProjects/p1",
  title: `Hub ${id}`,
  time: { created: updated, updated },
  amicode_provenance: "hub",
})

const localSession = (id: string, updated: number) => ({
  id,
  directory: "/home/aaron/AmicodeProjects/p2",
  title: `Local ${id}`,
  time: { created: updated, updated },
  amicode_provenance: "local",
})

describe("fleetStatusView (the staged surfaces' honesty surface)", () => {
  test("H3 at the view layer: a 404'd probe (undefined raw) means the view does not exist", () => {
    const view = fleetStatusView(undefined)
    expect(view.exists).toBe(false)
    expect(view.mode).toBeNull()
    expect(view.posture).toBeNull()
  })

  test("malformed bodies never light the view (exists stays false)", () => {
    for (const raw of [null, "nope", 42, {}, { ok: false }, { ok: true }]) {
      expect(fleetStatusView(raw).exists).toBe(false)
    }
  })

  test("a staged plane without the Slice B detector still lights the view (posture null)", () => {
    const view = fleetStatusView(status(undefined))
    expect(view.exists).toBe(true)
    expect(view.mode).toBe("fleet")
    expect(view.posture).toBeNull()
  })

  test("the posture snapshot parses with its epoch and pointer verbatim", () => {
    const view = fleetStatusView(status(posture("degraded", 3)))
    expect(view.posture).not.toBeNull()
    expect(view.posture?.state).toBe("degraded")
    expect(view.posture?.refetchEpoch).toBe(3)
    expect(view.posture?.pointer).toBeNull()
  })

  test("the hub-down pointer surfaces verbatim (the service owns its wording)", () => {
    const view = fleetStatusView(status(posture("standalone", 7)))
    expect(view.posture?.state).toBe("standalone")
    expect(view.posture?.pointer).toBe("hub-down: the hub is unreachable")
  })

  test("an unknown posture state never masquerades as fleet (honest parse)", () => {
    const view = fleetStatusView(status({ state: "warp", refetch_epoch: 1 }))
    expect(view.exists).toBe(true)
    expect(view.posture).toBeNull()
  })
})

describe("fleetProjectionView (the D2 merged projection, parsed defensively)", () => {
  test("rows carry their provenance tag, in projection order (hub first, then local)", () => {
    const view = fleetProjectionView(projection([hubSession("h1", 300), localSession("l1", 200)]))
    expect(view.ok).toBe(true)
    expect(view.rows.map((r) => [r.id, r.provenance])).toEqual([
      ["h1", "hub"],
      ["l1", "local"],
    ])
  })

  test("title falls back to the id; updated is read defensively", () => {
    const view = fleetProjectionView(
      projection([{ id: "x", directory: "/d", time: { created: 1, updated: 2 }, amicode_provenance: "hub" }]),
    )
    expect(view.rows[0].title).toBe("x")
    expect(view.rows[0].updated).toBe(2)
  })

  test("a row without a provenance tag is NEVER guessed — it renders untagged or not at all, never mislabeled", () => {
    const view = fleetProjectionView(projection([{ id: "m1", directory: "/d", title: "M", time: { created: 1 } }]))
    expect(view.ok).toBe(true)
    expect(view.rows[0].provenance).toBeNull()
  })

  test("a malformed projection is ok=false with zero rows (never a partial lie)", () => {
    for (const raw of [undefined, null, "nope", { ok: false }, { ok: true, sessions: "nope" }]) {
      const view = fleetProjectionView(raw)
      expect(view.ok).toBe(false)
      expect(view.rows).toEqual([])
    }
  })

  test("named source absences parse through (a source that did not fetch contributes nothing)", () => {
    const view = fleetProjectionView(
      projection([localSession("l1", 200)], {
        sources: {
          local: { source: "local", present: true, count: 1, max: 200, sum: 200, version: "v1" },
          hub: { source: "hub", present: false, reason: "no-upstream" },
        },
      }),
    )
    expect(view.sources.hub.present).toBe(false)
    expect(view.sources.hub.reason).toBe("no-upstream")
    expect(view.currency?.sources).toEqual(["hub", "local"])
  })
})

describe("fleetSessionsListState (the honest presentation state machine)", () => {
  const S = (p: Record<string, unknown> | undefined) => fleetStatusView(status(p))
  const P = () => fleetProjectionView(projection([hubSession("h1", 300), localSession("l1", 200)]))

  test("probe pending → base list renders untouched (byte-identical until the probe answers)", () => {
    expect(fleetSessionsListState({ status: undefined, projection: undefined, renderedEpoch: undefined }).state).toBe(
      "base",
    )
  })

  test("no entitlement (exists=false) → absent: the view renders nothing, base is byte-identical", () => {
    const out = fleetSessionsListState({
      status: fleetStatusView(undefined),
      projection: undefined,
      renderedEpoch: undefined,
    })
    expect(out.state).toBe("absent")
    expect(out.pointer).toBeNull()
  })

  test("hub-down (standalone posture) → the honest pointer surfaces and the BASE list keeps running", () => {
    const out = fleetSessionsListState({ status: S(posture("standalone", 2)), projection: P(), renderedEpoch: 2 })
    expect(out.state).toBe("standalone-pointer")
    expect(out.pointer).toBe("hub-down: the hub is unreachable")
  })

  test("fleet + fetched projection + matching epoch → merged rows render", () => {
    const out = fleetSessionsListState({ status: S(posture("fleet", 1)), projection: P(), renderedEpoch: 1 })
    expect(out.state).toBe("merged")
  })

  test("degraded posture → rows still render but the degraded state is surfaced, never silent", () => {
    const out = fleetSessionsListState({ status: S(posture("degraded", 1)), projection: P(), renderedEpoch: 1 })
    expect(out.state).toBe("degraded")
  })

  test("D2 refetch-before-first-render: a posture transition (epoch bump) makes the rendered rows STALE", () => {
    const out = fleetSessionsListState({ status: S(posture("fleet", 2)), projection: P(), renderedEpoch: 1 })
    expect(out.state).toBe("stale")
  })

  test("a refetch_epoch of 0 still gates (epoch is a number, not truthiness)", () => {
    const out = fleetSessionsListState({ status: S(posture("fleet", 0)), projection: P(), renderedEpoch: 0 })
    expect(out.state).toBe("merged")
    expect(fleetSessionsListState({ status: S(posture("fleet", 1)), projection: P(), renderedEpoch: 0 }).state).toBe(
      "stale",
    )
  })

  test("fleet posture before the projection's first fetch → loading, never an empty list implying none", () => {
    const out = fleetSessionsListState({ status: S(posture("fleet", 1)), projection: undefined, renderedEpoch: undefined })
    expect(out.state).toBe("loading")
  })

  test("a Slice A-only plane (posture null) renders the merged list once fetched", () => {
    const out = fleetSessionsListState({ status: S(undefined), projection: P(), renderedEpoch: undefined })
    expect(out.state).toBe("merged")
    expect(fleetSessionsListState({ status: S(undefined), projection: undefined, renderedEpoch: undefined }).state).toBe(
      "loading",
    )
  })
})

describe("currency honesty (D2: a token derived over one upstream is never compared against another)", () => {
  test("tokens over DIFFERENT source sets are never compatible — even with identical token strings", () => {
    expect(
      currencyTokensCompatible({ token: "cur-a", sources: ["local"] }, { token: "cur-a", sources: ["local", "hub"] }),
    ).toBe(false)
  })

  test("same sources + same token → compatible (a no-change refetch keeps the list stable)", () => {
    expect(
      currencyTokensCompatible({ token: "cur-a", sources: ["hub", "local"] }, { token: "cur-a", sources: ["hub", "local"] }),
    ).toBe(true)
  })

  test("same sources + different token → not compatible (the data moved)", () => {
    expect(
      currencyTokensCompatible({ token: "cur-a", sources: ["hub", "local"] }, { token: "cur-b", sources: ["hub", "local"] }),
    ).toBe(false)
  })

  test("a null currency never compares (the projection did not carry one)", () => {
    expect(currencyTokensCompatible(null, { token: "cur-a", sources: ["hub"] })).toBe(false)
    expect(currencyTokensCompatible(null, null)).toBe(false)
  })
})
