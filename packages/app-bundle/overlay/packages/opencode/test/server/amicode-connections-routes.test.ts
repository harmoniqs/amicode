// AMICODE: Connections ROUTE tests (amicode#165 AC6, plus AC2/AC3/AC5 at the
// route level) — the full Company Compute lifecycle against the same route
// tree standalone serve binds, with NO VSCode/extension host involved. A local
// node:http stub stands in for the solve service; the only network is
// loopback. Auth rides the same registration wrapper as every amicode route
// (per #163), asserted here with a configured password.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { ConfigProvider, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiApp } from "@/server/routes/instance/httpapi/server"
import { ServerAuth } from "@/server/auth"
import { readCredential, writeCredential } from "@/server/amicode/credentials"
import {
  backgroundRevalidationsSettled,
  connectionsFile,
  entitlementsFile,
  inflightOverlay,
  sessionOnlyOverlay,
  setBindHostname,
  solverModeFile,
  PASQAL_CONFIG_WARNING,
} from "@/server/amicode/connections"
import { inMemorySecretStore, setPasqalSecretStore } from "@/server/amicode/pasqal-secret"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances } from "../fixture/fixture"

// --- the in-process app over the SAME routes standalone serve binds
// (httpapi-instance-route-auth.test.ts idiom) ---
function app(input: { password?: string; username?: string } = {}) {
  const handler = HttpRouter.toWebHandler(
    HttpApiApp.routes.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            OPENCODE_SERVER_PASSWORD: input.password,
            OPENCODE_SERVER_USERNAME: input.username,
          }),
        ),
      ),
    ),
    { disableLogger: true },
  ).handler

  return {
    fetch: (request: Request) => handler(request, HttpApiApp.context),
    request(input: string | URL | Request, init?: RequestInit) {
      return this.fetch(input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init))
    },
  }
}

function basic(username: string, password: string) {
  return ServerAuth.header({ username, password }) ?? ""
}

// --- local stub solve service: answers the probe with a scripted status
// (and, when scripted, a JSON body — the aws-infra#185 identity-echo shape)
// and records what it saw, so tests can assert the token rode the header only
type StubSeen = { method: string; url: string; authorization: string | undefined }
async function stubSolveService(status: () => number, body?: () => string | undefined) {
  const seen: StubSeen[] = []
  const server = createServer((req, res) => {
    seen.push({ method: req.method ?? "", url: req.url ?? "", authorization: req.headers.authorization })
    res.statusCode = status()
    const payload = body?.()
    if (payload !== undefined) {
      res.setHeader("content-type", "application/json")
      res.end(payload)
      return
    }
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) })

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
  // pasqal-secret.ts exposes this so a sandbox/test run gets its own keychain
  // slot. Saved/restored here so a leak can never reach the real slot even if
  // the in-memory store below is ever removed.
  "AMICO_PASQAL_KEYCHAIN_SERVICE",
] as const
let savedEnv: Record<string, string | undefined>
let dir: string
let restoreSecretStore: () => void

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  // MANDATORY, not hygiene: the real store reaches @napi-rs/keyring's native
  // setPassword(), which segfaults Bun 1.3.14 when called from inside an Effect
  // route handler under `bun test` (harmoniqs/opencode#82). Production is
  // unaffected — the same write succeeds under `bun run … serve`. Without this
  // seam the whole `unit` job dies with exit 137 and reports nothing.
  restoreSecretStore = setPasqalSecretStore(inMemorySecretStore())
  dir = mkdtempSync(path.join(tmpdir(), "amicode-conn-routes-"))
  process.env.AMICO_CLOUD_FILE = path.join(dir, "cloud.json")
  process.env.AMICO_PASQAL_FILE = path.join(dir, "pasqal.json")
  // Token connections (#327) resolve credential files via AMICO_*_FILE — redirect
  // into the tmp dir so a real ~/.amico/<svc>.json never leaks a stored token
  // (an un-redirected slack.json fires a second background revalidate + hangs settle).
  process.env.AMICO_SLACK_FILE = path.join(dir, "slack.json")
  process.env.AMICO_GITHUB_FILE = path.join(dir, "github.json")
  process.env.AMICO_LINEAR_FILE = path.join(dir, "linear.json")
  process.env.AMICO_GOOGLE_FILE = path.join(dir, "google.json")
  process.env.AMICO_GOOGLE_DRIVE_FILE = path.join(dir, "google-drive.json")
  process.env.AMICODE_CONNECTIONS_FILE = path.join(dir, "connections.json")
  process.env.AMICODE_OPS_DIR = path.join(dir, "amicode-ops") // flip artifacts (#167) stay hermetic
  inflightOverlay.clear()
  sessionOnlyOverlay.clear()
  setBindHostname(undefined) // isolation from any listener another test file bound
})
afterEach(async () => {
  await backgroundRevalidationsSettled() // drain background refreshes BEFORE the env flips to the next test's dir
  restoreSecretStore?.()
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  inflightOverlay.clear()
  sessionOnlyOverlay.clear()
  setBindHostname(undefined)
})

describe("connections routes — full lifecycle, no extension host (AC6)", () => {
  test("needs-key → submit → connected → revalidate → disconnect → needs-key, one round trip each", async () => {
    const server = app()
    let probeStatus = 200 // whoami 200 → valid (amicode#178 semantics)
    const stub = await stubSolveService(() => probeStatus)
    try {
      const initial = await (await server.request("/amicode/connections")).json()
      expect(initial.ok).toBe(true)
      expect(initial.connections.map((connection: { id: string }) => connection.id)).toEqual([
        "company-compute",
        "pasqal-cloud",
        "slack",
        "github",
        "linear",
        "google",
        "google-drive",
      ])
      for (const connection of initial.connections) {
        expect(connection).toMatchObject({
          state: "needs-key",
          validated_at: null,
          stale: false,
          icon: expect.any(String),
          name: expect.any(String),
        })
      }

      // submit: secret rides the POST body (library idiom), never a query param
      const submitted = await (
        await server.request(
          "/amicode/connections/credential",
          post({ id: "company-compute", base_url: stub.url, token: "tok-lifecycle" }),
        )
      ).json()
      expect(submitted.ok).toBe(true)
      expect(submitted.connection.state).toBe("connected")
      expect(readCredential("company-compute")).toEqual({ base_url: stub.url, token: "tok-lifecycle" })
      expect(stub.seen).toHaveLength(1)
      expect(stub.seen[0].url).toBe("/solves/whoami")
      expect(stub.seen[0].url).not.toContain("tok-lifecycle")
      expect(stub.seen[0].authorization).toBe("Bearer tok-lifecycle")

      const connected = await (await server.request("/amicode/connections")).json()
      expect(connected.connections[0].state).toBe("connected")
      expect(connected.connections[0].stale).toBe(false)

      // revalidate: id-only body — the stored secret never rides the request (AC4)
      probeStatus = 200
      const revalidated = await (
        await server.request("/amicode/connections/revalidate", post({ id: "company-compute" }))
      ).json()
      expect(revalidated.connection.state).toBe("connected")
      expect(stub.seen).toHaveLength(2)
      expect(stub.seen[1].authorization).toBe("Bearer tok-lifecycle")

      const disconnected = await (
        await server.request("/amicode/connections/disconnect", post({ id: "company-compute" }))
      ).json()
      expect(disconnected.connection.state).toBe("needs-key")
      expect(readCredential("company-compute")).toBeUndefined()

      const final = await (await server.request("/amicode/connections")).json()
      expect(final.connections[0].state).toBe("needs-key")
    } finally {
      await stub.close()
    }
  })

  test("authorizer-rejecting service → invalid over the route; nothing written (AC2)", async () => {
    const server = app()
    const stub = await stubSolveService(() => 401)
    try {
      const rejected = await (
        await server.request(
          "/amicode/connections/credential",
          post({ id: "company-compute", base_url: stub.url, token: "tok-rejected" }),
        )
      ).json()
      expect(rejected.ok).toBe(true)
      expect(rejected.connection.state).toBe("invalid")
      expect(readCredential("company-compute")).toBeUndefined()
    } finally {
      await stub.close()
    }
  })

  test("a poisoned status-cache file never leaks through the GET route (AC3)", async () => {
    writeFileSync(
      connectionsFile(),
      JSON.stringify({
        "company-compute": {
          state: "connected",
          validated_at: new Date().toISOString(),
          token: "POISON-file",
          password: "POISON-password",
        },
      }),
    )
    const response = await app().request("/amicode/connections")
    expect(await response.text()).not.toContain("POISON")
  })
})

describe("solver-mode route — releasing the HP tier over the route tree (opencode#78)", () => {
  test("POST /amicode/solver-mode {mode:'piccolo'} releases the tier; {mode:'hp'} is refused", async () => {
    const server = app()
    const stub = await stubSolveService(() => 200)
    try {
      await server.request(
        "/amicode/connections/credential",
        post({ id: "company-compute", base_url: stub.url, token: "tok-release" }),
      )
      expect(readFileSync(entitlementsFile(), "utf8")).toBe('codes = ["issimo"]\n')

      const released = await (await server.request("/amicode/solver-mode", post({ mode: "piccolo" }))).json()
      expect(released.ok).toBe(true)
      expect(released.mode).toBe("piccolo")
      expect(readFileSync(entitlementsFile(), "utf8")).toBe("codes = []\n")
      expect(JSON.parse(readFileSync(solverModeFile(), "utf8"))).toEqual({ mode: "piccolo", status: "switching" })

      // hp is not selectable here — it follows a credential, and a second hp
      // writer is the duplicate flip ADR 0001 forbids
      const refused = await (await server.request("/amicode/solver-mode", post({ mode: "hp" }))).json()
      expect(refused.ok).toBe(false)
      expect(JSON.parse(readFileSync(solverModeFile(), "utf8")).mode).toBe("piccolo")
    } finally {
      await stub.close()
    }
  })

  test("the route carries the same auth wrapper as every other amicode route (#163)", async () => {
    const guarded = app({ password: "pw", username: "user" })
    expect((await guarded.request("/amicode/solver-mode", post({ mode: "piccolo" }))).status).toBe(401)
    const authed = await guarded.request("/amicode/solver-mode", {
      ...post({ mode: "piccolo" }),
      headers: { Authorization: basic("user", "pw") },
    })
    expect(authed.status).toBe(200)
  })
})

describe("connections routes — HP flip artifacts over the route tree (167 AC1, AC3, AC4)", () => {
  test("valid submit over the route → both flip artifacts; disconnect leaves them (one-way); 401 never flips", async () => {
    const server = app()
    let probeStatus = 200
    const stub = await stubSolveService(() => probeStatus)
    try {
      // valid save over the REAL route tree → both ops-dir artifacts (AC1),
      // durable with no extension host anywhere in this process (AC3)
      const submitted = await (
        await server.request(
          "/amicode/connections/credential",
          post({ id: "company-compute", base_url: stub.url, token: "tok-flip" }),
        )
      ).json()
      expect(submitted.ok).toBe(true)
      expect(submitted.connection.state).toBe("connected")
      expect(submitted.error).toBeNull() // flip succeeded — no partial-failure warning
      expect(readFileSync(entitlementsFile(), "utf8")).toBe('codes = ["issimo"]\n')
      expect(JSON.parse(readFileSync(solverModeFile(), "utf8"))).toEqual({ mode: "hp", status: "switching" })

      // disconnect reverts NOTHING solver-side — the flip is one-way on connect
      await server.request("/amicode/connections/disconnect", post({ id: "company-compute" }))
      expect(readFileSync(entitlementsFile(), "utf8")).toBe('codes = ["issimo"]\n')
      expect(JSON.parse(readFileSync(solverModeFile(), "utf8"))).toEqual({ mode: "hp", status: "switching" })
    } finally {
      await stub.close()
    }

    // a rejected key over the route produces no flip artifacts at all (AC4)
    process.env.AMICODE_OPS_DIR = path.join(dir, "amicode-ops-rejected")
    const rejecting = await stubSolveService(() => 401)
    try {
      const rejected = await (
        await server.request(
          "/amicode/connections/credential",
          post({ id: "company-compute", base_url: rejecting.url, token: "tok-bad" }),
        )
      ).json()
      expect(rejected.connection.state).toBe("invalid")
      expect(existsSync(entitlementsFile())).toBe(false)
      expect(existsSync(solverModeFile())).toBe(false)
    } finally {
      await rejecting.close()
    }
  })
})

// --- Pasqal over the route tree (amicode#169): the REAL spawn path — the
// default (non-injected) spawner launches an actual child against a stub
// validator honoring the #164 contract, staged where $AMICO_PASQAL_VALIDATOR
// points and interpreted by $AMICO_PYTHON (the test binds it to the bun
// executable, proving the interpreter is a plain argv[0]).

const PASQAL = {
  username: "kate@example.com",
  password: "hunter2-P0ison-pa55word",
  project_id: "proj-0000-aaaa-bbbb",
}
const validatorLine = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    ok: true,
    project_id: PASQAL.project_id,
    devices: ["EMU_FREE", "FRESNEL"],
    token: "tok-pasqal-minted",
    expires_at: "2099-08-01T00:00:00+00:00",
    ...over,
  })

/** Stage a stub validator OUTSIDE the scanned credential tree: it records the
 *  child's env view (keys + the PASQAL_* values) into the harness dir and
 *  answers the scenario file — exit code + optional stdout line. */
function stageStubValidator() {
  const harness = mkdtempSync(path.join(tmpdir(), "amicode-pasqal-stub-"))
  const scenarioFile = path.join(harness, "scenario.json")
  const recordFile = path.join(harness, "record.json")
  const script = path.join(harness, "pasqal_validate_stub.py")
  writeFileSync(
    script,
    [
      `import json, os, sys`,
      `open(${JSON.stringify(recordFile)}, "w").write(json.dumps({`,
      `  "keys": sorted(os.environ.keys()),`,
      `  "username": os.environ.get("PASQAL_USERNAME"),`,
      `  "password": os.environ.get("PASQAL_PASSWORD"),`,
      `  "project_id": os.environ.get("PASQAL_PROJECT_ID"),`,
      `  "argv": sys.argv[1:],`,
      `}))`,
      `scenario = json.load(open(${JSON.stringify(scenarioFile)}))`,
      `if scenario.get("stdout"): print(scenario["stdout"])`,
      `sys.exit(scenario["exitCode"])`,
    ].join("\n"),
  )
  process.env.AMICO_PYTHON = "python3" // a REAL interpreter, as production uses
  process.env.AMICO_PASQAL_VALIDATOR = script
  return {
    scenario(exitCode: number, stdout = "") {
      writeFileSync(scenarioFile, JSON.stringify({ exitCode, stdout }))
    },
    record(): {
      keys: string[]
      username: string | null
      password: string | null
      project_id: string | null
      argv: string[]
    } {
      return JSON.parse(readFileSync(recordFile, "utf8"))
    },
    recordExists: () => existsSync(recordFile),
    clearRecord: () => rmSync(recordFile, { force: true }),
    cleanup: () => rmSync(harness, { recursive: true, force: true }),
  }
}

/** every byte of every file under the credential/ops tree (raw) */
const scanTree = (root: string): string => {
  if (!existsSync(root)) return ""
  const chunks: string[] = []
  for (const entry of readdirSync(root, { recursive: true }) as string[]) {
    const full = path.join(root, String(entry))
    if (statSync(full).isFile()) chunks.push(readFileSync(full, "latin1"))
  }
  return chunks.join("\n")
}

describe("pasqal over the route tree — REAL spawn against a staged stub validator (169 AC1/AC2/AC3/AC4)", () => {
  test("full lifecycle: submit(valid) → connected + devices; revalidate never respawns; disconnect scrubs", async () => {
    const server = app()
    const stub = stageStubValidator()
    process.env.AMICODE_ROUTE_CANARY = "canary-route-full-spread" // a process.env spread would leak this
    try {
      stub.scenario(0, validatorLine())
      const submitted = await (
        await server.request("/amicode/connections/credential", post({ id: "pasqal-cloud", ...PASQAL }))
      ).json()
      expect(submitted.ok).toBe(true)
      expect(submitted.error).toBeNull()
      expect(submitted.connection.state).toBe("connected")
      expect(submitted.connection.identity).toBe(PASQAL.project_id)
      expect(submitted.connection.devices).toEqual([{ name: "EMU_FREE" }, { name: "FRESNEL" }])

      // the child saw EXACTLY the minimal declared env — the real spawn spreads nothing
      const record = stub.record()
      // CPython injects LC_CTYPE into its own environ under PEP 538 C-locale
      // coercion, so filter interpreter-owned locale vars. macOS injects
      // __CF_USER_TEXT_ENCODING unconditionally. The point of the assertion is
      // that the SPAWNER declared nothing beyond this set.
      const declared = record.keys.filter((k) => !/^(LC_[A-Z_]+|LANG|__CF_USER_TEXT_ENCODING)$/.test(k))
      expect(declared).toEqual(["PASQAL_PASSWORD", "PASQAL_PROJECT_ID", "PASQAL_USERNAME", "PATH"])
      expect(record.username).toBe(PASQAL.username)
      expect(record.password).toBe(PASQAL.password)
      expect(record.project_id).toBe(PASQAL.project_id)
      expect(record.argv).toEqual([]) // nothing beyond <interpreter> <script> — no secret rides argv

      // token-only at rest; the password exists NOWHERE under the credential/ops tree
      expect(readCredential("pasqal-cloud")).toEqual({
        project_id: PASQAL.project_id,
        token: "tok-pasqal-minted",
        expires_at: "2099-08-01T00:00:00+00:00",
      })
      const bytes = scanTree(dir)
      expect(bytes).toContain("tok-pasqal-minted")
      expect(bytes).not.toContain(PASQAL.password)
      expect(bytes).not.toContain(PASQAL.username)

      // revalidate is a token-mode freshness check — the validator must NOT run again
      stub.clearRecord()
      const revalidated = await (
        await server.request("/amicode/connections/revalidate", post({ id: "pasqal-cloud" }))
      ).json()
      expect(revalidated.connection.state).toBe("connected")
      expect(stub.recordExists()).toBe(false)

      const disconnected = await (
        await server.request("/amicode/connections/disconnect", post({ id: "pasqal-cloud" }))
      ).json()
      expect(disconnected.connection.state).toBe("needs-key")
      expect(readCredential("pasqal-cloud")).toBeUndefined()
      expect(scanTree(dir)).not.toContain("tok-pasqal-minted")
    } finally {
      delete process.env.AMICODE_ROUTE_CANARY
      stub.cleanup()
    }
  })

  test("failure classes over the route: exit 2/4 → invalid/unentitled; exit 1 → config warning; nothing at rest", async () => {
    const server = app()
    const stub = stageStubValidator()
    try {
      const cases: [number, string, string | null][] = [
        [2, "invalid", null],
        [4, "unentitled", null],
        [1, "unreachable", PASQAL_CONFIG_WARNING],
      ]
      for (const [exitCode, state, error] of cases) {
        stub.scenario(exitCode)
        const parsed = await (
          await server.request("/amicode/connections/credential", post({ id: "pasqal-cloud", ...PASQAL }))
        ).json()
        expect(parsed.ok).toBe(true)
        expect(parsed.connection.state).toBe(state)
        expect(parsed.error).toBe(error)
      }
      expect(readCredential("pasqal-cloud")).toBeUndefined()
      const bytes = scanTree(dir)
      expect(bytes).not.toContain(PASQAL.password)
      expect(bytes).not.toContain(PASQAL.username)
    } finally {
      stub.cleanup()
    }
  })

  test("null token over the route → session-only connected; nothing at rest (AC4)", async () => {
    const server = app()
    const stub = stageStubValidator()
    try {
      stub.scenario(0, validatorLine({ token: null, expires_at: null }))
      const parsed = await (
        await server.request("/amicode/connections/credential", post({ id: "pasqal-cloud", ...PASQAL }))
      ).json()
      expect(parsed.ok).toBe(true)
      expect(parsed.connection.state).toBe("connected")
      expect(parsed.connection.session_only).toBe(true)
      expect(parsed.connection.devices).toEqual([{ name: "EMU_FREE" }, { name: "FRESNEL" }])
      expect(readCredential("pasqal-cloud")).toBeUndefined()
      const status = await (await server.request("/amicode/connections")).json()
      const entry = status.connections.find((conn: { id: string }) => conn.id === "pasqal-cloud")
      expect(entry.state).toBe("connected")
      expect(entry.session_only).toBe(true)
      const bytes = scanTree(dir)
      expect(bytes).not.toContain(PASQAL.password)
      expect(bytes).not.toContain(PASQAL.username)
    } finally {
      stub.cleanup()
    }
  })
})

// --- Resilience over the SAME route tree (amicode#170): staleness/offline
// (AC1/AC3), the identity echo + drift diff against the stubbed identity
// endpoint (AC4, live endpoint aws-infra#185), and read-time expiry (AC5).

describe("connections routes — resilience (170 AC1/AC3/AC4/AC5)", () => {
  test("offline boot over the route: the stale GET answers at once; the failed background refresh marks offline, never invalid", async () => {
    const server = app()
    // a loopback port with nothing listening = the unreachable service
    const dead = await stubSolveService(() => 404)
    await dead.close()
    writeCredential("company-compute", { base_url: dead.url, token: "tok-offline" })
    const lastVerified = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
    writeFileSync(
      connectionsFile(),
      JSON.stringify({
        "company-compute": { state: "connected", validated_at: lastVerified, identity: "team-alpha" },
      }),
    )

    const first = await (await server.request("/amicode/connections")).json()
    expect(first.connections[0].state).toBe("connected") // rendered immediately from cache
    expect(first.connections[0].stale).toBe(true)
    await backgroundRevalidationsSettled()

    const offline = (await (await server.request("/amicode/connections")).json()).connections[0]
    expect(offline.state).toBe("connected") // never 'invalid', never 'unreachable'
    expect(offline.offline).toBe(true)
    expect(offline.stale).toBe(true)
    expect(offline.validated_at).toBe(lastVerified) // the last-verified marker stands
    expect(offline.identity).toBe("team-alpha")
    expect(readCredential("company-compute")).toEqual({ base_url: dead.url, token: "tok-offline" })
  })

  test("identity echo + drift over the route: the stubbed identity endpoint changes its submitter (the incident shape)", async () => {
    const server = app()
    let submitter = "team-alpha"
    const stub = await stubSolveService(
      () => 200,
      () => JSON.stringify({ submitter }),
    )
    try {
      const submitted = await (
        await server.request(
          "/amicode/connections/credential",
          post({ id: "company-compute", base_url: stub.url, token: "tok-echo" }),
        )
      ).json()
      expect(submitted.connection.state).toBe("connected")
      expect(submitted.connection.identity).toBe("team-alpha") // "Connected as <submitter>"

      submitter = "team-beta" // the server-side submitter drifts out from under the key
      const drifted = await (
        await server.request("/amicode/connections/revalidate", post({ id: "company-compute" }))
      ).json()
      expect(drifted.connection.state).toBe("connected")
      expect(drifted.connection.identity).toBe("team-alpha") // the stored record — preserved
      expect(drifted.connection.identity_drift).toBe("team-beta") // the explicit diff

      const status = await (await server.request("/amicode/connections")).json()
      expect(status.connections[0].identity).toBe("team-alpha")
      expect(status.connections[0].identity_drift).toBe("team-beta")
    } finally {
      await stub.close()
    }
  })

  test("expiry over the route: a past-expiry claim answers 'expired' and the credential file survives", async () => {
    const server = app()
    writeCredential("company-compute", { base_url: "https://solves.example.co", token: "tok-expired" })
    writeFileSync(
      connectionsFile(),
      JSON.stringify({
        "company-compute": {
          state: "connected",
          validated_at: new Date().toISOString(),
          expires_at: new Date(Date.now() - 60_000).toISOString(),
        },
      }),
    )
    const parsed = await (await server.request("/amicode/connections")).json()
    expect(parsed.connections[0].state).toBe("expired")
    expect(readCredential("company-compute")).toBeDefined() // reconnect ≠ disconnect
  })
})

describe("connections routes — auth per #163", () => {
  test("with a password configured, unauthenticated requests are rejected; basic auth serves", async () => {
    const server = app({ password: "secret" })

    const missingGet = await server.request("/amicode/connections")
    expect(missingGet.status).toBe(401)

    const missingPost = await server.request(
      "/amicode/connections/credential",
      post({ id: "company-compute", base_url: "https://solves.example.co", token: "tok-unauthed" }),
    )
    expect(missingPost.status).toBe(401)
    expect(readCredential("company-compute")).toBeUndefined() // rejected before any handler ran

    const authed = await server.request("/amicode/connections", {
      headers: { authorization: basic("opencode", "secret") },
    })
    expect(authed.status).toBe(200)
    expect((await authed.json()).ok).toBe(true)
  })
})

describe("connections routes — loopback guard (AC5)", () => {
  test("simulated non-loopback bind: mutations answer the distinct refusal; the read stays available", async () => {
    const server = app()
    setBindHostname("0.0.0.0")

    const refused = await (
      await server.request(
        "/amicode/connections/credential",
        post({ id: "company-compute", base_url: "https://solves.example.co", token: "tok-lan" }),
      )
    ).json()
    expect(refused.ok).toBe(false)
    expect(refused.error).toStartWith("non_loopback:")
    expect(readCredential("company-compute")).toBeUndefined()

    const status = await server.request("/amicode/connections")
    expect(status.status).toBe(200)
    expect((await status.json()).ok).toBe(true)
  })
})

describe("connections routes — standalone serve records the bind", () => {
  afterEach(async () => {
    await disposeAllInstances()
    await resetDatabase()
  })

  test("a real 0.0.0.0 listener refuses mutations over live HTTP; a 127.0.0.1 listener serves them", async () => {
    const { Server } = await import("@/server/server")
    const stub = await stubSolveService(() => 200)
    const body = post({ id: "company-compute", base_url: stub.url, token: "tok-real-bind" })

    // Verify the in-process handler refuses when bind is non-loopback
    const prevBind = setBindHostname("0.0.0.0")
    try {
      const inProcess = await (await app().request("/amicode/connections/credential", body)).json()
      expect(inProcess.ok).toBe(false)
      expect(inProcess.error).toStartWith("non_loopback:")
    } finally {
      setBindHostname(prevBind)
    }

    // Verify a 127.0.0.1 listener serves mutations
    const local = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    try {
      const accepted = await (await fetch(`http://127.0.0.1:${local.port}/amicode/connections/credential`, body)).json()
      expect(accepted.ok).toBe(true)
      expect(accepted.connection.state).toBe("connected")
      expect(readCredential("company-compute")).toEqual({ base_url: stub.url, token: "tok-real-bind" })
    } finally {
      await local.stop(true)
      await stub.close()
    }
  })
})
