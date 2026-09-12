import { describe, expect, test } from "bun:test"
import {
  applyConnectionOverlay,
  cardModel,
  connectionFormKind,
  connectionTitle,
  driftCopy,
  fillLabelTemplate,
  offlineCopy,
  parseConnectionActionResponse,
  parseConnectionsResponse,
  pasqalSubmitPayload,
  stateCopy,
  submitPayload,
  validatedAtDisplay,
  type ConnectionCardState,
  type ConnectionStateLabels,
  type ConnectionsView,
  type ConnectionView,
} from "./connections"

// Wire fixtures mirror the #165 status contract (packages/opencode
// src/server/amicode/connections.ts): GET → {ok, connections:[…]},
// POST → {ok, connection, error}.
const connectedEntry = {
  id: "company-compute",
  state: "connected",
  identity: "kate@harmoniqs.co",
  entitlements: ["solve"],
  expires_at: "2026-12-31T00:00:00.000Z",
  devices: [{ id: "d1", name: "fresnel", state: "online" }],
  validated_at: "2026-07-19T10:00:00.000Z",
  stale: false,
}

describe("validatedAtDisplay", () => {
  test("renders a parseable ISO timestamp as a locale string", () => {
    const display = validatedAtDisplay("2026-07-19T10:00:00.000Z")
    expect(display).not.toBe("—")
    expect(display).toContain("2026")
  })
  test("maps absent, non-string, empty, and unparseable values to an em dash", () => {
    expect(validatedAtDisplay(undefined)).toBe("—")
    expect(validatedAtDisplay(null)).toBe("—")
    expect(validatedAtDisplay(42)).toBe("—")
    expect(validatedAtDisplay("")).toBe("—")
    expect(validatedAtDisplay("not-a-date")).toBe("—")
  })
})

describe("parseConnectionsResponse", () => {
  test("happy path: a connected entry passes through with renamed fields", () => {
    const view = parseConnectionsResponse({ ok: true, connections: [connectedEntry], error: null })
    expect(view.ok).toBe(true)
    expect(view.connections).toHaveLength(1)
    const conn = view.connections[0]
    expect(conn.id).toBe("company-compute")
    expect(conn.state).toBe("connected")
    expect(conn.rawState).toBe("connected")
    expect(conn.identity).toBe("kate@harmoniqs.co")
    expect(conn.validatedAt).toContain("2026")
    expect(conn.stale).toBe(false)
  })

  test("each contract state survives the parse — incl. expired + unentitled (169)", () => {
    for (const state of ["connected", "needs-key", "invalid", "expired", "unreachable", "unentitled", "validating"]) {
      const view = parseConnectionsResponse({
        ok: true,
        connections: [{ id: "company-compute", state, validated_at: null, stale: false }],
        error: null,
      })
      expect(view.ok).toBe(true)
      expect(view.connections[0].state).toBe(state as never)
    }
  })

  test("unknown states collapse to the safe fallback, raw word preserved (AC4)", () => {
    for (const state of ["some-future-state", "revoked"]) {
      const view = parseConnectionsResponse({
        ok: true,
        connections: [{ id: "company-compute", state, validated_at: null, stale: false }],
        error: null,
      })
      expect(view.ok).toBe(true)
      expect(view.connections[0].state).toBe("unknown")
      expect(view.connections[0].rawState).toBe(state)
    }
  })

  test("devices parse to display names — objects prefer name, fall back to id; junk is dropped (169 AC2)", () => {
    const view = parseConnectionsResponse({
      ok: true,
      connections: [
        {
          id: "pasqal-cloud",
          state: "connected",
          stale: false,
          devices: [{ name: "EMU_FREE" }, { id: "d9", state: "online" }, {}, null, 42, { name: "" }],
        },
      ],
      error: null,
    })
    expect(view.connections[0].devices).toEqual(["EMU_FREE", "d9"])
  })

  test("absent or empty devices leave the field undefined", () => {
    for (const devices of [undefined, [], "three", [null, {}]]) {
      const view = parseConnectionsResponse({
        ok: true,
        connections: [{ id: "pasqal-cloud", state: "connected", stale: false, devices }],
        error: null,
      })
      expect(view.connections[0].devices).toBeUndefined()
    }
  })

  test("identity_drift parses to identityDrift; junk shapes leave it undefined (170 AC4)", () => {
    const drifted = parseConnectionsResponse({
      ok: true,
      connections: [
        {
          id: "company-compute",
          state: "connected",
          identity: "team-alpha",
          identity_drift: "team-beta",
          stale: false,
        },
      ],
      error: null,
    })
    expect(drifted.connections[0].identity).toBe("team-alpha")
    expect(drifted.connections[0].identityDrift).toBe("team-beta")
    for (const identity_drift of [undefined, "", 42, { nested: "x" }, ["y"]]) {
      const view = parseConnectionsResponse({
        ok: true,
        connections: [{ id: "company-compute", state: "connected", identity_drift, stale: false }],
        error: null,
      })
      expect(view.connections[0].identityDrift).toBeUndefined()
    }
  })

  test("offline:true parses to the offline marker; anything else leaves it undefined (170 AC3)", () => {
    const marked = parseConnectionsResponse({
      ok: true,
      connections: [{ id: "company-compute", state: "connected", stale: true, offline: true }],
      error: null,
    })
    expect(marked.connections[0].offline).toBe(true)
    for (const offline of [undefined, false, "yes", 1, null]) {
      const view = parseConnectionsResponse({
        ok: true,
        connections: [{ id: "company-compute", state: "connected", stale: true, offline }],
        error: null,
      })
      expect(view.connections[0].offline).toBeUndefined()
    }
  })

  test("session_only:true parses to the sessionOnly marker; anything else leaves it undefined (169 AC4)", () => {
    const marked = parseConnectionsResponse({
      ok: true,
      connections: [{ id: "pasqal-cloud", state: "connected", stale: false, session_only: true }],
      error: null,
    })
    expect(marked.connections[0].sessionOnly).toBe(true)
    for (const session_only of [undefined, false, "yes", 1]) {
      const view = parseConnectionsResponse({
        ok: true,
        connections: [{ id: "pasqal-cloud", state: "connected", stale: false, session_only }],
        error: null,
      })
      expect(view.connections[0].sessionOnly).toBeUndefined()
    }
  })

  test("ok:false carries the server error string", () => {
    const view = parseConnectionsResponse({ ok: false, connections: [], error: "bad_output: boom" })
    expect(view.ok).toBe(false)
    expect(view.error).toBe("bad_output: boom")
  })

  test("ok:false with no usable error still produces a message", () => {
    const view = parseConnectionsResponse({ ok: false, connections: [], error: null })
    expect(view.ok).toBe(false)
    expect(view.error).toBeTruthy()
  })

  test("non-object responses are bad_shape, never a throw", () => {
    for (const raw of [null, undefined, 42, "nope", []]) {
      const view = parseConnectionsResponse(raw)
      expect(view.ok).toBe(false)
      expect(view.error).toContain("bad_shape")
    }
  })

  test("connections absent or non-array is bad_shape", () => {
    const missing = parseConnectionsResponse({ ok: true, error: null })
    expect(missing.ok).toBe(false)
    expect(missing.error).toContain("bad_shape")
    const nonArray = parseConnectionsResponse({ ok: true, connections: "three", error: null })
    expect(nonArray.ok).toBe(false)
  })

  test("tolerant entries: missing/mistyped fields never throw (AC4)", () => {
    const view = parseConnectionsResponse({
      ok: true,
      connections: [
        {},
        null,
        { id: "company-compute", state: 7, identity: 3, validated_at: 12, stale: "yes" },
        { id: "", state: "connected", base_url: 9 },
      ],
      error: null,
    })
    expect(view.ok).toBe(true)
    expect(view.connections).toHaveLength(4)
    expect(view.connections[0]).toEqual({
      id: "(unknown)",
      state: "unknown",
      rawState: "unknown",
      identity: undefined,
      baseUrl: undefined,
      validatedAt: "—",
      stale: false,
    })
    expect(view.connections[2].state).toBe("unknown")
    expect(view.connections[2].stale).toBe(false)
    expect(view.connections[3].id).toBe("(unknown)")
    expect(view.connections[3].baseUrl).toBeUndefined()
  })

  test("unknown fields are dropped — a poisoned entry can never carry a secret into the view", () => {
    const view = parseConnectionsResponse({
      ok: true,
      connections: [{ ...connectedEntry, token: "sk-poison", password: "hunter2", junk: { nested: "sk-deep" } }],
      error: null,
    })
    const serialized = JSON.stringify(view)
    expect(serialized).not.toContain("sk-poison")
    expect(serialized).not.toContain("hunter2")
    expect(serialized).not.toContain("sk-deep")
  })

  test("base_url prefill survives when the server offers one (forward-compatible)", () => {
    const view = parseConnectionsResponse({
      ok: true,
      connections: [{ id: "company-compute", state: "needs-key", base_url: "https://solve.example", stale: false }],
      error: null,
    })
    expect(view.connections[0].baseUrl).toBe("https://solve.example")
  })
})

describe("parseConnectionActionResponse", () => {
  test("happy path: the terminal connection rides the same response (AC2 wire shape)", () => {
    const view = parseConnectionActionResponse({ ok: true, connection: connectedEntry, error: null })
    expect(view.ok).toBe(true)
    expect(view.connection?.state).toBe("connected")
    expect(view.connection?.identity).toBe("kate@harmoniqs.co")
  })

  test("ok:false carries the server error; missing error still produces a message", () => {
    const failed = parseConnectionActionResponse({ ok: false, connection: null, error: "invalid_key: rejected" })
    expect(failed.ok).toBe(false)
    expect(failed.error).toBe("invalid_key: rejected")
    const silent = parseConnectionActionResponse({ ok: false, connection: null, error: null })
    expect(silent.ok).toBe(false)
    expect(silent.error).toBeTruthy()
  })

  test("non-object responses and a missing connection are bad_shape, never a throw", () => {
    for (const raw of [null, undefined, 42, "nope", []]) {
      const view = parseConnectionActionResponse(raw)
      expect(view.ok).toBe(false)
      expect(view.error).toContain("bad_shape")
    }
    const missing = parseConnectionActionResponse({ ok: true, connection: null, error: null })
    expect(missing.ok).toBe(false)
    expect(missing.error).toContain("bad_shape")
  })

  test("the submitted token has no path into the parsed view", () => {
    const view = parseConnectionActionResponse({
      ok: true,
      connection: { ...connectedEntry, token: "sk-echoed" },
      error: null,
    })
    expect(JSON.stringify(view)).not.toContain("sk-echoed")
  })
})

// --- AC1: the state→props mapping the card renders from. With no tsx
// component harness in this repo (see connections-tab.tsx), this mapping IS
// the component contract, so it gets exhaustive coverage here.

const CARD_STATES: ConnectionCardState[] = [
  "connected",
  "needs-key",
  "invalid",
  "expired",
  "unreachable",
  "unentitled",
  "validating",
  "waiting-browser",
  "waiting-code",
  "choose-project",
  "unknown",
]

const labels: ConnectionStateLabels = {
  connected: "Connected",
  "needs-key": "Not connected — enter a key",
  invalid: "Key rejected",
  expired: "Token expired — reconnect to refresh it",
  unreachable: "Service unreachable",
  unentitled: "Project not authorized — check the project ID",
  validating: "Validating key…",
  "waiting-browser": "Waiting for your browser — finish signing in there",
  "waiting-code": "Waiting for the code — enter it on any device",
  "choose-project": "Signed in — pick the project runs should bill to",
  unknown: "Status needs attention",
}

function viewFor(state: ConnectionCardState, extra: Partial<ConnectionView> = {}): ConnectionView {
  return {
    id: "company-compute",
    state,
    rawState: state === "unknown" ? "expired" : state,
    validatedAt: "—",
    stale: false,
    ...extra,
  }
}

describe("stateCopy", () => {
  test("every card state picks its own distinct copy (AC1)", () => {
    const seen = new Set(CARD_STATES.map((state) => stateCopy(viewFor(state), labels)))
    expect(seen.size).toBe(CARD_STATES.length)
    for (const state of CARD_STATES) {
      expect(stateCopy(viewFor(state), labels)).toBe(labels[state])
    }
  })
})

describe("cardModel", () => {
  test("connected: actions + validated_at, no key form", () => {
    const model = cardModel(viewFor("connected", { validatedAt: "7/19/2026", identity: "kate@harmoniqs.co" }))
    expect(model.showForm).toBe(false)
    expect(model.showActions).toBe(true)
    expect(model.showValidatedAt).toBe(true)
    expect(model.showIdentity).toBe(true)
    expect(model.tone).toBe("success")
  })

  test("connected without identity hides the identity line; stale surfaces the hint", () => {
    const bare = cardModel(viewFor("connected"))
    expect(bare.showIdentity).toBe(false)
    expect(bare.showStale).toBe(false)
    const stale = cardModel(viewFor("connected", { stale: true }))
    expect(stale.showStale).toBe(true)
  })

  test("needs-key / invalid / expired / unreachable / unentitled: credential form enabled, no actions", () => {
    for (const [state, tone] of [
      ["needs-key", "neutral"],
      ["invalid", "critical"],
      ["expired", "warning"],
      ["unreachable", "warning"],
      ["unentitled", "critical"],
    ] as const) {
      const model = cardModel(viewFor(state))
      expect(model.showForm).toBe(true)
      expect(model.formDisabled).toBe(false)
      expect(model.showActions).toBe(false)
      expect(model.showValidatedAt).toBe(false)
      expect(model.tone).toBe(tone)
    }
  })

  test("session-only connected surfaces the note; a durable connect does not (169 AC4)", () => {
    expect(cardModel(viewFor("connected", { sessionOnly: true })).showSessionOnly).toBe(true)
    expect(cardModel(viewFor("connected")).showSessionOnly).toBe(false)
    expect(cardModel(viewFor("invalid", { sessionOnly: true })).showSessionOnly).toBe(false)
  })

  test("offline connected surfaces the last-verified line — and ONLY on connected (170 AC3)", () => {
    expect(cardModel(viewFor("connected", { offline: true, stale: true })).showOffline).toBe(true)
    expect(cardModel(viewFor("connected")).showOffline).toBe(false)
    for (const state of ["needs-key", "invalid", "expired", "unreachable", "unknown"] as const) {
      expect(cardModel(viewFor(state, { offline: true })).showOffline).toBe(false)
    }
  })

  test("a drifted identity surfaces the diff on a connected card — never without a drift (170 AC4)", () => {
    const drifted = cardModel(viewFor("connected", { identity: "team-alpha", identityDrift: "team-beta" }))
    expect(drifted.showDrift).toBe(true)
    expect(drifted.showIdentity).toBe(true) // the record still renders beside the diff
    expect(cardModel(viewFor("connected", { identity: "team-alpha" })).showDrift).toBe(false)
    for (const state of ["needs-key", "invalid", "expired", "validating"] as const) {
      expect(cardModel(viewFor(state, { identityDrift: "team-beta" })).showDrift).toBe(false)
    }
  })

  test("validating: a loading spinner, not a frozen form — the in-flight render (#194)", () => {
    const model = cardModel(viewFor("validating"))
    expect(model.showLoading).toBe(true)
    expect(model.showForm).toBe(false)
    expect(model.showActions).toBe(false)
    expect(model.showProjectPicker).toBe(false)
    expect(model.tone).toBe("pending")
  })

  test("unknown: safe fallback keeps every exit open and shows the raw wire word (AC4)", () => {
    const model = cardModel(viewFor("unknown"))
    expect(model.showForm).toBe(true)
    expect(model.formDisabled).toBe(false)
    expect(model.showActions).toBe(true)
    expect(model.showRawState).toBe(true)
    expect(model.tone).toBe("neutral")
  })

  test("only unknown renders the raw state word", () => {
    for (const state of CARD_STATES.filter((s) => s !== "unknown")) {
      expect(cardModel(viewFor(state)).showRawState).toBe(false)
    }
  })
})

// --- 170 AC3/AC4: label templates whose values (identities, timestamps) only
// exist at render time. The app hands the raw {{slot}} template through; the
// card fills it with display values — never secrets, never wire-raw objects.

describe("fillLabelTemplate", () => {
  test("fills named slots; unknown slots stay verbatim (forward-compatible copy)", () => {
    expect(fillLabelTemplate("last verified {{at}} as {{identity}}", { at: "7/19/2026", identity: "team-alpha" })).toBe(
      "last verified 7/19/2026 as team-alpha",
    )
    expect(fillLabelTemplate("no slots here", {})).toBe("no slots here")
    expect(fillLabelTemplate("keep {{future}} intact", { at: "x" })).toBe("keep {{future}} intact")
  })
})

describe("offlineCopy (170 AC3)", () => {
  test("renders the last-verified line from the view's display values", () => {
    const view = viewFor("connected", {
      offline: true,
      stale: true,
      validatedAt: "7/19/2026, 10:00",
      identity: "team-alpha",
    })
    expect(offlineCopy(view, "Offline — last verified {{at}} as {{identity}}")).toBe(
      "Offline — last verified 7/19/2026, 10:00 as team-alpha",
    )
  })

  test("a view without an identity renders an em dash, never a hole", () => {
    const view = viewFor("connected", { offline: true, stale: true, validatedAt: "7/19/2026, 10:00" })
    expect(offlineCopy(view, "Offline — last verified {{at}} as {{identity}}")).toBe(
      "Offline — last verified 7/19/2026, 10:00 as —",
    )
  })
})

describe("driftCopy (170 AC4)", () => {
  test("renders the explicit diff — answered as X, was Y", () => {
    const view = viewFor("connected", { identity: "team-alpha", identityDrift: "team-beta" })
    expect(
      driftCopy(view, "This key answered as {{answered}}, was {{stored}} — historical runs may stop authorizing"),
    ).toBe("This key answered as team-beta, was team-alpha — historical runs may stop authorizing")
  })

  test("holes render em dashes rather than template residue", () => {
    const view = viewFor("connected", { identityDrift: "team-beta" })
    expect(driftCopy(view, "answered as {{answered}}, was {{stored}}")).toBe("answered as team-beta, was —")
  })
})

describe("connectionTitle", () => {
  test("known products get names; unknown ids render verbatim", () => {
    expect(connectionTitle("company-compute")).toBe("Harmoniqs Cloud")
    expect(connectionTitle("pasqal-cloud")).toBe("Pasqal Cloud")
    expect(connectionTitle("(unknown)")).toBe("(unknown)")
  })
})

describe("connectionFormKind", () => {
  test("pasqal-cloud takes the credentials form; everything else keeps base_url + token", () => {
    expect(connectionFormKind("pasqal-cloud")).toBe("pasqal-credentials")
    expect(connectionFormKind("company-compute")).toBe("base-url-token")
    expect(connectionFormKind("some-future-id")).toBe("base-url-token")
  })
})

// --- AC3: the submit gate. An empty submission produces NO payload — the
// component fires no request and touches no state when this returns undefined.

describe("submitPayload", () => {
  test("empty or whitespace-only fields yield no payload at all (AC3)", () => {
    expect(submitPayload("company-compute", "", "")).toBeUndefined()
    expect(submitPayload("company-compute", "https://solve.example", "")).toBeUndefined()
    expect(submitPayload("company-compute", "", "sk-key")).toBeUndefined()
    expect(submitPayload("company-compute", "   ", "sk-key")).toBeUndefined()
    expect(submitPayload("company-compute", "https://solve.example", "  \t ")).toBeUndefined()
  })

  test("both fields present yields the trimmed wire body", () => {
    expect(submitPayload("company-compute", "  https://solve.example  ", " sk-key ")).toEqual({
      id: "company-compute",
      base_url: "https://solve.example",
      token: "sk-key",
    })
  })
})

describe("pasqalSubmitPayload (#194 two-step: username+password only, no project_id)", () => {
  test("an empty or whitespace-only username or password yields no payload — no request fires", () => {
    expect(pasqalSubmitPayload("pasqal-cloud", "", "")).toBeUndefined()
    expect(pasqalSubmitPayload("pasqal-cloud", "kate@example.com", "")).toBeUndefined()
    expect(pasqalSubmitPayload("pasqal-cloud", "", "hunter2")).toBeUndefined()
    expect(pasqalSubmitPayload("pasqal-cloud", "kate@example.com", "  \t ")).toBeUndefined()
  })

  test("username trimmed, password VERBATIM, and NO project_id (the server lists projects)", () => {
    const payload = pasqalSubmitPayload("pasqal-cloud", "  kate@example.com ", " p4ss word ")
    expect(payload).toEqual({
      id: "pasqal-cloud",
      username: "kate@example.com",
      password: " p4ss word ", // passwords may legitimately carry spaces — never trimmed
    })
    expect(payload && "project_id" in payload).toBe(false)
  })
})

// --- AC2: the overlay the app layer applies around one round trip — the
// submit renders "validating" while the POST is in flight, then the terminal
// connection from the SAME response replaces it. No polling loop anywhere.

describe("applyConnectionOverlay", () => {
  const baseView: ConnectionsView = {
    ok: true,
    connections: [viewFor("needs-key")],
  }

  test("no overlay passes the base view through untouched", () => {
    expect(applyConnectionOverlay(baseView, {})).toBe(baseView)
    expect(applyConnectionOverlay(undefined, {})).toBeUndefined()
  })

  test("validating overlay flips the matching card to the in-flight state (AC2)", () => {
    const view = applyConnectionOverlay(baseView, { validating: "company-compute" })
    expect(view?.ok).toBe(true)
    expect(view?.connections[0].state).toBe("validating")
    expect(view?.connections[0].id).toBe("company-compute")
    // the base view is not mutated
    expect(baseView.connections[0].state).toBe("needs-key")
  })

  test("terminal overlay replaces the card with the connection from the same response (AC2)", () => {
    const terminal = viewFor("connected", { validatedAt: "7/19/2026", identity: "kate@harmoniqs.co" })
    const view = applyConnectionOverlay(baseView, { terminal })
    expect(view?.connections).toHaveLength(1)
    expect(view?.connections[0]).toEqual(terminal)
  })

  test("validating wins over a stale terminal while a new request is in flight", () => {
    const terminal = viewFor("connected")
    const view = applyConnectionOverlay(baseView, { terminal, validating: "company-compute" })
    expect(view?.connections[0].state).toBe("validating")
  })

  test("overlay still renders when the base GET is absent or failed", () => {
    const inflight = applyConnectionOverlay(undefined, { validating: "company-compute" })
    expect(inflight?.ok).toBe(true)
    expect(inflight?.connections[0].state).toBe("validating")
    const failed = applyConnectionOverlay(
      { ok: false, connections: [], error: "boom" },
      { terminal: viewFor("connected") },
    )
    expect(failed?.ok).toBe(true)
    expect(failed?.connections[0].state).toBe("connected")
  })

  test("an overlay for one id leaves sibling cards untouched (Pasqal-ready)", () => {
    const twoCards: ConnectionsView = {
      ok: true,
      connections: [viewFor("needs-key"), viewFor("connected", { id: "pasqal-cloud" })],
    }
    const view = applyConnectionOverlay(twoCards, { validating: "company-compute" })
    expect(view?.connections[1]).toEqual(twoCards.connections[1])
    expect(view?.connections[0].state).toBe("validating")
  })
})

// ── Harmoniqs Cloud is connectable in the Connections tab (reverses #200 AC5) ─
import { statusTabConnections, COMPANY_COMPUTE_ID as COMPUTE_ID } from "./connections"

describe("status-tab connection list", () => {
  const mk = (id: string) => ({ id, state: "connected" as const, rawState: "connected", validatedAt: "—", stale: false })

  // The regression this pins: #200 filtered company-compute out of this list, so
  // Pasqal Cloud was connectable here and OUR cloud was not — users looked where
  // Pasqal is, found nothing, and had nowhere to enter an API key.
  test("includes company-compute, in wire order alongside the others", () => {
    const list = [mk(COMPUTE_ID), mk("pasqal-cloud"), mk("future-target")]
    expect(statusTabConnections(list).map((c) => c.id)).toEqual([COMPUTE_ID, "pasqal-cloud", "future-target"])
  })

  test("a compute-only list still renders a card (the empty state must not swallow it)", () => {
    expect(statusTabConnections([mk(COMPUTE_ID)]).map((c) => c.id)).toEqual([COMPUTE_ID])
  })

  test("an empty list stays empty", () => {
    expect(statusTabConnections([])).toEqual([])
  })
})
