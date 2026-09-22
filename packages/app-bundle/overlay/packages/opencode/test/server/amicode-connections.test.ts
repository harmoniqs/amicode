// AMICODE: Connections module tests (amicode#165 / parent #159, ADR 0002).
// Company Compute connect path: probe-first validation, redacting-whitelist
// status rendering, loopback-gated mutations. No live network — every probe
// runs through an injected FetchImpl. Credential + status-cache files ride the
// same env overrides production honors (AMICO_CLOUD_FILE /
// AMICODE_CONNECTIONS_FILE), so the test seam and the deploy seam are one
// mechanism (the #162 idiom).
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { readCredential, writeCredential } from "@/server/amicode/credentials"
import {
  amicodeOpsDir,
  backgroundRevalidationsSettled,
  connectionsFile,
  entitlementsFile,
  inflightOverlay,
  pasqalPython,
  pasqalValidatorScript,
  probeCompanyCompute,
  solverModeFile,
  solverModeResponse,
  statusResponse,
  STALE_MS,
  statusBody,
  submitCredentialResponse,
  chooseProjectResponse,
  disconnectResponse,
  revalidateResponse,
  isLoopbackHostname,
  setBindHostname,
  sessionOnlyOverlay,
  PASQAL_CONFIG_WARNING,
  PASQAL_SECRET_ACCOUNT,
  clearPendingProjectSelections,
  type FetchImpl,
  type PasqalSpawn,
} from "@/server/amicode/connections"
import { inMemorySecretStore, setPasqalSecretStore, type PasqalSecretStore } from "@/server/amicode/pasqal-secret"

const respond =
  (status: number): FetchImpl =>
  async () => ({ status })

// Same env-override discipline as the credentials suite: point every file the
// module touches into a per-test tmp dir, restore after.
const ENV_KEYS = [
  "AMICO_CLOUD_FILE",
  "AMICO_PASQAL_FILE",
  "AMICO_SLACK_FILE",
  "AMICO_GITHUB_FILE",
  "AMICO_LINEAR_FILE",
  "AMICO_GOOGLE_FILE",
  "AMICO_GOOGLE_DRIVE_FILE",
  "AMICODE_CONNECTIONS_FILE",
  "AMICODE_OPS_DIR",
  "AMICO_PYTHON",
  "AMICO_PASQAL_VALIDATOR",
] as const
let savedEnv: Record<string, string | undefined>
let dir: string
// Hermetic secret store: every test gets a fresh in-memory keychain, so the
// suite never touches the real OS keychain and secrets never leak across tests.
let secretStore: PasqalSecretStore
let restoreSecretStore: () => void

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  secretStore = inMemorySecretStore()
  restoreSecretStore = setPasqalSecretStore(secretStore)
  dir = mkdtempSync(path.join(tmpdir(), "amicode-conn-"))
  process.env.AMICO_CLOUD_FILE = path.join(dir, "cloud.json")
  process.env.AMICO_PASQAL_FILE = path.join(dir, "pasqal.json")
  // Token connections (slack/github/linear/google/google-drive, #327) resolve
  // their credential files via AMICO_*_FILE too — redirect them into the tmp dir
  // so a real ~/.amico/<svc>.json on the host never leaks a stored token into a
  // hermetic test (an un-redirected slack.json rendered connected+stale here and
  // fired a SECOND background revalidate — probes=2 and a hung settle).
  process.env.AMICO_SLACK_FILE = path.join(dir, "slack.json")
  process.env.AMICO_GITHUB_FILE = path.join(dir, "github.json")
  process.env.AMICO_LINEAR_FILE = path.join(dir, "linear.json")
  process.env.AMICO_GOOGLE_FILE = path.join(dir, "google.json")
  process.env.AMICO_GOOGLE_DRIVE_FILE = path.join(dir, "google-drive.json")
  process.env.AMICODE_CONNECTIONS_FILE = path.join(dir, "connections.json")
  process.env.AMICODE_OPS_DIR = path.join(dir, "amicode-ops") // flip artifacts (#167) stay hermetic
  process.env.AMICO_PYTHON = "/opt/venvs/amico/bin/python3" // never resolved: every pasqal spawn is injected
  process.env.AMICO_PASQAL_VALIDATOR = "/opt/amico/scripts/pasqal_validate.py"
  inflightOverlay.clear()
  sessionOnlyOverlay.clear()
  clearPendingProjectSelections()
  setBindHostname(undefined) // isolation from any listener another test file bound
})
afterEach(async () => {
  await backgroundRevalidationsSettled() // drain background refreshes BEFORE the env flips to the next test's dir
  restoreSecretStore()
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  inflightOverlay.clear()
  sessionOnlyOverlay.clear()
  clearPendingProjectSelections()
  setBindHostname(undefined)
})

// --- Pasqal fixtures: the #164 validator output contract (shared corpus —
// same values the amicode-side contract tests use, so drift fails both) ---
const PASQAL = {
  username: "kate@example.com",
  password: "hunter2-P0ison-pa55word",
  project_id: "proj-0000-aaaa-bbbb",
}
const pasqalSubmit = JSON.stringify({ id: "pasqal-cloud", ...PASQAL })
const validatorLine = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    ok: true,
    project_id: PASQAL.project_id,
    devices: ["EMU_FREE", "FRESNEL"],
    token: "tok-pasqal-minted",
    expires_at: "2099-08-01T00:00:00+00:00",
    ...over,
  }) + "\n"

/** Recordable spawn stub (AC1): captures argv + the EXACT env object the
 *  module hands the child, then answers a scripted run. */
function scripted(exitCode: number, stdout = "") {
  const calls: { argv: string[]; env: Record<string, string> }[] = []
  const spawn: PasqalSpawn = async (argv, env) => {
    calls.push({ argv: [...argv], env: { ...env } })
    return { exitCode, stdout }
  }
  return { calls, spawn }
}

const pasqalEntry = (body: string) =>
  JSON.parse(body).connections.find((conn: { id: string }) => conn.id === "pasqal-cloud")

const cloudCredential = { base_url: "https://solves.example.co", token: "tok-stored-secret" }

describe("probe classification (AC2)", () => {
  test("authorizer-rejection class: 401 → invalid", async () => {
    expect((await probeCompanyCompute("https://solves.example.co", "tok-1", respond(401))).outcome).toBe("invalid")
  })

  test("LIVE-VERIFIED semantics (amicode#178): 2xx+submitter = valid with identity; 401 AND 403 = invalid (HTTP API authorizer denials emit 403, not 401)", async () => {
    // Live finding 2026-07-20 with a real credential: the old fake-task probe
    // inverted — valid keys 400'd on aws-infra#186's task-id guard while
    // garbage keys got authorizer-denial 403s that classified as valid.
    // Validation now targets GET /solves/whoami (aws-infra#185/#188).
    const whoami: FetchImpl = async () => ({ status: 200, json: async () => ({ submitter: "raghav-internal" }) })
    expect(await probeCompanyCompute("https://solves.example.co", "tok-1", whoami)).toEqual({
      outcome: "valid",
      submitter: "raghav-internal",
    })
    for (const status of [401, 403]) {
      expect((await probeCompanyCompute("https://solves.example.co", "tok-1", respond(status))).outcome).toBe("invalid")
    }
  })

  test("2xx without a submitter echo is tolerated as valid, identity-less (no-echo tolerance)", async () => {
    expect(await probeCompanyCompute("https://solves.example.co", "tok-1", respond(204))).toEqual({ outcome: "valid" })
  })

  test("server-error / network / missing-endpoint classes → unreachable: 400, 404, 5xx, thrown fetch", async () => {
    // 404 = a service deploy that predates the whoami endpoint — refuse to
    // save rather than guess (the shipped service has it; aws-infra#188).
    for (const status of [400, 404, 429, 500, 502, 503]) {
      expect((await probeCompanyCompute("https://solves.example.co", "tok-1", respond(status))).outcome).toBe(
        "unreachable",
      )
    }
    const network: FetchImpl = async () => {
      throw new Error("ECONNREFUSED")
    }
    expect((await probeCompanyCompute("https://solves.example.co", "tok-1", network)).outcome).toBe("unreachable")
  })

  test("probe hits /solves/whoami; the token rides ONLY the Authorization header, never the URL", async () => {
    let seenUrl = ""
    let seenAuth = ""
    const capture: FetchImpl = async (url, init) => {
      seenUrl = url
      seenAuth = init.headers.authorization ?? ""
      return { status: 200, json: async () => ({ submitter: "s" }) }
    }
    await probeCompanyCompute("https://solves.example.co///", "tok-secret-xyz", capture)
    expect(seenUrl).toBe("https://solves.example.co/solves/whoami")
    expect(seenUrl).not.toContain("tok-secret-xyz")
    expect(seenAuth).toBe("Bearer tok-secret-xyz")
  })
})

describe("status list rendering (redacting whitelist, AC3)", () => {
  test("connections file honors the env override; default lives beside cloud.json", () => {
    expect(connectionsFile()).toBe(path.join(dir, "connections.json"))
    delete process.env.AMICODE_CONNECTIONS_FILE
    expect(connectionsFile()).toContain(path.join(".amico", "connections.json"))
  })

  test("no credential, no cache → needs-key for every connection; company-compute stays first", () => {
    const parsed = JSON.parse(statusResponse())
    expect(parsed.ok).toBe(true)
    expect(parsed.error).toBeNull()
    expect(parsed.connections.map((connection: { id: string }) => connection.id)).toEqual([
      "company-compute",
      "pasqal-cloud",
      "slack",
      "github",
      "linear",
      "google",
      "google-drive",
    ])
    for (const connection of parsed.connections) {
      expect(connection).toMatchObject({ state: "needs-key", validated_at: null, stale: false })
    }
  })

  test("credential + fresh connected cache → connected, not stale", () => {
    writeCredential("company-compute", cloudCredential)
    const at = new Date().toISOString()
    writeFileSync(connectionsFile(), JSON.stringify({ "company-compute": { state: "connected", validated_at: at } }))
    const parsed = JSON.parse(statusResponse())
    expect(parsed.connections[0].state).toBe("connected")
    expect(parsed.connections[0].validated_at).toBe(at)
    expect(parsed.connections[0].stale).toBe(false)
  })

  test("connected cache older than STALE_MS → stale:true; unvalidated credential → connected + stale", async () => {
    writeCredential("company-compute", cloudCredential)
    const old = new Date(Date.now() - STALE_MS - 60_000).toISOString()
    writeFileSync(connectionsFile(), JSON.stringify({ "company-compute": { state: "connected", validated_at: old } }))
    // stale GETs kick a background revalidate (170 AC1) — injected here so no
    // live network rides the test; the returned body is the pre-kick cache
    expect(JSON.parse(statusResponse({ fetchImpl: respond(503) })).connections[0].stale).toBe(true)
    await backgroundRevalidationsSettled()
    // a credential that exists but was never validated (e.g. CLI-written
    // cloud.json) renders connected-but-stale, prompting a revalidate
    writeFileSync(connectionsFile(), "{}")
    const unvalidated = JSON.parse(statusResponse({ fetchImpl: respond(503) })).connections[0]
    expect(unvalidated.state).toBe("connected")
    expect(unvalidated.validated_at).toBeNull()
    expect(unvalidated.stale).toBe(true)
  })

  test("connected cache but the credential file is gone → needs-key (credential file is the truth)", () => {
    writeFileSync(
      connectionsFile(),
      JSON.stringify({ "company-compute": { state: "connected", validated_at: new Date().toISOString() } }),
    )
    expect(JSON.parse(statusResponse()).connections[0].state).toBe("needs-key")
  })

  test("in-flight overlay wins: entry present → validating", () => {
    writeCredential("company-compute", cloudCredential)
    inflightOverlay.set("company-compute", { state: "validating" })
    expect(JSON.parse(statusResponse()).connections[0].state).toBe("validating")
  })

  test("unreadable/garbage cache file degrades to needs-key, never a throw", () => {
    writeFileSync(connectionsFile(), "not json {{{")
    const parsed = JSON.parse(statusResponse())
    expect(parsed.ok).toBe(true)
    expect(parsed.connections[0].state).toBe("needs-key")
  })

  test("POISON: token/password keys seeded into EVERY input never reach the response", () => {
    writeCredential("company-compute", cloudCredential)
    // input 1: the cache file, poisoned at every level
    writeFileSync(
      connectionsFile(),
      JSON.stringify({
        token: "POISON-top",
        "company-compute": {
          state: "connected",
          validated_at: new Date().toISOString(),
          identity: "kate",
          identity_drift: { nested: "POISON-drift" }, // whitelisted field, but only a plain string survives
          token: "POISON-entry",
          password: "POISON-password",
          authorization: "Bearer POISON-header",
          nested: { secret: "POISON-nested" },
          offline: "yes-POISON", // whitelisted field, but only the literal true survives
          devices: [{ name: "qpu-1", state: "online", token: "POISON-device" }],
          entitlements: ["solve", { token: "POISON-entitlement" }],
        },
      }),
    )
    // input 2: the in-memory overlay state
    inflightOverlay.set("company-compute", { state: "validating", token: "POISON-overlay", secret: "POISON-mem" })
    // input 3: the in-memory session-only store (pasqal, #169 AC4)
    sessionOnlyOverlay.set("pasqal-cloud", {
      state: "connected",
      validated_at: new Date().toISOString(),
      identity: "proj-1",
      token: "POISON-session",
      password: "POISON-session-password",
      devices: [{ name: "qpu-2", token: "POISON-session-device" }],
    })
    const body = statusResponse()
    expect(body).not.toContain("POISON")
    expect(body).not.toContain("tok-stored-secret") // the stored credential itself must never surface
    const allowed = [
      "id",
      "state",
      "identity",
      "identity_drift",
      "entitlements",
      "expires_at",
      "devices",
      "validated_at",
      "stale",
      "session_only",
      "offline",
      "name",
      "icon",
      "auth_methods",
    ]
    for (const entry of JSON.parse(body).connections) {
      for (const key of Object.keys(entry)) expect(allowed).toContain(key)
      for (const device of entry.devices ?? []) {
        for (const key of Object.keys(device)) expect(["id", "name", "state"]).toContain(key)
      }
    }
  })

  test("statusBody is a pure builder over injectable inputs (profile.ts idiom)", () => {
    const file = path.join(dir, "alt-connections.json")
    writeFileSync(
      file,
      JSON.stringify({ "company-compute": { state: "invalid", validated_at: "2026-07-19T00:00:00Z" } }),
    )
    const parsed = JSON.parse(
      statusBody({ file, overlay: new Map(), hasCredential: () => true, now: Date.parse("2026-07-19T01:00:00Z") }),
    )
    expect(parsed.connections[0].state).toBe("invalid")
    expect(parsed.connections[0].stale).toBe(false)
  })
})

describe("submit credential — probe → save → terminal status, one round trip (AC1, AC2)", () => {
  test("submit: valid key → credential written through the #162 seam + connected in the SAME response (AC1)", async () => {
    const body = JSON.stringify({ id: "company-compute", base_url: "https://solves.example.co/", token: "tok-good" })
    const parsed = JSON.parse(await submitCredentialResponse(body, { fetchImpl: respond(200) }))
    expect(parsed.ok).toBe(true)
    expect(parsed.error).toBeNull()
    expect(parsed.connection.id).toBe("company-compute")
    expect(parsed.connection.state).toBe("connected")
    expect(parsed.connection.stale).toBe(false)
    expect(Date.now() - Date.parse(parsed.connection.validated_at)).toBeLessThan(10_000)
    // written via the seam: the frozen byte shape, trailing slash trimmed
    expect(readCredential("company-compute")).toEqual({ base_url: "https://solves.example.co", token: "tok-good" })
    // a follow-up GET agrees without another probe
    expect(JSON.parse(statusResponse()).connections[0].state).toBe("connected")
  })

  test("submit: 401 → invalid, NOTHING written; a pre-existing credential survives untouched (AC2)", async () => {
    const body = JSON.stringify({ id: "company-compute", base_url: "https://solves.example.co", token: "tok-bad" })
    const rejected = JSON.parse(await submitCredentialResponse(body, { fetchImpl: respond(401) }))
    expect(rejected.ok).toBe(true)
    expect(rejected.connection.state).toBe("invalid")
    expect(readCredential("company-compute")).toBeUndefined()
    expect(JSON.parse(statusResponse()).connections[0].state).toBe("invalid")
    // now with an older good credential on disk: the failed attempt must not clobber it
    writeCredential("company-compute", cloudCredential)
    await submitCredentialResponse(body, { fetchImpl: respond(401) })
    expect(readCredential("company-compute")).toEqual(cloudCredential)
  })

  test("submit: network/server trouble → unreachable, nothing written, token-free fixed message (AC2)", async () => {
    const boom: FetchImpl = async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.1:443")
    }
    for (const fetchImpl of [boom, respond(500)]) {
      const raw = await submitCredentialResponse(
        JSON.stringify({ id: "company-compute", base_url: "https://solves.example.co", token: "tok-hidden" }),
        { fetchImpl },
      )
      const parsed = JSON.parse(raw)
      expect(parsed.connection.state).toBe("unreachable")
      expect(raw).not.toContain("tok-hidden")
      expect(readCredential("company-compute")).toBeUndefined()
    }
  })

  test("submit: while the probe is in flight, concurrent GETs render 'validating'; terminal state clears it", async () => {
    let release!: (v: { status: number }) => void
    const gate = new Promise<{ status: number }>((resolve) => (release = resolve))
    const blocking: FetchImpl = () => gate
    const pending = submitCredentialResponse(
      JSON.stringify({ id: "company-compute", base_url: "https://solves.example.co", token: "tok-slow" }),
      { fetchImpl: blocking },
    )
    await Bun.sleep(0) // let the submit reach the probe await
    expect(JSON.parse(statusResponse()).connections[0].state).toBe("validating")
    release({ status: 200 })
    expect(JSON.parse(await pending).connection.state).toBe("connected")
    expect(inflightOverlay.size).toBe(0)
    expect(JSON.parse(statusResponse()).connections[0].state).toBe("connected")
  })

  test("submit: malformed bodies → ok:false with VALUE-FREE errors; nothing written, no probe fired", async () => {
    let probes = 0
    const counting: FetchImpl = async () => {
      probes++
      return { status: 200 }
    }
    const cases = [
      "not json {{{",
      JSON.stringify({ id: "company-compute", token: "tok-orphan-xyz" }), // base_url required in body
      JSON.stringify({ id: "company-compute", base_url: "https://x.co", token: "" }),
      JSON.stringify({ id: "company-compute", base_url: "ftp://x.co", token: "tok-orphan-xyz" }),
      JSON.stringify({ id: "pasqal-cloud", base_url: "https://x.co", token: "tok-orphan-xyz" }), // wrong field set for pasqal
      JSON.stringify({ id: "who-knows", base_url: "https://x.co", token: "tok-orphan-xyz" }),
    ]
    for (const body of cases) {
      const raw = await submitCredentialResponse(body, { fetchImpl: counting })
      const parsed = JSON.parse(raw)
      expect(parsed.ok).toBe(false)
      expect(parsed.connection).toBeNull()
      expect(raw).not.toContain("tok-orphan-xyz") // error text never echoes what was rejected
    }
    expect(probes).toBe(0)
    expect(readCredential("company-compute")).toBeUndefined()
  })
})

// --- HP flip on Company Compute connect (amicode#167 / parent #159): a VALID
// save grants `issimo` and writes the durable {mode:"hp",status:"switching"}
// request; the amicode extension's EXISTING watcher (solver_mode.ts) does the
// actual re-prep. These tests assert the fork-side artifacts on file bytes —
// the shared ops-dir contract, hermetic via $AMICODE_OPS_DIR.

const validSubmit = JSON.stringify({
  id: "company-compute",
  base_url: "https://solves.example.co",
  token: "tok-good",
})

describe("HP flip on connect — artifacts in the ops dir (167 AC1, AC3)", () => {
  test("flip artifacts resolve through $AMICODE_OPS_DIR, defaulting to ~/.amico/amicode (the extension's amicodeOpsDir)", () => {
    expect(amicodeOpsDir()).toBe(path.join(dir, "amicode-ops"))
    expect(entitlementsFile()).toBe(path.join(dir, "amicode-ops", "entitlements.toml"))
    expect(solverModeFile()).toBe(path.join(dir, "amicode-ops", "solver-mode.json"))
    delete process.env.AMICODE_OPS_DIR
    expect(entitlementsFile()).toContain(path.join(".amico", "amicode", "entitlements.toml"))
    expect(solverModeFile()).toContain(path.join(".amico", "amicode", "solver-mode.json"))
  })

  test("valid save → BOTH artifacts: issimo granted in entitlements.toml AND the hp switching request (AC1)", async () => {
    const parsed = JSON.parse(await submitCredentialResponse(validSubmit, { fetchImpl: respond(200) }))
    expect(parsed.ok).toBe(true)
    expect(parsed.error).toBeNull()
    expect(parsed.connection.state).toBe("connected")
    // artifact 1: the exact byte shape the extension's applyEntitlementForMode writes/reads
    expect(readFileSync(entitlementsFile(), "utf8")).toBe('codes = ["issimo"]\n')
    // artifact 2: the exact request shape the extension's watchSolverMode consumes
    expect(JSON.parse(readFileSync(solverModeFile(), "utf8"))).toEqual({ mode: "hp", status: "switching" })
  })

  test("grant PRESERVES existing codes (and the expired list) — read-modify-write, byte-compatible", async () => {
    mkdirSync(amicodeOpsDir(), { recursive: true })
    writeFileSync(entitlementsFile(), 'codes = ["pasqal-hackathon-2026"]\nexpired = ["old-2025"]\n')
    await submitCredentialResponse(validSubmit, { fetchImpl: respond(200) })
    expect(readFileSync(entitlementsFile(), "utf8")).toBe(
      'codes = ["pasqal-hackathon-2026", "issimo"]\nexpired = ["old-2025"]\n',
    )
  })

  test("headless: no extension host consumes anything — both artifacts persist durably, response path clean (AC3)", async () => {
    // this suite runs with NO extension host: headless is the ambient truth here
    const raw = await submitCredentialResponse(validSubmit, { fetchImpl: respond(200) })
    const parsed = JSON.parse(raw)
    expect(parsed.ok).toBe(true)
    expect(parsed.error).toBeNull()
    const entitlementBytes = readFileSync(entitlementsFile(), "utf8")
    const modeBytes = readFileSync(solverModeFile(), "utf8")
    // a later GET disturbs nothing; re-reads see the same bytes — the request
    // is still pending for the next extension attach
    expect(JSON.parse(statusResponse()).connections[0].state).toBe("connected")
    expect(readFileSync(entitlementsFile(), "utf8")).toBe(entitlementBytes)
    expect(readFileSync(solverModeFile(), "utf8")).toBe(modeBytes)
    expect(JSON.parse(modeBytes)).toEqual({ mode: "hp", status: "switching" })
  })
})

describe("HP flip on connect — only the valid outcome flips; repeats stay idempotent (167 AC4)", () => {
  test("invalid / unreachable / malformed / non-loopback → NO flip artifacts of any kind", async () => {
    const boom: FetchImpl = async () => {
      throw new Error("ECONNREFUSED")
    }
    const attempts: [string, FetchImpl][] = [
      [validSubmit, respond(401)], // invalid
      [validSubmit, respond(500)], // unreachable (server trouble)
      [validSubmit, boom], // unreachable (network)
      ["not json {{{", respond(200)], // malformed body — no probe, no save
    ]
    for (const [body, fetchImpl] of attempts) await submitCredentialResponse(body, { fetchImpl })
    setBindHostname("0.0.0.0") // refused mutations must not flip either
    await submitCredentialResponse(validSubmit, { fetchImpl: respond(200) })
    setBindHostname(undefined)
    expect(existsSync(entitlementsFile())).toBe(false)
    expect(existsSync(solverModeFile())).toBe(false)
  })

  test("a failed revalidation never revokes: pre-granted entitlements survive an invalid outcome untouched", async () => {
    await submitCredentialResponse(validSubmit, { fetchImpl: respond(200) }) // granted + switching
    const entitlementBytes = readFileSync(entitlementsFile(), "utf8")
    const modeBytes = readFileSync(solverModeFile(), "utf8")
    await submitCredentialResponse(validSubmit, { fetchImpl: respond(401) }) // key went bad
    await revalidateResponse(JSON.stringify({ id: "company-compute" }), { fetchImpl: respond(401) })
    expect(readFileSync(entitlementsFile(), "utf8")).toBe(entitlementBytes)
    expect(readFileSync(solverModeFile(), "utf8")).toBe(modeBytes)
  })

  test("disconnect leaves both artifacts alone — the flip is one-way; the user's toggle owns reverting", async () => {
    await submitCredentialResponse(validSubmit, { fetchImpl: respond(200) })
    const entitlementBytes = readFileSync(entitlementsFile(), "utf8")
    disconnectResponse(JSON.stringify({ id: "company-compute" }))
    expect(readFileSync(entitlementsFile(), "utf8")).toBe(entitlementBytes)
    expect(JSON.parse(readFileSync(solverModeFile(), "utf8"))).toEqual({ mode: "hp", status: "switching" })
  })

  test("repeat valid save while already hp+granted: no duplicate codes, no fresh switching write", async () => {
    await submitCredentialResponse(validSubmit, { fetchImpl: respond(200) })
    expect(JSON.parse(readFileSync(solverModeFile(), "utf8")).status).toBe("switching")
    // the extension watcher settles the request: ready at hp (writeSolverModeReady shape)
    writeFileSync(
      solverModeFile(),
      JSON.stringify({ mode: "hp", status: "ready", switched_at: new Date().toISOString() }),
    )
    const entitlementBytes = readFileSync(entitlementsFile(), "utf8")
    const again = JSON.parse(await submitCredentialResponse(validSubmit, { fetchImpl: respond(200) }))
    expect(again.ok).toBe(true)
    expect(again.connection.state).toBe("connected")
    expect(readFileSync(entitlementsFile(), "utf8")).toBe(entitlementBytes) // ONE issimo, byte-identical
    expect(JSON.parse(readFileSync(solverModeFile(), "utf8")).status).toBe("ready") // watcher NOT poked again
  })

  test("hp already active but the grant is missing → the switch IS re-requested (re-prep must apply the entitlement)", async () => {
    mkdirSync(amicodeOpsDir(), { recursive: true })
    writeFileSync(solverModeFile(), JSON.stringify({ mode: "hp", status: "ready" }))
    writeFileSync(entitlementsFile(), 'codes = ["pasqal-hackathon-2026"]\n') // issimo absent
    await submitCredentialResponse(validSubmit, { fetchImpl: respond(200) })
    expect(readFileSync(entitlementsFile(), "utf8")).toBe('codes = ["pasqal-hackathon-2026", "issimo"]\n')
    expect(JSON.parse(readFileSync(solverModeFile(), "utf8"))).toEqual({ mode: "hp", status: "switching" })
  })
})

describe("HP flip on connect — flip trouble never corrupts the save (167 partial failure)", () => {
  test("flip write failure → credential SAVED, connected status, fixed value-free warning in the error field", async () => {
    // an ops dir that cannot exist: a regular file occupies the parent path
    writeFileSync(path.join(dir, "blocker"), "")
    process.env.AMICODE_OPS_DIR = path.join(dir, "blocker", "ops")
    const raw = await submitCredentialResponse(
      JSON.stringify({ id: "company-compute", base_url: "https://solves.example.co", token: "tok-flip-fail" }),
      { fetchImpl: respond(200) },
    )
    const parsed = JSON.parse(raw)
    expect(parsed.ok).toBe(true) // the save SUCCEEDED — partial failure is a warning, not a failure
    expect(parsed.connection.state).toBe("connected")
    expect(parsed.error).toStartWith("hp_flip_failed:") // sibling "code: detail" shape, fixed string
    expect(raw).not.toContain("tok-flip-fail") // value-free: no token…
    expect(raw).not.toContain(dir) // …and no filesystem path/errno detail either
    expect(readCredential("company-compute")).toEqual({ base_url: "https://solves.example.co", token: "tok-flip-fail" })
    expect(JSON.parse(statusResponse()).connections[0].state).toBe("connected") // the cache write preceded the flip
  })
})

describe("disconnect + revalidate (AC4)", () => {
  test("disconnect clears the credential; status becomes needs-key; idempotent", async () => {
    await submitCredentialResponse(
      JSON.stringify({ id: "company-compute", base_url: "https://solves.example.co", token: "tok-good" }),
      { fetchImpl: respond(200) },
    )
    const parsed = JSON.parse(disconnectResponse(JSON.stringify({ id: "company-compute" })))
    expect(parsed.ok).toBe(true)
    expect(parsed.connection).toMatchObject({ id: "company-compute", state: "needs-key", validated_at: null, stale: false })
    expect(readCredential("company-compute")).toBeUndefined()
    expect(JSON.parse(statusResponse()).connections[0].state).toBe("needs-key")
    // disconnecting an already-absent credential is a no-op, not an error
    expect(JSON.parse(disconnectResponse(JSON.stringify({ id: "company-compute" }))).ok).toBe(true)
  })

  test("disconnect: malformed body / unknown id → ok:false", () => {
    expect(JSON.parse(disconnectResponse("nope")).ok).toBe(false)
    expect(JSON.parse(disconnectResponse(JSON.stringify({ id: "who-knows" }))).ok).toBe(false)
  })

  test("revalidate runs from the STORED credential — no secret rides the request (AC4)", async () => {
    writeCredential("company-compute", cloudCredential)
    const stale = new Date(Date.now() - STALE_MS - 60_000).toISOString()
    writeFileSync(connectionsFile(), JSON.stringify({ "company-compute": { state: "connected", validated_at: stale } }))
    let seenUrl = ""
    let seenAuth = ""
    const capture: FetchImpl = async (url, init) => {
      seenUrl = url
      seenAuth = init.headers.authorization ?? ""
      return { status: 200 }
    }
    const request = JSON.stringify({ id: "company-compute" }) // the whole body — token never leaves the server
    const parsed = JSON.parse(await revalidateResponse(request, { fetchImpl: capture }))
    expect(seenUrl).toBe("https://solves.example.co/solves/whoami")
    expect(seenAuth).toBe(`Bearer ${cloudCredential.token}`)
    expect(parsed.ok).toBe(true)
    expect(parsed.connection.state).toBe("connected")
    expect(parsed.connection.stale).toBe(false)
    expect(Date.parse(parsed.connection.validated_at)).toBeGreaterThan(Date.parse(stale)) // timestamp refreshed
  })

  test("revalidate: 401 → invalid but the stored credential is KEPT; unreachable refreshes the timestamp too", async () => {
    writeCredential("company-compute", cloudCredential)
    const invalid = JSON.parse(
      await revalidateResponse(JSON.stringify({ id: "company-compute" }), { fetchImpl: respond(401) }),
    )
    expect(invalid.connection.state).toBe("invalid")
    expect(readCredential("company-compute")).toEqual(cloudCredential) // user data survives; re-entry is their call
    const unreachable = JSON.parse(
      await revalidateResponse(JSON.stringify({ id: "company-compute" }), { fetchImpl: respond(503) }),
    )
    expect(unreachable.connection.state).toBe("unreachable")
    expect(unreachable.connection.validated_at).not.toBeNull()
  })

  test("revalidate with no stored credential → needs-key, no probe fired", async () => {
    let probes = 0
    const counting: FetchImpl = async () => {
      probes++
      return { status: 200 }
    }
    const parsed = JSON.parse(
      await revalidateResponse(JSON.stringify({ id: "company-compute" }), { fetchImpl: counting }),
    )
    expect(parsed.ok).toBe(true)
    expect(parsed.connection.state).toBe("needs-key")
    expect(probes).toBe(0)
  })
})

describe("loopback guard on mutations (AC5)", () => {
  test("loopback classification: 127/8, localhost, ::1 (and v4-mapped) are loopback; wildcard/LAN binds are not", () => {
    for (const host of [undefined, "127.0.0.1", "127.1.2.3", "localhost", "LOCALHOST", "::1", "::ffff:127.0.0.1"]) {
      expect(isLoopbackHostname(host)).toBe(true)
    }
    for (const host of ["0.0.0.0", "::", "192.168.1.5", "10.0.0.2", "example.co", ""]) {
      expect(isLoopbackHostname(host)).toBe(false)
    }
  })

  test("bound beyond loopback → every mutation refuses with the DISTINCT error; nothing happens", async () => {
    setBindHostname("0.0.0.0")
    let probes = 0
    const counting: FetchImpl = async () => {
      probes++
      return { status: 200 }
    }
    const submit = JSON.parse(
      await submitCredentialResponse(
        JSON.stringify({ id: "company-compute", base_url: "https://solves.example.co", token: "tok-lan" }),
        { fetchImpl: counting },
      ),
    )
    const disconnect = JSON.parse(disconnectResponse(JSON.stringify({ id: "company-compute" })))
    const revalidate = JSON.parse(
      await revalidateResponse(JSON.stringify({ id: "company-compute" }), { fetchImpl: counting }),
    )
    for (const parsed of [submit, disconnect, revalidate]) {
      expect(parsed.ok).toBe(false)
      expect(parsed.error).toStartWith("non_loopback:")
    }
    expect(probes).toBe(0)
    expect(readCredential("company-compute")).toBeUndefined()
    // the read-only status route still serves
    expect(JSON.parse(statusResponse()).ok).toBe(true)
  })

  test("back on a loopback bind, mutations serve again", async () => {
    setBindHostname("127.0.0.1")
    const parsed = JSON.parse(
      await submitCredentialResponse(
        JSON.stringify({ id: "company-compute", base_url: "https://solves.example.co", token: "tok-good" }),
        { fetchImpl: respond(200) },
      ),
    )
    expect(parsed.ok).toBe(true)
    expect(parsed.connection.state).toBe("connected")
  })
})

// --- Pasqal card (amicode#169 / parent #159): submit spawns the #164
// validator — env-only inputs, one-line JSON + exit-code contract — and only
// the minted token persists. The card is served off the SAME routes as
// company-compute; every spawn below is injected, never a real child.

describe("pasqal submit — validator spawn contract (169 AC1)", () => {
  test("spawn is <python> <script> with EXACTLY the minimal env — never a process.env spread", async () => {
    process.env.AMICODE_TEST_CANARY = "canary-full-spread-detector" // a spread would carry this through
    try {
      const { calls, spawn } = scripted(0, validatorLine())
      const parsed = JSON.parse(await submitCredentialResponse(pasqalSubmit, { pasqalSpawn: spawn }))
      expect(parsed.ok).toBe(true)
      expect(calls).toHaveLength(1)
      // argv: interpreter + script, nothing else — no secret ever rides argv
      expect(calls[0].argv).toEqual(["/opt/venvs/amico/bin/python3", "/opt/amico/scripts/pasqal_validate.py"])
      expect(JSON.stringify(calls[0].argv)).not.toContain(PASQAL.password)
      expect(JSON.stringify(calls[0].argv)).not.toContain(PASQAL.username)
      // env: the exact declared key set — PATH (interpreter resolution) + the three inputs
      expect(Object.keys(calls[0].env).sort()).toEqual([
        "PASQAL_PASSWORD",
        "PASQAL_PROJECT_ID",
        "PASQAL_USERNAME",
        "PATH",
      ])
      expect(calls[0].env.PASQAL_USERNAME).toBe(PASQAL.username)
      expect(calls[0].env.PASQAL_PASSWORD).toBe(PASQAL.password)
      expect(calls[0].env.PASQAL_PROJECT_ID).toBe(PASQAL.project_id)
      expect(calls[0].env.PATH).toBe(process.env.PATH ?? "")
      expect(JSON.stringify(calls[0].env)).not.toContain("canary-full-spread-detector")
    } finally {
      delete process.env.AMICODE_TEST_CANARY
    }
  })

  test("interpreter/script resolution: $AMICO_PYTHON / $AMICO_PASQAL_VALIDATOR override, documented defaults", () => {
    expect(pasqalPython()).toBe("/opt/venvs/amico/bin/python3")
    expect(pasqalValidatorScript()).toBe("/opt/amico/scripts/pasqal_validate.py")
    process.env.AMICO_PYTHON = "   " // blank → default: python3 resolved on PATH
    delete process.env.AMICO_PASQAL_VALIDATOR
    expect(pasqalPython()).toBe("python3")
    // default: the amicode-staged script under the SHARED ops dir resolution
    expect(pasqalValidatorScript()).toBe(
      path.join(dir, "amicode-ops", "scripts", "pasqal-connector", "pasqal_validate.py"),
    )
    delete process.env.AMICODE_OPS_DIR
    expect(pasqalValidatorScript()).toContain(
      path.join(".amico", "amicode", "scripts", "pasqal-connector", "pasqal_validate.py"),
    )
  })

  test("missing/blank username or password → bad_request, NO spawn, value-free error (#194: project_id is optional)", async () => {
    const { calls, spawn } = scripted(0, validatorLine())
    const cases = [
      JSON.stringify({ id: "pasqal-cloud" }),
      JSON.stringify({ id: "pasqal-cloud", username: PASQAL.username }), // no password
      JSON.stringify({ id: "pasqal-cloud", username: "", password: PASQAL.password }),
      JSON.stringify({ id: "pasqal-cloud", username: PASQAL.username, password: "   " }),
    ]
    for (const body of cases) {
      const raw = await submitCredentialResponse(body, { pasqalSpawn: spawn })
      const parsed = JSON.parse(raw)
      expect(parsed.ok).toBe(false)
      expect(parsed.connection).toBeNull()
      expect(raw).not.toContain(PASQAL.password) // error text never echoes what was rejected
      expect(raw).not.toContain(PASQAL.username)
    }
    expect(calls).toHaveLength(0)
    expect(readCredential("pasqal-cloud")).toBeUndefined()
  })

  test("while the validator runs, concurrent GETs render 'validating'; the terminal state clears it", async () => {
    let release!: (run: { exitCode: number; stdout: string }) => void
    const gate = new Promise<{ exitCode: number; stdout: string }>((resolve) => (release = resolve))
    const blocking: PasqalSpawn = () => gate
    const pending = submitCredentialResponse(pasqalSubmit, { pasqalSpawn: blocking })
    await Bun.sleep(0) // let the submit reach the spawn await
    expect(pasqalEntry(statusResponse()).state).toBe("validating")
    release({ exitCode: 0, stdout: validatorLine() })
    expect(JSON.parse(await pending).connection.state).toBe("connected")
    expect(inflightOverlay.size).toBe(0)
    expect(pasqalEntry(statusResponse()).state).toBe("connected")
  })
})

describe("pasqal submit — token-only persistence + device metadata (169 AC2)", () => {
  test("valid run with a token → token-only credential via the #162 seam; connected + identity + devices in the SAME response", async () => {
    const raw = await submitCredentialResponse(pasqalSubmit, { pasqalSpawn: scripted(0, validatorLine()).spawn })
    const parsed = JSON.parse(raw)
    expect(parsed.ok).toBe(true)
    expect(parsed.error).toBeNull()
    expect(parsed.connection.state).toBe("connected")
    expect(parsed.connection.identity).toBe(PASQAL.project_id)
    expect(parsed.connection.devices).toEqual([{ name: "EMU_FREE" }, { name: "FRESNEL" }])
    expect(parsed.connection.expires_at).toBe("2099-08-01T00:00:00+00:00")
    // token-only at rest: project_id + token + expiry — no username, no password
    expect(readCredential("pasqal-cloud")).toEqual({
      project_id: PASQAL.project_id,
      token: "tok-pasqal-minted",
      expires_at: "2099-08-01T00:00:00+00:00",
    })
    // the response body itself is secret-free
    expect(raw).not.toContain(PASQAL.password)
    expect(raw).not.toContain(PASQAL.username)
    expect(raw).not.toContain("tok-pasqal-minted")
    // a follow-up GET agrees from disk — devices are status metadata, not credential bytes
    const entry = pasqalEntry(statusResponse())
    expect(entry.state).toBe("connected")
    expect(entry.identity).toBe(PASQAL.project_id)
    expect(entry.devices).toEqual([{ name: "EMU_FREE" }, { name: "FRESNEL" }])
  })

  test("device metadata REFRESHES on every submit — the newest list replaces the old one", async () => {
    await submitCredentialResponse(pasqalSubmit, { pasqalSpawn: scripted(0, validatorLine()).spawn })
    const shrunk = validatorLine({ devices: ["FRESNEL"], token: "tok-pasqal-rotated" })
    await submitCredentialResponse(pasqalSubmit, { pasqalSpawn: scripted(0, shrunk).spawn })
    const entry = pasqalEntry(statusResponse())
    expect(entry.devices).toEqual([{ name: "FRESNEL" }])
    expect(readCredential("pasqal-cloud")?.token).toBe("tok-pasqal-rotated")
  })

  test("a valid Pasqal save NEVER touches solver mode — the HP flip is company-compute-only", async () => {
    const parsed = JSON.parse(
      await submitCredentialResponse(pasqalSubmit, { pasqalSpawn: scripted(0, validatorLine()).spawn }),
    )
    expect(parsed.connection.state).toBe("connected")
    expect(existsSync(entitlementsFile())).toBe(false)
    expect(existsSync(solverModeFile())).toBe(false)
  })
})

describe("pasqal submit — exit-code classes map to distinct states (169 AC5)", () => {
  test("exit 2 → invalid; exit 3 → unreachable; exit 4 → unentitled (project-unauthorized); nothing written", async () => {
    for (const [exitCode, state] of [
      [2, "invalid"],
      [3, "unreachable"],
      [4, "unentitled"],
    ] as const) {
      const raw = await submitCredentialResponse(pasqalSubmit, { pasqalSpawn: scripted(exitCode).spawn })
      const parsed = JSON.parse(raw)
      expect(parsed.ok).toBe(true)
      expect(parsed.error).toBeNull() // contract classes carry no extra warning — the state IS the message
      expect(parsed.connection.state).toBe(state)
      expect(raw).not.toContain(PASQAL.password)
      expect(readCredential("pasqal-cloud")).toBeUndefined()
      expect(pasqalEntry(statusResponse()).state).toBe(state) // persisted for follow-up GETs
    }
  })

  test("config class — exit 1, unknown exits, garbage stdout, spawn throw → unreachable + DISTINCT value-free warning", async () => {
    const boom: PasqalSpawn = async () => {
      throw new Error(`ENOENT: no such file /opt/venvs/amico/bin/python3 (user ${PASQAL.username})`)
    }
    const runs: PasqalSpawn[] = [
      scripted(1).spawn, // missing env / missing SDK
      scripted(127).spawn, // interpreter not found via a shell-ish exit
      scripted(0, "not json {{{").spawn, // exit 0 without the contract line
      scripted(0, JSON.stringify({ ok: false })).spawn, // ok:false on exit 0 is off-contract
      boom, // spawn itself failed
    ]
    for (const pasqalSpawn of runs) {
      const raw = await submitCredentialResponse(pasqalSubmit, { pasqalSpawn })
      const parsed = JSON.parse(raw)
      expect(parsed.ok).toBe(true) // the mutation ran; trouble rides the warning channel (#167 idiom)
      expect(parsed.connection.state).toBe("unreachable")
      expect(parsed.error).toStartWith("pasqal_validator_config:") // distinct from a plain exit-3 unreachable
      expect(parsed.error).toBe(PASQAL_CONFIG_WARNING) // FIXED string — value-free by construction
      expect(raw).not.toContain(PASQAL.password)
      expect(raw).not.toContain(PASQAL.username)
      expect(readCredential("pasqal-cloud")).toBeUndefined()
    }
  })

  test("a failed submit never clobbers a previously stored pasqal credential", async () => {
    await submitCredentialResponse(pasqalSubmit, { pasqalSpawn: scripted(0, validatorLine()).spawn })
    const stored = readCredential("pasqal-cloud")
    expect(stored).toBeDefined()
    for (const spawn of [scripted(2).spawn, scripted(3).spawn, scripted(4).spawn, scripted(1).spawn]) {
      await submitCredentialResponse(pasqalSubmit, { pasqalSpawn: spawn })
      expect(readCredential("pasqal-cloud")).toEqual(stored!)
    }
  })
})

describe("pasqal submit — null token → session-only connected (169 AC4)", () => {
  const sessionOnlyLine = validatorLine({ token: null, expires_at: null })

  test("null token → connected + session_only marker; NOTHING lands on disk", async () => {
    const raw = await submitCredentialResponse(pasqalSubmit, { pasqalSpawn: scripted(0, sessionOnlyLine).spawn })
    const parsed = JSON.parse(raw)
    expect(parsed.ok).toBe(true)
    expect(parsed.error).toBeNull()
    expect(parsed.connection.state).toBe("connected")
    expect(parsed.connection.session_only).toBe(true)
    expect(parsed.connection.identity).toBe(PASQAL.project_id)
    expect(parsed.connection.devices).toEqual([{ name: "EMU_FREE" }, { name: "FRESNEL" }])
    // nothing persisted: no credential file, no pasqal claim in the status cache
    expect(readCredential("pasqal-cloud")).toBeUndefined()
    expect(existsSync(path.join(dir, "pasqal.json"))).toBe(false)
    const cache = existsSync(connectionsFile()) ? JSON.parse(readFileSync(connectionsFile(), "utf8")) : {}
    expect(cache["pasqal-cloud"]).toBeUndefined()
    // live GETs agree from the in-memory claim
    const entry = pasqalEntry(statusResponse())
    expect(entry.state).toBe("connected")
    expect(entry.session_only).toBe(true)
    expect(entry.devices).toEqual([{ name: "EMU_FREE" }, { name: "FRESNEL" }])
  })

  test("restart semantics: a FRESH status build from disk renders needs-key — the claim died with the process", async () => {
    await submitCredentialResponse(pasqalSubmit, { pasqalSpawn: scripted(0, sessionOnlyLine).spawn })
    expect(pasqalEntry(statusResponse()).state).toBe("connected") // live process still connected
    // simulated restart: SAME disk inputs, fresh in-memory state (no session store bound)
    const fresh = statusBody({
      file: connectionsFile(),
      overlay: new Map(),
      hasCredential: (id) => readCredential(id) !== undefined,
    })
    expect(pasqalEntry(fresh).state).toBe("needs-key")
    expect(pasqalEntry(fresh).session_only).toBeUndefined()
  })

  test("a later submit that mints a real token replaces the session-only claim with a durable one", async () => {
    await submitCredentialResponse(pasqalSubmit, { pasqalSpawn: scripted(0, sessionOnlyLine).spawn })
    const parsed = JSON.parse(
      await submitCredentialResponse(pasqalSubmit, { pasqalSpawn: scripted(0, validatorLine()).spawn }),
    )
    expect(parsed.connection.state).toBe("connected")
    expect(parsed.connection.session_only).toBeUndefined()
    expect(readCredential("pasqal-cloud")?.token).toBe("tok-pasqal-minted")
    // and a failed follow-up drops the session claim rather than keep a stale "connected"
    await submitCredentialResponse(pasqalSubmit, { pasqalSpawn: scripted(0, sessionOnlyLine).spawn })
    await submitCredentialResponse(pasqalSubmit, { pasqalSpawn: scripted(2).spawn })
    expect(pasqalEntry(statusResponse()).state).toBe("invalid")
  })

  test("disconnect ends a session-only connection immediately", async () => {
    await submitCredentialResponse(pasqalSubmit, { pasqalSpawn: scripted(0, sessionOnlyLine).spawn })
    const parsed = JSON.parse(disconnectResponse(JSON.stringify({ id: "pasqal-cloud" })))
    expect(parsed.ok).toBe(true)
    expect(parsed.connection.state).toBe("needs-key")
    expect(pasqalEntry(statusResponse()).state).toBe("needs-key")
  })
})

describe("pasqal revalidate — freshness check + #194 keychain silent re-auth", () => {
  test("an UNEXPIRED token never spawns the validator — freshness is local expiry math", async () => {
    await submitCredentialResponse(pasqalSubmit, { pasqalSpawn: scripted(0, validatorLine()).spawn })
    const { calls, spawn } = scripted(0, validatorLine())
    const parsed = JSON.parse(await revalidateResponse(JSON.stringify({ id: "pasqal-cloud" }), { pasqalSpawn: spawn }))
    expect(calls).toHaveLength(0) // unexpired → no re-auth, no spawn
    expect(parsed.ok).toBe(true)
    expect(parsed.connection.state).toBe("connected")
  })

  test("unexpired token → connected with a REFRESHED validated_at; devices/identity metadata kept", async () => {
    await submitCredentialResponse(pasqalSubmit, { pasqalSpawn: scripted(0, validatorLine()).spawn })
    // age the persisted claim so freshness is observable
    const cache = JSON.parse(readFileSync(connectionsFile(), "utf8"))
    const old = new Date(Date.now() - STALE_MS - 60_000).toISOString()
    cache["pasqal-cloud"].validated_at = old
    writeFileSync(connectionsFile(), JSON.stringify(cache))
    expect(pasqalEntry(statusResponse()).stale).toBe(true)

    const parsed = JSON.parse(await revalidateResponse(JSON.stringify({ id: "pasqal-cloud" })))
    expect(parsed.connection.state).toBe("connected")
    expect(parsed.connection.stale).toBe(false)
    expect(Date.parse(parsed.connection.validated_at)).toBeGreaterThan(Date.parse(old))
    expect(parsed.connection.identity).toBe(PASQAL.project_id)
    expect(parsed.connection.devices).toEqual([{ name: "EMU_FREE" }, { name: "FRESNEL" }]) // metadata survives
  })

  test("expired token with NO stored password → expired, credential KEPT for #160's token-mode probe", async () => {
    const pastExpiry = validatorLine({ expires_at: "2026-07-18T00:00:00+00:00" }) // yesterday
    await submitCredentialResponse(pasqalSubmit, { pasqalSpawn: scripted(0, pastExpiry).spawn })
    secretStore.clear(PASQAL_SECRET_ACCOUNT) // simulate keychain unreachable / password lost
    const { calls, spawn } = scripted(0, validatorLine())
    const parsed = JSON.parse(await revalidateResponse(JSON.stringify({ id: "pasqal-cloud" }), { pasqalSpawn: spawn }))
    expect(calls).toHaveLength(0) // no password → no silent re-auth attempt
    expect(parsed.connection.state).toBe("expired")
    expect(readCredential("pasqal-cloud")?.token).toBe("tok-pasqal-minted") // user data survives
    expect(pasqalEntry(statusResponse()).state).toBe("expired")
  })

  test("no expiry metadata → connected stands (honest minimum; a live token probe is #160 territory)", async () => {
    writeCredential("pasqal-cloud", { project_id: PASQAL.project_id, token: "tok-cli-written" })
    const parsed = JSON.parse(await revalidateResponse(JSON.stringify({ id: "pasqal-cloud" })))
    expect(parsed.connection.state).toBe("connected")
    expect(parsed.connection.identity).toBe(PASQAL.project_id)
    expect(parsed.connection.validated_at).not.toBeNull()
  })

  test("no stored credential → needs-key; a session-only claim is left standing (nothing to re-check)", async () => {
    const empty = JSON.parse(await revalidateResponse(JSON.stringify({ id: "pasqal-cloud" })))
    expect(empty.ok).toBe(true)
    expect(empty.connection.state).toBe("needs-key")
    // session-only connection: revalidate cannot re-auth (no password) and must not destroy the claim
    await submitCredentialResponse(pasqalSubmit, {
      pasqalSpawn: scripted(0, validatorLine({ token: null, expires_at: null })).spawn,
    })
    const session = JSON.parse(await revalidateResponse(JSON.stringify({ id: "pasqal-cloud" })))
    expect(session.connection.state).toBe("connected")
    expect(session.connection.session_only).toBe(true)
  })
})

// #194 (ADR 0001 addendum): Pasqal's API accepts only password-grant and
// service-account tokens — refresh tokens 403, browser/device grants are
// client-disabled — so the ~24h user token must be silently re-minted from a
// keychain-stored password. These tests inject the in-memory keychain
// (beforeEach) and a scripted validator; the real @napi-rs/keyring backend +
// bun-compiled-binary load is verified on a real machine (see the ADR).
describe("pasqal silent re-auth — keychain password re-mints the expired token (#194)", () => {
  const expiredLine = validatorLine({ expires_at: "2026-07-18T00:00:00+00:00" })
  const freshLine = validatorLine({ token: "tok-reminted", expires_at: "2099-01-01T00:00:00+00:00" })

  test("a valid submit stores the password in the keychain — never in the token file", async () => {
    await submitCredentialResponse(pasqalSubmit, { pasqalSpawn: scripted(0, validatorLine()).spawn })
    expect(secretStore.read(PASQAL_SECRET_ACCOUNT)).toEqual({ username: PASQAL.username, password: PASQAL.password })
    // the credential file carries only project_id + token + expiry — no password field
    expect(Object.keys(readCredential("pasqal-cloud") ?? {}).sort()).toEqual(["expires_at", "project_id", "token"])
    expect(JSON.stringify(readCredential("pasqal-cloud"))).not.toContain(PASQAL.password)
  })

  test("expired token + stored password → silent re-mint to connected, fresh token on disk", async () => {
    await submitCredentialResponse(pasqalSubmit, { pasqalSpawn: scripted(0, expiredLine).spawn })
    expect(pasqalEntry(statusResponse()).state).toBe("expired") // pre-condition: aged out
    const { calls, spawn } = scripted(0, freshLine)
    const parsed = JSON.parse(await revalidateResponse(JSON.stringify({ id: "pasqal-cloud" }), { pasqalSpawn: spawn }))
    expect(calls).toHaveLength(1) // the validator DID re-run
    expect(calls[0].env.PASQAL_PASSWORD).toBe(PASQAL.password) // password rode the child env, not argv
    expect(calls[0].argv.join(" ")).not.toContain(PASQAL.password)
    expect(parsed.connection.state).toBe("connected")
    expect(readCredential("pasqal-cloud")?.token).toBe("tok-reminted") // token file refreshed
  })

  test("silent re-auth rejected (password changed/revoked) → keychain + token wiped, needs-key", async () => {
    await submitCredentialResponse(pasqalSubmit, { pasqalSpawn: scripted(0, expiredLine).spawn })
    const parsed = JSON.parse(await revalidateResponse(JSON.stringify({ id: "pasqal-cloud" }), { pasqalSpawn: scripted(2).spawn }))
    expect(parsed.connection.state).toBe("needs-key")
    expect(readCredential("pasqal-cloud")).toBeUndefined() // dead token cleared
    expect(secretStore.read(PASQAL_SECRET_ACCOUNT)).toBeUndefined() // dead password cleared
  })

  test("silent re-auth unreachable → the expired claim + token + password all STAND (offline, not a verdict)", async () => {
    await submitCredentialResponse(pasqalSubmit, { pasqalSpawn: scripted(0, expiredLine).spawn })
    const parsed = JSON.parse(await revalidateResponse(JSON.stringify({ id: "pasqal-cloud" }), { pasqalSpawn: scripted(3).spawn }))
    expect(parsed.connection.state).toBe("expired") // unreachable is never a credential verdict
    expect(readCredential("pasqal-cloud")?.token).toBe("tok-pasqal-minted") // token kept
    expect(secretStore.read(PASQAL_SECRET_ACCOUNT)).not.toBeUndefined() // password kept for the next try
  })

  test("disconnect wipes the keychain password too — the secret never outlives the connection", async () => {
    await submitCredentialResponse(pasqalSubmit, { pasqalSpawn: scripted(0, validatorLine()).spawn })
    expect(secretStore.read(PASQAL_SECRET_ACCOUNT)).not.toBeUndefined()
    disconnectResponse(JSON.stringify({ id: "pasqal-cloud" }))
    expect(secretStore.read(PASQAL_SECRET_ACCOUNT)).toBeUndefined()
  })

  test("re-minted token never appears in the rendered response (secret-free contract holds through re-auth)", async () => {
    await submitCredentialResponse(pasqalSubmit, { pasqalSpawn: scripted(0, expiredLine).spawn })
    const body = await revalidateResponse(JSON.stringify({ id: "pasqal-cloud" }), { pasqalSpawn: scripted(0, freshLine).spawn })
    expect(body).not.toContain("tok-reminted")
    expect(body).not.toContain(PASQAL.password)
  })
})

describe("pasqal disconnect (169)", () => {
  test("disconnect clears the token credential through the #162 seam; status becomes needs-key; idempotent", async () => {
    await submitCredentialResponse(pasqalSubmit, { pasqalSpawn: scripted(0, validatorLine()).spawn })
    expect(readCredential("pasqal-cloud")).toBeDefined()
    const parsed = JSON.parse(disconnectResponse(JSON.stringify({ id: "pasqal-cloud" })))
    expect(parsed.ok).toBe(true)
    expect(parsed.connection).toMatchObject({ id: "pasqal-cloud", state: "needs-key", validated_at: null, stale: false })
    expect(readCredential("pasqal-cloud")).toBeUndefined()
    expect(existsSync(path.join(dir, "pasqal.json"))).toBe(false)
    // the company card is untouched by a pasqal disconnect
    expect(JSON.parse(statusResponse()).connections[0].id).toBe("company-compute")
    // idempotent: a second disconnect is a no-op success
    expect(JSON.parse(disconnectResponse(JSON.stringify({ id: "pasqal-cloud" }))).ok).toBe(true)
  })
})

describe("pasqal — password never at rest, whatever the outcome (169 AC3)", () => {
  /** every byte of every file under the test's credential/ops tree */
  const scanAllFiles = (root: string): string => {
    if (!existsSync(root)) return ""
    const chunks: string[] = []
    for (const entry of readdirSync(root, { recursive: true }) as string[]) {
      const full = path.join(root, String(entry))
      if (!statSync(full).isFile()) continue
      chunks.push(readFileSync(full, "latin1")) // raw bytes — encoding cannot hide the needle
    }
    return chunks.join("\n")
  }

  test("after the FULL flow including every failure class, an adversarial scan finds no password/username", async () => {
    const flows: PasqalSpawn[] = [
      scripted(0, validatorLine({ token: null, expires_at: null })).spawn, // session-only
      scripted(2).spawn, // invalid credentials
      scripted(3).spawn, // unreachable
      scripted(4).spawn, // project-unauthorized
      scripted(1).spawn, // config class
      scripted(0, "garbage not json").spawn, // off-contract stdout
      async () => {
        throw new Error(`spawn ENOENT (${PASQAL.password})`) // a leaky error must not propagate
      },
      scripted(0, validatorLine()).spawn, // valid + token LAST: real artifacts stay on disk for the scan
    ]
    for (const pasqalSpawn of flows) {
      const raw = await submitCredentialResponse(pasqalSubmit, { pasqalSpawn })
      expect(raw).not.toContain(PASQAL.password) // no response ever echoes it either
    }
    await revalidateResponse(JSON.stringify({ id: "pasqal-cloud" }))
    // the disk truth: token artifacts exist, the password is NOWHERE
    expect(readCredential("pasqal-cloud")?.token).toBe("tok-pasqal-minted")
    const bytes = scanAllFiles(dir)
    expect(bytes).toContain("tok-pasqal-minted") // the scan sees the real artifacts…
    expect(bytes).not.toContain(PASQAL.password) // …but never the password
    expect(bytes).not.toContain(PASQAL.username) // and never the username
    // the in-memory stores a future response could render from are clean too
    const stores = JSON.stringify([[...inflightOverlay.entries()], [...sessionOnlyOverlay.entries()]])
    expect(stores).not.toContain(PASQAL.password)
    expect(stores).not.toContain(PASQAL.username)
  })

  test("disconnect after the flow leaves a scrubbed tree — and still no secret anywhere", async () => {
    await submitCredentialResponse(pasqalSubmit, { pasqalSpawn: scripted(0, validatorLine()).spawn })
    disconnectResponse(JSON.stringify({ id: "pasqal-cloud" }))
    expect(readCredential("pasqal-cloud")).toBeUndefined()
    const bytes = scanAllFiles(dir)
    expect(bytes).not.toContain(PASQAL.password)
    expect(bytes).not.toContain(PASQAL.username)
    expect(bytes).not.toContain("tok-pasqal-minted") // disconnect removed the token artifact too
  })
})

// --- Resilience (amicode#170 / parent #159): mtime staleness, background
// revalidation, offline boots, drift, expiry. GETs always render the cache
// IMMEDIATELY; refresh work rides a background task the tests JOIN via
// backgroundRevalidationsSettled() — never a sleep, never a live probe.

describe("mtime staleness — a hand-edited credential file marks the claim stale (170 AC1)", () => {
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000)

  test("credential file mtime newer than validated_at → stale even inside the 24h window (pure rule)", () => {
    writeCredential("company-compute", cloudCredential)
    const at = minutesAgo(60) // validated 1h ago — fresh by the 24h rule alone
    writeFileSync(
      connectionsFile(),
      JSON.stringify({ "company-compute": { state: "connected", validated_at: at.toISOString() } }),
    )
    const staleFor = (mtime: number | undefined) =>
      JSON.parse(
        statusBody({
          file: connectionsFile(),
          overlay: new Map(),
          hasCredential: () => true,
          credentialMtime: () => mtime,
        }),
      ).connections[0].stale
    expect(staleFor(undefined)).toBe(false) // no file mtime bound (pure builder) → the 24h rule alone
    expect(staleFor(minutesAgo(90).getTime())).toBe(false) // written BEFORE validation — the normal connect order
    expect(staleFor(minutesAgo(30).getTime())).toBe(true) // hand-edited AFTER validation → stale
    // the submit's own write order (credential file saved moments around the
    // validation stamp) stays inside the slack — never a false stale
    expect(staleFor(at.getTime() + 1_000)).toBe(false)
  })

  test("mtime never marks non-connected states stale", () => {
    writeFileSync(
      connectionsFile(),
      JSON.stringify({
        "company-compute": { state: "invalid", validated_at: minutesAgo(60).toISOString() },
        "pasqal-cloud": { state: "expired", validated_at: minutesAgo(60).toISOString() },
      }),
    )
    const parsed = JSON.parse(
      statusBody({
        file: connectionsFile(),
        overlay: new Map(),
        hasCredential: () => true,
        credentialMtime: () => Date.now(),
      }),
    )
    for (const id of ["company-compute", "pasqal-cloud"]) {
      expect(parsed.connections.find((entry: { id: string }) => entry.id === id).stale).toBe(false)
    }
  })

  test("statusResponse binds the REAL file mtime, renders the cache immediately, and fires ONE non-blocking background revalidate", async () => {
    writeCredential("company-compute", cloudCredential)
    const at = minutesAgo(60)
    writeFileSync(
      connectionsFile(),
      JSON.stringify({
        "company-compute": { state: "connected", validated_at: at.toISOString(), identity: "team-alpha" },
      }),
    )
    const edited = minutesAgo(30) // hand-edit landed after the validation
    utimesSync(path.join(dir, "cloud.json"), edited, edited)

    let release!: (v: { status: number }) => void
    let probes = 0
    const gated: FetchImpl = () => {
      probes++
      return new Promise((resolve) => (release = resolve))
    }

    // the GET renders the cached claim AT ONCE — stale-marked, never blocked
    // on the probe, never flipped to "validating"
    const first = JSON.parse(statusResponse({ fetchImpl: gated })).connections[0]
    expect(first.state).toBe("connected")
    expect(first.stale).toBe(true)
    expect(first.validated_at).toBe(at.toISOString())
    expect(probes).toBe(1) // the background revalidate kicked off the stored credential

    // concurrent GETs render the same cache and never double-kick
    const second = JSON.parse(statusResponse({ fetchImpl: gated })).connections[0]
    expect(second.state).toBe("connected")
    expect(probes).toBe(1)

    release({ status: 200 }) // whoami 200 → valid (amicode#178 semantics)
    await backgroundRevalidationsSettled()

    const refreshed = JSON.parse(statusResponse({ fetchImpl: gated })).connections[0]
    expect(refreshed.state).toBe("connected")
    expect(refreshed.stale).toBe(false) // validated_at now outranks the edit mtime
    expect(Date.parse(refreshed.validated_at)).toBeGreaterThan(at.getTime())
    expect(refreshed.identity).toBe("team-alpha") // metadata survives the background refresh
    expect(probes).toBe(1) // fresh again — no further kick
  })

  test("the background revalidate probes the CURRENT file's credential — the hand-edit is what gets validated", async () => {
    writeCredential("company-compute", cloudCredential)
    writeCredential("company-compute", { base_url: "https://edited.example.co", token: "tok-hand-edited" })
    const at = minutesAgo(60)
    writeFileSync(
      connectionsFile(),
      JSON.stringify({ "company-compute": { state: "connected", validated_at: at.toISOString() } }),
    )
    let seenAuth = ""
    let seenUrl = ""
    const capture: FetchImpl = async (url, init) => {
      seenUrl = url
      seenAuth = init.headers.authorization ?? ""
      return { status: 200 }
    }
    statusResponse({ fetchImpl: capture })
    await backgroundRevalidationsSettled()
    expect(seenUrl).toBe("https://edited.example.co/solves/whoami")
    expect(seenAuth).toBe("Bearer tok-hand-edited")
  })

  test("hand-edited pasqal.json → stale; the background freshness check refreshes it locally (no validator, no network)", async () => {
    await submitCredentialResponse(pasqalSubmit, { pasqalSpawn: scripted(0, validatorLine()).spawn })
    const cache = JSON.parse(readFileSync(connectionsFile(), "utf8"))
    const at = minutesAgo(60)
    cache["pasqal-cloud"].validated_at = at.toISOString()
    writeFileSync(connectionsFile(), JSON.stringify(cache))
    const edited = minutesAgo(30)
    utimesSync(path.join(dir, "pasqal.json"), edited, edited)

    const first = pasqalEntry(statusResponse())
    expect(first.state).toBe("connected")
    expect(first.stale).toBe(true)
    await backgroundRevalidationsSettled()

    const refreshed = pasqalEntry(statusResponse())
    expect(refreshed.state).toBe("connected")
    expect(refreshed.stale).toBe(false)
    expect(Date.parse(refreshed.validated_at)).toBeGreaterThan(at.getTime())
    expect(refreshed.devices).toEqual([{ name: "EMU_FREE" }, { name: "FRESNEL" }]) // metadata kept
  })

  test("no background kick for an unparseable credential file — there is nothing to revalidate", async () => {
    let probes = 0
    const counting: FetchImpl = async () => {
      probes++
      return { status: 200 }
    }
    writeFileSync(path.join(dir, "cloud.json"), "corrupt {{{ not json")
    writeFileSync(
      connectionsFile(),
      JSON.stringify({
        "company-compute": {
          state: "connected",
          validated_at: new Date(Date.now() - STALE_MS - 60_000).toISOString(),
        },
      }),
    )
    expect(JSON.parse(statusResponse({ fetchImpl: counting })).connections[0].state).toBe("needs-key")
    await backgroundRevalidationsSettled()
    expect(probes).toBe(0)
  })

  test("no background kick without a credential, while validating, or for a session-only claim", async () => {
    let probes = 0
    const counting: FetchImpl = async () => {
      probes++
      return { status: 200 }
    }
    // stale connected cache, but the credential file is GONE → needs-key, no kick
    writeFileSync(
      connectionsFile(),
      JSON.stringify({
        "company-compute": {
          state: "connected",
          validated_at: new Date(Date.now() - STALE_MS - 60_000).toISOString(),
        },
      }),
    )
    expect(JSON.parse(statusResponse({ fetchImpl: counting })).connections[0].state).toBe("needs-key")
    // in-flight overlay wins → validating, no second probe behind it
    writeCredential("company-compute", cloudCredential)
    inflightOverlay.set("company-compute", { state: "validating" })
    expect(JSON.parse(statusResponse({ fetchImpl: counting })).connections[0].state).toBe("validating")
    inflightOverlay.clear()
    disconnectResponse(JSON.stringify({ id: "company-compute" })) // back to needs-key so only pasqal is in play below
    // session-only pasqal claim (nothing at rest to re-check) → no kick
    sessionOnlyOverlay.set("pasqal-cloud", {
      state: "connected",
      validated_at: new Date(Date.now() - STALE_MS - 60_000).toISOString(),
      identity: "proj-1",
    })
    const session = pasqalEntry(statusResponse({ fetchImpl: counting }))
    expect(session.state).toBe("connected")
    expect(session.session_only).toBe(true)
    await backgroundRevalidationsSettled()
    expect(probes).toBe(0)
  })
})

describe("unparseable credential file → needs-key, honestly (170 AC2)", () => {
  const corruptions = ["not json {{{", "", "42", '"just-a-string"', '{"base_url": 7, "token": null}', "[]"]

  test("company-compute: an existing-but-corrupt cloud.json renders needs-key — never a crash, a stale badge, or 'connected'", () => {
    for (const bytes of corruptions) {
      writeFileSync(path.join(dir, "cloud.json"), bytes)
      // even with a cache still claiming connected (validated long ago, file
      // mtime newer — every staleness trigger armed at once)
      writeFileSync(
        connectionsFile(),
        JSON.stringify({
          "company-compute": {
            state: "connected",
            validated_at: new Date(Date.now() - STALE_MS - 60_000).toISOString(),
            identity: "team-alpha",
          },
        }),
      )
      const parsed = JSON.parse(statusResponse())
      expect(parsed.ok).toBe(true)
      const entry = parsed.connections[0]
      expect(entry.state).toBe("needs-key")
      expect(entry.stale).toBe(false)
      expect(entry.validated_at).toBeNull()
      expect(entry.identity).toBeUndefined() // a claim without a usable credential carries no identity
    }
  })

  test("pasqal-cloud: a corrupt pasqal.json renders needs-key too — and a bare corrupt file without any cache as well", () => {
    for (const bytes of corruptions) {
      writeFileSync(path.join(dir, "pasqal.json"), bytes)
      writeFileSync(
        connectionsFile(),
        JSON.stringify({
          "pasqal-cloud": { state: "connected", validated_at: new Date().toISOString(), identity: "proj-1" },
        }),
      )
      expect(pasqalEntry(statusResponse()).state).toBe("needs-key")
      // no cache entry at all: still needs-key, still no throw
      writeFileSync(connectionsFile(), "{}")
      const bare = pasqalEntry(statusResponse())
      expect(bare.state).toBe("needs-key")
      expect(bare.stale).toBe(false)
    }
  })

  test("a corrupt credential file never flips a mutation response into a lie either", async () => {
    writeFileSync(path.join(dir, "cloud.json"), "corrupt {{{")
    const parsed = JSON.parse(await revalidateResponse(JSON.stringify({ id: "company-compute" })))
    expect(parsed.ok).toBe(true)
    expect(parsed.connection.state).toBe("needs-key") // unreadable = absent through the #162 seam; no probe fired
  })
})

describe("offline boot — last-verified rendering, never invalid (170 AC3)", () => {
  const boom: FetchImpl = async () => {
    throw new Error("connect ECONNREFUSED 10.0.0.1:443")
  }
  const lastVerified = new Date(Date.now() - STALE_MS - 60_000).toISOString()

  const seedConnected = () => {
    writeCredential("company-compute", cloudCredential)
    writeFileSync(
      connectionsFile(),
      JSON.stringify({
        "company-compute": { state: "connected", validated_at: lastVerified, identity: "team-alpha" },
      }),
    )
  }

  test("stored credential + connected cache + unreachable service → connected, stale, offline; validated_at is the last-verified marker", async () => {
    seedConnected()
    // boot GET: the cached claim renders at once (no offline verdict yet)
    const first = JSON.parse(statusResponse({ fetchImpl: boom })).connections[0]
    expect(first.state).toBe("connected")
    expect(first.stale).toBe(true)
    expect(first.offline).toBeUndefined()
    await backgroundRevalidationsSettled()

    // the failed background revalidation marks offline — it NEVER downgrades
    // the state and NEVER refreshes the last-verified timestamp
    const offline = JSON.parse(statusResponse({ fetchImpl: boom })).connections[0]
    expect(offline.state).toBe("connected") // never 'invalid', never 'unreachable'
    expect(offline.stale).toBe(true)
    expect(offline.offline).toBe(true)
    expect(offline.validated_at).toBe(lastVerified) // "last verified <validated_at>"
    expect(offline.identity).toBe("team-alpha") // "…as <identity>"
    // the stored credential is never cleared by an offline revalidation
    expect(readCredential("company-compute")).toEqual(cloudCredential)
    await backgroundRevalidationsSettled()
  })

  test("the service coming back clears offline: the next GET's background refresh reconnects and refreshes the timestamp", async () => {
    seedConnected()
    statusResponse({ fetchImpl: boom })
    await backgroundRevalidationsSettled()
    expect(JSON.parse(statusResponse({ fetchImpl: respond(200) })).connections[0].offline).toBe(true) // still the cache
    await backgroundRevalidationsSettled()
    const recovered = JSON.parse(statusResponse({ fetchImpl: respond(200) })).connections[0]
    expect(recovered.state).toBe("connected")
    expect(recovered.offline).toBeUndefined()
    expect(recovered.stale).toBe(false)
    expect(Date.parse(recovered.validated_at)).toBeGreaterThan(Date.parse(lastVerified))
    expect(recovered.identity).toBe("team-alpha")
  })

  test("offline is a connected-only presentation flag: it never rides needs-key or failure states", async () => {
    seedConnected()
    statusResponse({ fetchImpl: boom })
    await backgroundRevalidationsSettled()
    // key actually revoked later: a manual revalidate answering 401 is truthful…
    const invalid = JSON.parse(
      await revalidateResponse(JSON.stringify({ id: "company-compute" }), { fetchImpl: respond(401) }),
    )
    expect(invalid.connection.state).toBe("invalid")
    expect(invalid.connection.offline).toBeUndefined()
    // …and once the credential file goes away, needs-key carries no offline residue
    disconnectResponse(JSON.stringify({ id: "company-compute" }))
    const gone = JSON.parse(statusResponse({ fetchImpl: boom })).connections[0]
    expect(gone.state).toBe("needs-key")
    expect(gone.offline).toBeUndefined()
  })
})

describe("submitter identity echo + drift diff (170 AC4, live endpoint aws-infra#185)", () => {
  // The stubbed identity endpoint: the SAME probe response, now carrying a
  // JSON body with a submitter — exactly what aws-infra#185 will serve live.
  const answering =
    (submitter: unknown, status = 200): FetchImpl =>
    async () => ({ status, json: async () => ({ submitter }) })
  const revalidate = (fetchImpl: FetchImpl) =>
    revalidateResponse(JSON.stringify({ id: "company-compute" }), { fetchImpl })

  test("probe surfaces the submitter echo when the response carries one; tolerant to everything else", async () => {
    const url = "https://solves.example.co"
    expect(await probeCompanyCompute(url, "tok", answering("team-alpha"))).toEqual({
      outcome: "valid",
      submitter: "team-alpha",
    })
    // no json seam (services predating #185), a broken body, an off-shape
    // body, a non-string or empty submitter — all still a plain valid
    expect(await probeCompanyCompute(url, "tok", respond(204))).toEqual({ outcome: "valid" })
    const broken: FetchImpl = async () => ({
      status: 200,
      json: async () => {
        throw new Error("no body")
      },
    })
    expect(await probeCompanyCompute(url, "tok", broken)).toEqual({ outcome: "valid" })
    const offShape: FetchImpl = async () => ({ status: 200, json: async () => ["not-an-object"] })
    expect(await probeCompanyCompute(url, "tok", offShape)).toEqual({ outcome: "valid" })
    expect(await probeCompanyCompute(url, "tok", answering(42))).toEqual({ outcome: "valid" })
    expect(await probeCompanyCompute(url, "tok", answering(""))).toEqual({ outcome: "valid" })
    // a rejected key reads NO identity — the body of a 401 is untrusted
    expect(await probeCompanyCompute(url, "tok", answering("mallory", 401))).toEqual({ outcome: "invalid" })
  })

  test("submit with an identity echo → 'Connected as <submitter>': identity in the response AND the cache", async () => {
    const parsed = JSON.parse(await submitCredentialResponse(validSubmit, { fetchImpl: answering("team-alpha") }))
    expect(parsed.ok).toBe(true)
    expect(parsed.connection.state).toBe("connected")
    expect(parsed.connection.identity).toBe("team-alpha")
    expect(parsed.connection.identity_drift).toBeUndefined()
    const entry = JSON.parse(statusResponse()).connections[0]
    expect(entry.identity).toBe("team-alpha")
    expect(entry.identity_drift).toBeUndefined()
  })

  test("a revalidation answering a DIFFERENT submitter → explicit diff; the STORED identity is the record (AC4)", async () => {
    await submitCredentialResponse(validSubmit, { fetchImpl: answering("team-alpha") })
    const drifted = JSON.parse(await revalidate(answering("team-beta")))
    expect(drifted.connection.state).toBe("connected")
    expect(drifted.connection.identity).toBe("team-alpha") // the record — never silently overwritten
    expect(drifted.connection.identity_drift).toBe("team-beta") // what the key answers as NOW
    // the record survives on disk exactly as stored; the drift rides beside it
    const cache = JSON.parse(readFileSync(connectionsFile(), "utf8"))["company-compute"]
    expect(cache.identity).toBe("team-alpha")
    expect(cache.identity_drift).toBe("team-beta")
    // and the credential itself was never touched
    expect(readCredential("company-compute")).toEqual({ base_url: "https://solves.example.co", token: "tok-good" })
  })

  test("drift lands via the BACKGROUND revalidation too — the incident's silent path now surfaces", async () => {
    await submitCredentialResponse(validSubmit, { fetchImpl: answering("team-alpha") })
    const cache = JSON.parse(readFileSync(connectionsFile(), "utf8"))
    cache["company-compute"].validated_at = new Date(Date.now() - STALE_MS - 60_000).toISOString()
    writeFileSync(connectionsFile(), JSON.stringify(cache))
    statusResponse({ fetchImpl: answering("team-beta") }) // stale GET kicks the refresh
    await backgroundRevalidationsSettled()
    const entry = JSON.parse(statusResponse()).connections[0]
    expect(entry.state).toBe("connected")
    expect(entry.stale).toBe(false)
    expect(entry.identity).toBe("team-alpha")
    expect(entry.identity_drift).toBe("team-beta")
  })

  test("agreement clears the drift; an echo-less revalidation leaves record AND drift standing", async () => {
    await submitCredentialResponse(validSubmit, { fetchImpl: answering("team-alpha") })
    await revalidate(answering("team-beta")) // drift recorded
    const silent = JSON.parse(await revalidate(respond(200))) // no echo: nothing to reconcile with
    expect(silent.connection.identity).toBe("team-alpha")
    expect(silent.connection.identity_drift).toBe("team-beta")
    const agreed = JSON.parse(await revalidate(answering("team-alpha"))) // answers as the record again
    expect(agreed.connection.identity).toBe("team-alpha")
    expect(agreed.connection.identity_drift).toBeUndefined()
  })

  test("re-submitting credentials is the human reconciliation: the record RESETS and the drift clears", async () => {
    await submitCredentialResponse(validSubmit, { fetchImpl: answering("team-alpha") })
    await revalidate(answering("team-beta"))
    const resubmitted = JSON.parse(await submitCredentialResponse(validSubmit, { fetchImpl: answering("team-beta") }))
    expect(resubmitted.connection.state).toBe("connected")
    expect(resubmitted.connection.identity).toBe("team-beta")
    expect(resubmitted.connection.identity_drift).toBeUndefined()
  })

  test("POISON: a poisoned identity echo smuggles nothing — only the submitter string is read", async () => {
    await submitCredentialResponse(validSubmit, { fetchImpl: answering("team-alpha") })
    const poisoned: FetchImpl = async () => ({
      status: 200,
      json: async () => ({ submitter: "team-beta", token: "POISON-echo", password: "POISON-echo-password" }),
    })
    const raw = await revalidateResponse(JSON.stringify({ id: "company-compute" }), { fetchImpl: poisoned })
    expect(raw).not.toContain("POISON")
    expect(JSON.parse(raw).connection.identity_drift).toBe("team-beta")
    expect(readFileSync(connectionsFile(), "utf8")).not.toContain("POISON")
  })
})

describe("past expiry renders the reconnect prompt (170 AC5)", () => {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()

  test("company-compute: a connected claim whose expires_at has passed renders 'expired' at read time; credential KEPT", () => {
    writeCredential("company-compute", cloudCredential)
    writeFileSync(
      connectionsFile(),
      JSON.stringify({
        "company-compute": {
          state: "connected",
          validated_at: new Date().toISOString(),
          expires_at: yesterday,
          identity: "team-alpha",
        },
      }),
    )
    const entry = JSON.parse(statusResponse()).connections[0]
    expect(entry.state).toBe("expired") // the reconnect prompt state — same rendering pasqal ships
    expect(entry.stale).toBe(false) // expiry is its own state, never a staleness cue
    expect(entry.expires_at).toBe(yesterday)
    expect(entry.identity).toBe("team-alpha") // the record survives for the reconnect
    // reconnect ≠ disconnect: the expired credential stays on disk
    expect(readCredential("company-compute")).toEqual(cloudCredential)
  })

  test("company-compute: an unexpired expires_at keeps connected; unparseable expiry is ignored (honest minimum)", () => {
    writeCredential("company-compute", cloudCredential)
    for (const expires_at of [tomorrow, "not-a-date"]) {
      writeFileSync(
        connectionsFile(),
        JSON.stringify({
          "company-compute": { state: "connected", validated_at: new Date().toISOString(), expires_at },
        }),
      )
      expect(JSON.parse(statusResponse()).connections[0].state).toBe("connected")
    }
  })

  test("pasqal: a token that ages past its expiry renders 'expired' at read time — no revalidate needed (parity)", async () => {
    const pastExpiry = validatorLine({ expires_at: yesterday })
    await submitCredentialResponse(pasqalSubmit, { pasqalSpawn: scripted(0, pastExpiry).spawn })
    const entry = pasqalEntry(statusResponse())
    expect(entry.state).toBe("expired")
    // the token artifact survives — reconnecting mints a fresh one over it
    expect(readCredential("pasqal-cloud")?.token).toBe("tok-pasqal-minted")
  })

  test("expired never kicks a background revalidate and never renders offline residue", async () => {
    let probes = 0
    const counting: FetchImpl = async () => {
      probes++
      return { status: 200 }
    }
    writeCredential("company-compute", cloudCredential)
    writeFileSync(
      connectionsFile(),
      JSON.stringify({
        "company-compute": {
          state: "connected",
          validated_at: new Date(Date.now() - STALE_MS - 60_000).toISOString(), // stale AND expired
          expires_at: yesterday,
          offline: true, // leftover marker from an offline stretch
        },
      }),
    )
    const entry = JSON.parse(statusResponse({ fetchImpl: counting })).connections[0]
    expect(entry.state).toBe("expired")
    expect(entry.offline).toBeUndefined() // offline is connected-only
    await backgroundRevalidationsSettled()
    expect(probes).toBe(0) // an expired claim re-enters via the form, not a probe
  })
})

// #194 two-step project picker: username+password → the validator LIST mode
// returns the caller's projects (a one-shot choose-project response held by the
// panel, NOT persisted into GET status); choose-project then connects to the
// picked project with the held credential. The staged validator's LIST output
// is {ok, mode:"list", projects, token, expires_at}; CONNECT output is the
// existing project-bound line.
describe("pasqal two-step project picker (#194)", () => {
  // A validator stub that mirrors the real one: PASQAL_PROJECT_ID empty → LIST
  // mode; set → CONNECT mode. Records calls so we can assert the secret path.
  function twoStepSpawn() {
    const calls: { argv: string[]; env: Record<string, string> }[] = []
    const spawn: PasqalSpawn = async (argv, env) => {
      calls.push({ argv: [...argv], env: { ...env } })
      if ((env.PASQAL_PROJECT_ID ?? "") === "") {
        return {
          exitCode: 0,
          stdout:
            JSON.stringify({
              ok: true,
              mode: "list",
              projects: [
                { id: "proj-mis", name: "MIS ladder" },
                { id: "proj-sandbox", name: "Hackathon sandbox" },
              ],
              token: "tok-list",
              expires_at: "2099-01-01T00:00:00+00:00",
            }) + "\n",
        }
      }
      return {
        exitCode: 0,
        stdout:
          JSON.stringify({
            ok: true,
            project_id: env.PASQAL_PROJECT_ID,
            devices: ["EMU_FREE", "FRESNEL"],
            token: "tok-" + env.PASQAL_PROJECT_ID,
            expires_at: "2099-01-01T00:00:00+00:00",
          }) + "\n",
      }
    }
    return { calls, spawn }
  }

  const creds = JSON.stringify({ id: "pasqal-cloud", username: PASQAL.username, password: PASQAL.password })

  test("no project_id → LIST mode → choose-project response with the projects, nothing at rest", async () => {
    const { spawn } = twoStepSpawn()
    const parsed = JSON.parse(await submitCredentialResponse(creds, { pasqalSpawn: spawn }))
    expect(parsed.ok).toBe(true)
    expect(parsed.connection.state).toBe("choose-project")
    expect(parsed.connection.identity).toBe(PASQAL.username)
    expect(parsed.connection.projects).toEqual([
      { id: "proj-mis", name: "MIS ladder" },
      { id: "proj-sandbox", name: "Hackathon sandbox" },
    ])
    // nothing persisted, nothing in the keychain YET (project not chosen)
    expect(readCredential("pasqal-cloud")).toBeUndefined()
    expect(secretStore.read(PASQAL_SECRET_ACCOUNT)).toBeUndefined()
    expect(pasqalEntry(statusResponse()).state).toBe("needs-key") // GET is unaware of the transient pick
  })

  test("choose-project connects to the PICKED project, storing token + keychain password", async () => {
    const { calls, spawn } = twoStepSpawn()
    await submitCredentialResponse(creds, { pasqalSpawn: spawn }) // list
    const parsed = JSON.parse(
      await chooseProjectResponse(JSON.stringify({ id: "pasqal-cloud", project_id: "proj-sandbox" }), {
        pasqalSpawn: spawn,
      }),
    )
    expect(parsed.connection.state).toBe("connected")
    expect(parsed.connection.identity).toBe("proj-sandbox")
    expect(readCredential("pasqal-cloud")).toEqual({
      project_id: "proj-sandbox",
      token: "tok-proj-sandbox",
      expires_at: "2099-01-01T00:00:00+00:00",
    })
    expect(secretStore.read(PASQAL_SECRET_ACCOUNT)).toEqual({ username: PASQAL.username, password: PASQAL.password })
    // the password rode the connect spawn's env, never argv or the response
    const connectCall = calls.find((c) => c.env.PASQAL_PROJECT_ID === "proj-sandbox")!
    expect(connectCall.env.PASQAL_PASSWORD).toBe(PASQAL.password)
    expect(connectCall.argv.join(" ")).not.toContain(PASQAL.password)
    expect(JSON.stringify(parsed)).not.toContain(PASQAL.password)
    expect(JSON.stringify(parsed)).not.toContain("tok-proj-sandbox")
  })

  test("choosing an off-list project is refused; the picker stands", async () => {
    const { spawn } = twoStepSpawn()
    await submitCredentialResponse(creds, { pasqalSpawn: spawn })
    const parsed = JSON.parse(
      await chooseProjectResponse(JSON.stringify({ id: "pasqal-cloud", project_id: "proj-not-mine" }), {
        pasqalSpawn: spawn,
      }),
    )
    expect(parsed.connection.state).toBe("choose-project") // still choosing
    expect(parsed.error).toContain("invalid_project")
    expect(readCredential("pasqal-cloud")).toBeUndefined()
  })

  test("choose-project with no pending selection → actionable error, never a crash", async () => {
    const parsed = JSON.parse(await chooseProjectResponse(JSON.stringify({ id: "pasqal-cloud", project_id: "proj-mis" })))
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toContain("no_pending_selection")
  })

  test("disconnect during the pick clears the pending selection (no dangling secret)", async () => {
    const { spawn } = twoStepSpawn()
    await submitCredentialResponse(creds, { pasqalSpawn: spawn })
    disconnectResponse(JSON.stringify({ id: "pasqal-cloud" }))
    // after cancel, a choose attempt finds nothing pending
    const parsed = JSON.parse(await chooseProjectResponse(JSON.stringify({ id: "pasqal-cloud", project_id: "proj-mis" })))
    expect(parsed.error).toContain("no_pending_selection")
    expect(secretStore.read(PASQAL_SECRET_ACCOUNT)).toBeUndefined()
  })

  test("an account with zero projects → distinct no_projects error, not an empty picker", async () => {
    const emptySpawn: PasqalSpawn = async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ ok: true, mode: "list", projects: [], token: "t", expires_at: null }) + "\n",
    })
    const parsed = JSON.parse(await submitCredentialResponse(creds, { pasqalSpawn: emptySpawn }))
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toContain("no_projects")
  })

  test("a project_id supplied up front still connects directly (token-paste / back-compat)", async () => {
    const { spawn } = twoStepSpawn()
    const parsed = JSON.parse(
      await submitCredentialResponse(
        JSON.stringify({ id: "pasqal-cloud", username: PASQAL.username, password: PASQAL.password, project_id: "proj-direct" }),
        { pasqalSpawn: spawn },
      ),
    )
    expect(parsed.connection.state).toBe("connected")
    expect(parsed.connection.identity).toBe("proj-direct")
  })
})

// --- Piccolo flip: the way BACK OUT of HP (opencode#78). #167 gave the tier a
// durable way IN — a valid credential grants `issimo` and requests the hp
// switch — but nothing ever wrote the other direction, so `connections.ts` had
// exactly one `switching` writer and it was hardcoded to hp. The toggle's
// Piccolo button wrote localStorage and left the ops dir on hp, which is why
// amico-run kept refusing local launches while the UI read "Piccolo".

describe("Piccolo flip — releasing the HP tier (opencode#78)", () => {
  test("selecting piccolo revokes issimo AND writes the piccolo switching request", async () => {
    await submitCredentialResponse(validSubmit, { fetchImpl: respond(200) }) // land in hp
    expect(readFileSync(entitlementsFile(), "utf8")).toBe('codes = ["issimo"]\n')

    const parsed = JSON.parse(solverModeResponse(JSON.stringify({ mode: "piccolo" })))
    expect(parsed.ok).toBe(true)
    expect(parsed.error).toBeNull()
    // both artifacts flip together: a piccolo request with `issimo` still
    // granted is the split-brain state #259's reconcileSolverMode heals
    // straight back to hp
    expect(readFileSync(entitlementsFile(), "utf8")).toBe("codes = []\n")
    expect(JSON.parse(readFileSync(solverModeFile(), "utf8"))).toEqual({ mode: "piccolo", status: "switching" })
  })
})

describe("Piccolo flip — the same guards every other mutation carries", () => {
  test("non-loopback bind is refused, and refuses INERTLY — an hp setup is left untouched", async () => {
    await submitCredentialResponse(validSubmit, { fetchImpl: respond(200) })
    const entitlementBytes = readFileSync(entitlementsFile(), "utf8")
    const modeBytes = readFileSync(solverModeFile(), "utf8")

    setBindHostname("0.0.0.0")
    const refused = JSON.parse(solverModeResponse(JSON.stringify({ mode: "piccolo" })))
    setBindHostname(undefined)

    expect(refused.ok).toBe(false)
    expect(refused.error).toContain("non_loopback")
    expect(readFileSync(entitlementsFile(), "utf8")).toBe(entitlementBytes)
    expect(readFileSync(solverModeFile(), "utf8")).toBe(modeBytes)
  })

  test("only release: {mode:'hp'} and malformed bodies are refused, and write nothing (ADR 0001 single hp writer)", async () => {
    mkdirSync(amicodeOpsDir(), { recursive: true })
    writeFileSync(solverModeFile(), JSON.stringify({ mode: "hp", status: "ready" }))
    writeFileSync(entitlementsFile(), 'codes = ["issimo"]\n')
    const entitlementBytes = readFileSync(entitlementsFile(), "utf8")
    const modeBytes = readFileSync(solverModeFile(), "utf8")

    const rejects = [
      JSON.stringify({ mode: "hp" }), // hp is granted by connecting a key, never by asking
      JSON.stringify({ mode: "nonsense" }),
      JSON.stringify({}),
      "not json {{{",
    ]
    for (const body of rejects) {
      const parsed = JSON.parse(solverModeResponse(body))
      expect(parsed.ok).toBe(false)
      expect(parsed.mode).toBeNull()
      expect(typeof parsed.error).toBe("string")
    }
    // an hp setup survives every one of them byte-for-byte
    expect(readFileSync(entitlementsFile(), "utf8")).toBe(entitlementBytes)
    expect(readFileSync(solverModeFile(), "utf8")).toBe(modeBytes)
  })
})

describe("Piccolo flip — release semantics mirror the grant (167 AC4 idiom)", () => {
  test("revoke PRESERVES every other code and the expired list — read-modify-write, byte-compatible", () => {
    mkdirSync(amicodeOpsDir(), { recursive: true })
    writeFileSync(entitlementsFile(), 'codes = ["pasqal-hackathon-2026", "issimo"]\nexpired = ["old-2025"]\n')
    solverModeResponse(JSON.stringify({ mode: "piccolo" }))
    expect(readFileSync(entitlementsFile(), "utf8")).toBe('codes = ["pasqal-hackathon-2026"]\nexpired = ["old-2025"]\n')
  })

  test("repeat release on an already-settled piccolo setup: the watcher is NOT poked again", () => {
    mkdirSync(amicodeOpsDir(), { recursive: true })
    writeFileSync(entitlementsFile(), "codes = []\n")
    writeFileSync(
      solverModeFile(),
      JSON.stringify({ mode: "piccolo", status: "ready", switched_at: new Date().toISOString() }),
    )
    const modeBytes = readFileSync(solverModeFile(), "utf8")
    expect(JSON.parse(solverModeResponse(JSON.stringify({ mode: "piccolo" }))).ok).toBe(true)
    expect(readFileSync(solverModeFile(), "utf8")).toBe(modeBytes) // no restart for a no-op
  })

  test("piccolo already selected but the grant LINGERS → the switch IS re-requested (the split-brain heal)", () => {
    mkdirSync(amicodeOpsDir(), { recursive: true })
    writeFileSync(solverModeFile(), JSON.stringify({ mode: "piccolo", status: "ready" }))
    writeFileSync(entitlementsFile(), 'codes = ["issimo"]\n') // exactly the state that stranded the tier
    solverModeResponse(JSON.stringify({ mode: "piccolo" }))
    expect(readFileSync(entitlementsFile(), "utf8")).toBe("codes = []\n")
    expect(JSON.parse(readFileSync(solverModeFile(), "utf8"))).toEqual({ mode: "piccolo", status: "switching" })
  })

  test("flip write failure → ok:false with a fixed, value-free warning (no path, no errno)", () => {
    writeFileSync(path.join(dir, "blocker-piccolo"), "")
    process.env.AMICODE_OPS_DIR = path.join(dir, "blocker-piccolo", "ops")
    const raw = solverModeResponse(JSON.stringify({ mode: "piccolo" }))
    expect(JSON.parse(raw).ok).toBe(false)
    expect(JSON.parse(raw).error).toStartWith("piccolo_flip_failed:")
    expect(raw).not.toContain(dir)
  })
})
