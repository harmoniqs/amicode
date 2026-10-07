// AMICODE: harness switch route tests (amicode#1549). The engine half of the
// harness.json contract: GET serves the current harness + the extension's
// published registry view; POST validates against that view and writes
// {harness, status:"switching"} for the extension watcher to perform. The
// engine never computes the registry and never hardcodes harness identity —
// the id allowlist IS the published view. Same env-override + tmp-dir
// discipline as the connections suite (AMICODE_OPS_DIR).
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  HARNESS_SWITCH_WARNING,
  harnessFile,
  harnessOptionsFile,
  harnessResponse,
  harnessStateResponse,
  readHarnessOptions,
  readHarnessState,
} from "@/server/amicode/harness"
import { setBindHostname } from "@/server/amicode/connections"

const ENV_KEYS = ["AMICODE_OPS_DIR"]

const MENU = {
  current: "opencode",
  options: [
    { id: "opencode", displayName: "opencode (default)", state: "ready", detail: "The default harness.", disabled: false },
    {
      id: "telaio",
      displayName: "telaio (subscription)",
      state: "ready",
      detail: "Serves the Harness Contract v1 API.",
      disabled: false,
    },
  ],
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "amicode-harness-"))
  for (const key of ENV_KEYS) process.env[key] = path.join(dir, "ops")
  mkdirSync(path.join(dir, "ops"), { recursive: true })
})

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
})

const writeOptions = (menu: unknown) => writeFileSync(harnessOptionsFile(), JSON.stringify(menu))

describe("GET /amicode/harness — the state the composer renders (#1549)", () => {
  test("no files at all → the opencode default, ready, NO options (the control stays hidden)", () => {
    const parsed = JSON.parse(harnessStateResponse()) as Record<string, unknown>
    expect(parsed.ok).toBe(true)
    expect(parsed.harness).toBe("opencode")
    expect(parsed.status).toBe("ready")
    expect(parsed.options).toBeUndefined()
  })

  test("a published registry view rides the response; the view's current wins while it exists", () => {
    writeOptions(MENU)
    const parsed = JSON.parse(harnessStateResponse()) as Record<string, unknown>
    expect(parsed.harness).toBe("opencode")
    expect(parsed.options).toEqual(MENU.options)
    writeOptions({ ...MENU, current: "telaio" })
    expect((JSON.parse(harnessStateResponse()) as Record<string, unknown>).harness).toBe("telaio")
  })

  test("a switching handshake overrides the STATUS but not the displayed current", () => {
    writeOptions(MENU)
    writeFileSync(harnessFile(), JSON.stringify({ harness: "telaio", status: "switching" }))
    const parsed = JSON.parse(harnessStateResponse()) as Record<string, unknown>
    expect(parsed.harness).toBe("opencode") // the setting-backed view still speaks
    expect(parsed.status).toBe("switching")
  })

  test("corrupt files collapse to the defaults, never a throw", () => {
    writeFileSync(harnessOptionsFile(), "not json {{{")
    writeFileSync(harnessFile(), "also not json {{{")
    const parsed = JSON.parse(harnessStateResponse()) as Record<string, unknown>
    expect(parsed.harness).toBe("opencode")
    expect(parsed.status).toBe("ready")
    expect(parsed.options).toBeUndefined()
  })

  test("off-shape option entries are dropped, not repaired; an all-bad view reads as absent", () => {
    writeFileSync(
      harnessOptionsFile(),
      JSON.stringify({
        current: "opencode",
        options: [{ id: "telaio" }, { id: "", displayName: "x", state: "ready", disabled: false }, "junk", MENU.options[1]],
      }),
    )
    const view = readHarnessOptions()
    expect(view?.options.map((o) => o.id)).toEqual(["telaio"])
    writeFileSync(harnessOptionsFile(), JSON.stringify({ current: "opencode", options: ["junk"] }))
    expect(readHarnessOptions()).toBeUndefined()
  })
})

describe("POST /amicode/harness — the switching write (#1549)", () => {
  test("a valid different harness writes {harness, status:switching} and answers ok", () => {
    writeOptions(MENU)
    const parsed = JSON.parse(harnessResponse(JSON.stringify({ harness: "telaio" }))) as Record<string, unknown>
    expect(parsed.ok).toBe(true)
    expect(parsed.harness).toBe("telaio")
    expect(parsed.noop).toBe(false)
    expect(parsed.error).toBeNull()
    expect(JSON.parse(readFileSync(harnessFile(), "utf8"))).toEqual({ harness: "telaio", status: "switching" })
  })

  test("selecting the current harness is a no-op: ok, and the watcher is NOT poked", () => {
    writeOptions(MENU)
    const parsed = JSON.parse(harnessResponse(JSON.stringify({ harness: "opencode" }))) as Record<string, unknown>
    expect(parsed.ok).toBe(true)
    expect(parsed.noop).toBe(true)
    let threw = false
    try {
      readFileSync(harnessFile())
    } catch {
      threw = true
    }
    expect(threw).toBe(true) // no switching write happened
  })

  test("an id outside the published registry is refused and writes nothing", () => {
    writeOptions(MENU)
    const parsed = JSON.parse(harnessResponse(JSON.stringify({ harness: "ghost" }))) as Record<string, unknown>
    expect(parsed.ok).toBe(false)
    expect(parsed.harness).toBeNull()
    expect(parsed.error).toContain("unsupported_harness")
    expect(readHarnessState().harness).toBe("opencode")
  })

  test("NO published registry → refused (there is no extension to perform the switch)", () => {
    const parsed = JSON.parse(harnessResponse(JSON.stringify({ harness: "telaio" }))) as Record<string, unknown>
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toContain("registry_unavailable")
    let threw = false
    try {
      readFileSync(harnessFile())
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  test("malformed bodies are refused with fixed messages, writing nothing", () => {
    writeOptions(MENU)
    for (const body of [JSON.stringify({ mode: "hp" }), JSON.stringify({}), JSON.stringify({ harness: 42 }), "not json {{{"]) {
      const parsed = JSON.parse(harnessResponse(body)) as Record<string, unknown>
      expect(parsed.ok).toBe(false)
      expect(parsed.harness).toBeNull()
      expect(typeof parsed.error).toBe("string")
    }
    expect(readHarnessState().status).toBe("ready")
  })

  test("non-loopback bind is refused INERTLY — nothing is written", () => {
    writeOptions(MENU)
    setBindHostname("0.0.0.0")
    const refused = JSON.parse(harnessResponse(JSON.stringify({ harness: "telaio" }))) as Record<string, unknown>
    setBindHostname(undefined)
    expect(refused.ok).toBe(false)
    expect(refused.error).toContain("non_loopback")
    expect(readHarnessState().status).toBe("ready")
  })

  test("a failing switching write → ok:false with a fixed, value-free warning (no path, no errno)", () => {
    writeOptions(MENU)
    // an unwritable harness.json path (a directory squatting the filename)
    mkdirSync(harnessFile(), { recursive: true })
    const raw = harnessResponse(JSON.stringify({ harness: "telaio" }))
    expect((JSON.parse(raw) as Record<string, unknown>).ok).toBe(false)
    expect((JSON.parse(raw) as Record<string, unknown>).error).toBe(HARNESS_SWITCH_WARNING)
    expect(raw).not.toContain(dir)
  })
})
