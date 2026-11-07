// Engine-boundary accept-set (#1438, ADR 0032 §D2) — the overlay's own
// function-level test of auth.ts: the constant-time password compare (replacing
// base `===`), the peer-token accept-set read fresh from the issued registry,
// and `required()` going true once the accept-set is CLOSED (so an anonymous
// request is refused even on an unarmed engine — AC7's engine boundary).
import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Option, Redacted } from "effect"
import { ServerAuth } from "@/server/auth"

function creds(password: string, username = "opencode"): ServerAuth.DecodedCredentials {
  return { username, password: Redacted.make(password) }
}
function config(password?: string): ServerAuth.Info {
  return { password: password === undefined ? Option.none() : Option.some(password), username: "opencode" } as ServerAuth.Info
}

let root: string
let issued: string
let phase: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "engine-accept-set-"))
  issued = join(root, "fleet-peer-tokens.json")
  phase = join(root, "fleet-accept-set.json")
  process.env.AMICO_FLEET_ISSUED_TOKEN_FILE = issued
  process.env.AMICO_FLEET_ACCEPT_SET_FILE = phase
})
afterEach(() => {
  delete process.env.AMICO_FLEET_ISSUED_TOKEN_FILE
  delete process.env.AMICO_FLEET_ACCEPT_SET_FILE
  rmSync(root, { recursive: true, force: true })
})

describe("engine overlay authorized() — constant-time password (AC3 engine side)", () => {
  test("the correct password authorizes", () => {
    expect(ServerAuth.authorized(creds("PW-1234567890"), config("PW-1234567890"))).toBe(true)
  })
  test("a wrong-LENGTH password is refused", () => {
    expect(ServerAuth.authorized(creds("short"), config("PW-1234567890"))).toBe(false)
  })
  test("an equal-length-WRONG password is refused", () => {
    expect("XXXXXXXXXXXXX".length).toBe("PW-1234567890".length)
    expect(ServerAuth.authorized(creds("XXXXXXXXXXXXX"), config("PW-1234567890"))).toBe(false)
  })
  test("a mismatched username is refused", () => {
    expect(ServerAuth.authorized(creds("PW", "intruder"), config("PW"))).toBe(false)
  })
})

describe("engine overlay authorized() — the peer-token accept-set (AC2/AC4 engine side)", () => {
  test("a non-revoked issued peer token authorizes (read fresh from the registry)", () => {
    writeFileSync(issued, JSON.stringify({ store_version: 1, issued: { "mac-studio": { token: "PEER-TOK-XYZ" } }, revoked: {} }))
    expect(ServerAuth.authorized(creds("PEER-TOK-XYZ"), config("engine-pw"))).toBe(true)
  })
  test("currency: dropping the entry refuses the very next call (no cache)", () => {
    writeFileSync(issued, JSON.stringify({ store_version: 1, issued: { m: { token: "T-1234" } }, revoked: {} }))
    expect(ServerAuth.authorized(creds("T-1234"), config("engine-pw"))).toBe(true)
    writeFileSync(issued, JSON.stringify({ store_version: 1, issued: {}, revoked: { m: { revoked_at: "x" } } }))
    expect(ServerAuth.authorized(creds("T-1234"), config("engine-pw"))).toBe(false)
  })
})

describe("engine overlay required() — closing the boundary arms auth (AC7 engine side)", () => {
  test("no password + additive/absent phase → auth NOT required (unarmed engine stays open behind the tunnel)", () => {
    expect(ServerAuth.required(config())).toBe(false)
  })
  test("no password + CLOSED phase → auth REQUIRED (anonymous refused at the engine boundary)", () => {
    writeFileSync(phase, JSON.stringify({ phase: "closed" }))
    expect(ServerAuth.required(config())).toBe(true)
    expect(ServerAuth.acceptSetClosed()).toBe(true)
  })
})
