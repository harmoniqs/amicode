import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readAuthoring, DEFAULT_ALLOWLIST, DEFAULT_SUPPORT } from "../src/authoring.js"

let dir: string | undefined
afterEach(() => {
  delete process.env.AMICO_AUTHORING_FILE
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

describe("readAuthoring", () => {
  it("reads the file named by $AMICO_AUTHORING_FILE, fields round-trip", () => {
    dir = mkdtempSync(join(tmpdir(), "amico-authoring-"))
    const file = join(dir, "authoring.json")
    writeFileSync(
      file,
      JSON.stringify({
        schema_version: 1,
        allowlist: ["Piccolo", "Piccolissimo"],
        support_set: ["JLD2"],
        registry: "/abs/registry.toml",
        exemplars: "/abs/index.json",
        verify_harness: "/abs/verify_rollout.jl",
        verify_tolerance: 0.02,
      }),
    )
    process.env.AMICO_AUTHORING_FILE = file
    const { config, warning } = readAuthoring()
    expect(warning).toBeUndefined()
    expect(config.allowlist).toEqual(["Piccolo", "Piccolissimo"])
    expect(config.support_set).toEqual(["JLD2"])
    expect(config.registry).toBe("/abs/registry.toml")
    expect(config.exemplars).toBe("/abs/index.json")
    expect(config.verify_harness).toBe("/abs/verify_rollout.jl")
    expect(config.verify_tolerance).toBe(0.02)
  })

  it("missing file → conservative built-in defaults, no warning", () => {
    process.env.AMICO_AUTHORING_FILE = "/nonexistent/authoring.json"
    const { config, warning } = readAuthoring()
    expect(warning).toBeUndefined()
    expect(config.allowlist).toEqual(DEFAULT_ALLOWLIST)
    expect(config.allowlist).toEqual(["Piccolo", "Legato", "Intonato", "NamedTrajectories", "DirectTrajOpt"])
    expect(config.support_set).toEqual(DEFAULT_SUPPORT)
    expect(config.support_set).toEqual(expect.arrayContaining(["JLD2", "CairoMakie", "TOML"]))
    expect(config.verify_tolerance).toBe(0.001)   // spec-20260704-113005 §6 (resolves spec-C open q1)
  })

  it("malformed JSON → defaults + a warning naming the file", () => {
    dir = mkdtempSync(join(tmpdir(), "amico-authoring-"))
    const file = join(dir, "authoring.json")
    writeFileSync(file, "{nope")
    process.env.AMICO_AUTHORING_FILE = file
    const { config, warning } = readAuthoring()
    expect(config.allowlist).toEqual(DEFAULT_ALLOWLIST)
    expect(warning).toContain("authoring.json")
  })
})
