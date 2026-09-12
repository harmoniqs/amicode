import { describe, expect, test } from "bun:test"
import {
  cardModel,
  chooseProjectPayload,
  connectionAuthMethods,
  methodEntryKind,
  parseConnectionsResponse,
  pasqalTokenSubmitPayload,
  startAuthPayload,
  stateCopy,
  type ConnectionCardState,
  type ConnectionStateLabels,
  type ConnectionView,
} from "./connections"

// Auth-path scaffold (amicode#194): the wire MAY advertise auth_methods and
// emit three mid-flow states (waiting-browser / waiting-code / choose-project).
// Contract under test: (1) absent scaffold fields leave today's cards
// byte-identical — the mechanism decision stays open server-side; (2) every
// scaffold affordance is gated on what the wire actually advertised, so a
// stale UI can never start a flow the server no longer offers.

function parseOne(entry: Record<string, unknown>): ConnectionView {
  const view = parseConnectionsResponse({ ok: true, connections: [entry] })
  expect(view.ok).toBe(true)
  return view.connections[0]
}

const pasqalWaitingCode = {
  id: "pasqal-cloud",
  state: "waiting-code",
  auth_methods: ["browser", "device-code", "credentials"],
  user_code: "HRMQ-4321",
  verification_url: "https://pasqal.cloud/activate",
  code_expires_at: "2026-07-21T21:00:00.000Z",
}

describe("scaffold wire parsing", () => {
  test("auth_methods keeps known methods in wire order, drops unknowns and dupes", () => {
    const conn = parseOne({ id: "pasqal-cloud", state: "needs-key", auth_methods: ["browser", "quantum-telepathy", "token", "browser"] })
    expect(conn.authMethods).toEqual(["browser", "token"])
  })

  test("auth_methods off-shape or empty is absent, never a crash", () => {
    expect(parseOne({ id: "pasqal-cloud", state: "needs-key", auth_methods: "browser" }).authMethods).toBeUndefined()
    expect(parseOne({ id: "pasqal-cloud", state: "needs-key", auth_methods: [] }).authMethods).toBeUndefined()
    expect(parseOne({ id: "pasqal-cloud", state: "needs-key", auth_methods: [42, {}] }).authMethods).toBeUndefined()
  })

  test("device-code metadata parses; a garbage expiry is absent, not an Invalid Date", () => {
    const conn = parseOne(pasqalWaitingCode)
    expect(conn.state).toBe("waiting-code")
    expect(conn.userCode).toBe("HRMQ-4321")
    expect(conn.verificationUrl).toBe("https://pasqal.cloud/activate")
    expect(conn.codeExpiresAt).toContain("2026")
    expect(parseOne({ ...pasqalWaitingCode, code_expires_at: "not-a-time" }).codeExpiresAt).toBeUndefined()
  })

  test("projects keep {id, name} with name falling back to id; id-less entries drop", () => {
    const conn = parseOne({
      id: "pasqal-cloud",
      state: "choose-project",
      projects: [{ id: "p1", name: "MIS ladder" }, { id: "p2" }, { name: "orphan" }, "junk"],
    })
    expect(conn.projects).toEqual([
      { id: "p1", name: "MIS ladder" },
      { id: "p2", name: "p2" },
    ])
  })

  test("REGRESSION: an entry without scaffold fields parses exactly as before", () => {
    const conn = parseOne({ id: "pasqal-cloud", state: "needs-key", validated_at: "2026-07-19T10:00:00.000Z" })
    expect(conn.authMethods).toBeUndefined()
    expect(conn.userCode).toBeUndefined()
    expect(conn.verificationUrl).toBeUndefined()
    expect(conn.codeExpiresAt).toBeUndefined()
    expect(conn.projects).toBeUndefined()
    const model = cardModel(conn)
    expect(model.showWaiting).toBe(false)
    expect(model.showUserCode).toBe(false)
    expect(model.showProjectPicker).toBe(false)
    expect(model.showForm).toBe(true)
  })
})

describe("mid-flow card models", () => {
  test("waiting-browser: passive and cancellable — no form, no actions", () => {
    const model = cardModel(parseOne({ id: "pasqal-cloud", state: "waiting-browser" }))
    expect(model.tone).toBe("pending")
    expect(model.showForm).toBe(false)
    expect(model.showActions).toBe(false)
    expect(model.showWaiting).toBe(true)
    expect(model.showUserCode).toBe(false)
  })

  test("waiting-code shows the code block only when the wire sent a code", () => {
    expect(cardModel(parseOne(pasqalWaitingCode)).showUserCode).toBe(true)
    const codeless = cardModel(parseOne({ id: "pasqal-cloud", state: "waiting-code" }))
    expect(codeless.showUserCode).toBe(false)
    expect(codeless.showWaiting).toBe(true)
  })

  test("choose-project renders the picker with projects, else keeps the cancel exit open", () => {
    const withProjects = cardModel(
      parseOne({ id: "pasqal-cloud", state: "choose-project", identity: "kate@harmoniqs.co", projects: [{ id: "p1" }] }),
    )
    expect(withProjects.showProjectPicker).toBe(true)
    expect(withProjects.showWaiting).toBe(false)
    expect(withProjects.showIdentity).toBe(true)
    expect(withProjects.showLoading).toBe(true) // spinner in the status slot through the picker, not a pending dot
    const empty = cardModel(parseOne({ id: "pasqal-cloud", state: "choose-project" }))
    expect(empty.showProjectPicker).toBe(false)
    expect(empty.showWaiting).toBe(true)
  })

  test("every mid-flow state has distinct label copy via the states record", () => {
    const labels = Object.fromEntries(
      (
        [
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
        ] as ConnectionCardState[]
      ).map((state) => [state, `copy:${state}`]),
    ) as ConnectionStateLabels
    expect(stateCopy(parseOne({ id: "pasqal-cloud", state: "waiting-browser" }), labels)).toBe("copy:waiting-browser")
    expect(stateCopy(parseOne({ id: "pasqal-cloud", state: "choose-project" }), labels)).toBe("copy:choose-project")
  })
})

describe("method model", () => {
  test("no advertisement → the legacy single method per card id, chooser threshold not met", () => {
    expect(connectionAuthMethods(parseOne({ id: "pasqal-cloud", state: "needs-key" }))).toEqual(["credentials"])
    expect(connectionAuthMethods(parseOne({ id: "company-compute", state: "needs-key" }))).toEqual(["token"])
  })

  test("wire-advertised methods win over the legacy default", () => {
    const conn = parseOne({ id: "pasqal-cloud", state: "needs-key", auth_methods: ["browser", "token"] })
    expect(connectionAuthMethods(conn)).toEqual(["browser", "token"])
  })

  test("methodEntryKind: interactive methods render a start, token stays per-id, credentials keeps #169", () => {
    expect(methodEntryKind("pasqal-cloud", "browser")).toBe("none")
    expect(methodEntryKind("pasqal-cloud", "device-code")).toBe("none")
    expect(methodEntryKind("pasqal-cloud", "credentials")).toBe("pasqal-credentials")
    expect(methodEntryKind("pasqal-cloud", "token")).toBe("pasqal-token")
    expect(methodEntryKind("company-compute", "token")).toBe("base-url-token")
    expect(methodEntryKind("company-compute", "credentials")).toBe("base-url-token")
  })
})

describe("scaffold submit gates", () => {
  test("startAuthPayload only fires for wire-advertised interactive methods", () => {
    const advertised = parseOne({ id: "pasqal-cloud", state: "needs-key", auth_methods: ["browser"] })
    expect(startAuthPayload(advertised, "browser")).toEqual({ id: "pasqal-cloud", method: "browser" })
    expect(startAuthPayload(advertised, "device-code")).toBeUndefined()
    expect(startAuthPayload(advertised, "credentials")).toBeUndefined()
    const legacy = parseOne({ id: "pasqal-cloud", state: "needs-key" })
    expect(startAuthPayload(legacy, "browser")).toBeUndefined()
  })

  test("chooseProjectPayload only accepts a wire-offered project id", () => {
    const conn = parseOne({ id: "pasqal-cloud", state: "choose-project", projects: [{ id: "p1", name: "MIS" }] })
    expect(chooseProjectPayload(conn, " p1 ")).toEqual({ id: "pasqal-cloud", project_id: "p1" })
    expect(chooseProjectPayload(conn, "p2")).toBeUndefined()
    expect(chooseProjectPayload(conn, "")).toBeUndefined()
    expect(chooseProjectPayload(parseOne({ id: "pasqal-cloud", state: "choose-project" }), "p1")).toBeUndefined()
  })

  test("pasqalTokenSubmitPayload trims both fields and refuses empties", () => {
    expect(pasqalTokenSubmitPayload("pasqal-cloud", " tok ", " p1 ")).toEqual({
      id: "pasqal-cloud",
      token: "tok",
      project_id: "p1",
    })
    expect(pasqalTokenSubmitPayload("pasqal-cloud", "", "p1")).toBeUndefined()
    expect(pasqalTokenSubmitPayload("pasqal-cloud", "tok", "  ")).toBeUndefined()
  })
})
