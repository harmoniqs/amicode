import { describe, expect, test, afterAll } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { loadConfig, ConfigError, DEFAULT_PORT } from "../src/config.ts"
import { cleanup, makeSandbox } from "./helpers.ts"

afterAll(cleanup)

const sb = makeSandbox("config")
const good = { AMICODE_HOST_DB: sb.db, AMICODE_HOST_PASSWORD: "pw-" + crypto.randomUUID(), XDG_STATE_HOME: sb.state }
const refuses = (env: Record<string, string | undefined>, pattern: RegExp, argv: string[] = []) => {
  const run = () => loadConfig(env, argv)
  expect(run).toThrow(ConfigError)
  expect(run).toThrow(pattern)
}

describe("database path", () => {
  test("a missing database path is refused", () => refuses({ ...good, AMICODE_HOST_DB: undefined }, /AMICODE_HOST_DB/))
  test("an empty database path is refused", () => refuses({ ...good, AMICODE_HOST_DB: "  " }, /AMICODE_HOST_DB/))
  test.each([":memory:", "file::memory:", "file:x.db?mode=memory&cache=shared", "  :memory:"])(
    "in-memory path %p is refused",
    (value) => refuses({ ...good, AMICODE_HOST_DB: value }, /in-memory/i),
  )
  test("an explicit file path is accepted and made absolute", () => {
    const config = loadConfig({ ...good, AMICODE_HOST_DB: "relative/host.db" }, [])
    expect(path.isAbsolute(config.dbPath)).toBe(true)
    expect(config.dbPath.endsWith("relative/host.db")).toBe(true)
  })
  test("--db overrides the environment", () => {
    expect(loadConfig(good, ["--db", "/tmp/opencode/x/other.db"]).dbPath).toBe("/tmp/opencode/x/other.db")
    expect(loadConfig(good, ["--db=/tmp/opencode/x/other2.db"]).dbPath).toBe("/tmp/opencode/x/other2.db")
  })
})

describe("password", () => {
  test("no password at all is refused (deny-by-default, never an open server)", () =>
    refuses({ ...good, AMICODE_HOST_PASSWORD: undefined }, /AMICODE_HOST_PASSWORD/))
  test("a --password flag is not accepted (argv is world-visible)", () =>
    refuses({ ...good, AMICODE_HOST_PASSWORD: undefined }, /AMICODE_HOST_PASSWORD/, ["--password", "from-argv"]))
  test("an empty password is refused", () => refuses({ ...good, AMICODE_HOST_PASSWORD: "" }, /AMICODE_HOST_PASSWORD/))
  test("a password file with mode 0600 is accepted and trailing newline trimmed", () => {
    const file = path.join(sb.root, "pw-600")
    fs.writeFileSync(file, "from-file\n", { mode: 0o600 })
    fs.chmodSync(file, 0o600)
    const config = loadConfig({ ...good, AMICODE_HOST_PASSWORD: undefined, AMICODE_HOST_PASSWORD_FILE: file }, [])
    expect(config.password).toBe("from-file")
  })
  test.each([0o640, 0o604, 0o644, 0o660])("a password file with mode %o is refused", (mode) => {
    const file = path.join(sb.root, `pw-${mode.toString(8)}`)
    fs.writeFileSync(file, "x-secret")
    fs.chmodSync(file, mode)
    refuses({ ...good, AMICODE_HOST_PASSWORD: undefined, AMICODE_HOST_PASSWORD_FILE: file }, /readable by group or others/)
  })
  test("a missing password file is refused", () =>
    refuses({ ...good, AMICODE_HOST_PASSWORD: undefined, AMICODE_HOST_PASSWORD_FILE: "/tmp/opencode/nope-" + crypto.randomUUID() }, /AMICODE_HOST_PASSWORD_FILE/))
  test("giving both a password and a password file is refused", () => {
    const file = path.join(sb.root, "pw-both")
    fs.writeFileSync(file, "x", { mode: 0o600 })
    refuses({ ...good, AMICODE_HOST_PASSWORD_FILE: file }, /only one/i)
  })
  test("the password never appears in the thrown message", () => {
    const secret = "never-print-" + crypto.randomUUID()
    const run = () => loadConfig({ ...good, AMICODE_HOST_PASSWORD: secret, AMICODE_HOST_PORT: "nope" }, [])
    expect(run).toThrow(ConfigError)
    try {
      run()
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(secret)
    }
  })
})

describe("port, resume, lock wait", () => {
  test("port defaults to the documented constant", () => {
    expect(loadConfig(good, []).port).toBe(DEFAULT_PORT)
    expect(DEFAULT_PORT).toBe(0)
  })
  test("port from env and flag; invalid values refused", () => {
    expect(loadConfig({ ...good, AMICODE_HOST_PORT: "52001" }, []).port).toBe(52001)
    expect(loadConfig({ ...good, AMICODE_HOST_PORT: "52001" }, ["--port", "52002"]).port).toBe(52002)
    for (const bad of ["abc", "-1", "70000", "1.5"]) refuses({ ...good, AMICODE_HOST_PORT: bad }, /AMICODE_HOST_PORT/)
  })
  test("the well-known opencode service ports are refused", () => {
    for (const port of ["49374", "49375"]) refuses({ ...good, AMICODE_HOST_PORT: port }, /opencode service/i)
  })
  test("resume defaults to on; 0/1 accepted; anything else refused", () => {
    expect(loadConfig(good, []).resume).toBe(true)
    expect(loadConfig({ ...good, AMICODE_HOST_RESUME: "0" }, []).resume).toBe(false)
    expect(loadConfig({ ...good, AMICODE_HOST_RESUME: "1" }, []).resume).toBe(true)
    refuses({ ...good, AMICODE_HOST_RESUME: "maybe" }, /AMICODE_HOST_RESUME/)
  })
  test("lock wait defaults to 30000 ms and is overridable", () => {
    expect(loadConfig(good, []).lockWaitMs).toBe(30_000)
    expect(loadConfig({ ...good, AMICODE_HOST_LOCK_WAIT_MS: "1500" }, []).lockWaitMs).toBe(1500)
    refuses({ ...good, AMICODE_HOST_LOCK_WAIT_MS: "-5" }, /AMICODE_HOST_LOCK_WAIT_MS/)
  })
  test("server options passthrough must be a JSON object and cannot override host-owned keys", () => {
    expect(loadConfig({ ...good, AMICODE_HOST_SERVER_OPTIONS: '{"models":{"fetch":false}}' }, []).serverOptions).toEqual({
      models: { fetch: false },
    })
    refuses({ ...good, AMICODE_HOST_SERVER_OPTIONS: "[1]" }, /AMICODE_HOST_SERVER_OPTIONS/)
    refuses({ ...good, AMICODE_HOST_SERVER_OPTIONS: "{" }, /AMICODE_HOST_SERVER_OPTIONS/)
    for (const key of ["password", "port", "hostname", "database"])
      refuses({ ...good, AMICODE_HOST_SERVER_OPTIONS: JSON.stringify({ [key]: 1 }) }, /host-owned/i)
  })
})

describe("registration file", () => {
  test("defaults to $XDG_STATE_HOME/amicode/host.json", () => {
    expect(loadConfig(good, []).registrationFile).toBe(path.join(sb.state, "amicode", "host.json"))
  })
  test("falls back to ~/.local/state/amicode/host.json without XDG_STATE_HOME", () => {
    const config = loadConfig({ ...good, XDG_STATE_HOME: undefined, HOME: "/tmp/opencode/fake-home" }, [])
    expect(config.registrationFile).toBe("/tmp/opencode/fake-home/.local/state/amicode/host.json")
  })
  test.each([
    "/x/opencode/service.json",
    "/x/amicode/service.json",
    "/x/amicode/service-abc.json",
    "/x/opencode/host.json",
  ])("a path the stock opencode client uses (%p) is refused", (value) =>
    refuses({ ...good, AMICODE_HOST_REGISTRATION_FILE: value }, /stock opencode/i),
  )
})
