import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadRegistry, loadExemplarsIndex, matchShape } from "../src/catalog.js"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "amico-catalog-"))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const REGISTRY = `
verify_tolerance = 0.01

[[template]]
id = "transmon-gate-1q"
platform = "transmon"
kind = "gate_synthesis"
size = 1
path = "solve_template.jl"
status = "vetted"
packages = ["Piccolo", "CairoMakie", "JLD2", "TOML", "Printf"]

[[template]]
id = "rydberg-cz-2q"
platform = "rydberg"
kind = "gate_synthesis"
size = 2
path = "solve_rydberg_cz.jl"
status = "experimental"
packages = ["Piccolo", "CairoMakie", "JLD2", "LinearAlgebra", "TOML", "Printf"]

[[template]]
id = "issimo-special-1q"
platform = "transmon"
kind = "state_prep"
size = 1
path = "solve_issimo.jl"
status = "vetted"
entitlement = "issimo"
packages = ["Piccolissimo", "JLD2", "TOML"]

[support]
packages = ["JLD2", "CairoMakie", "TOML", "Printf"]

[uuids]
Piccolo = "c4671d76-df94-11ed-2057-43d4fd632fad"
JLD2 = "033835bb-8acc-5ee8-8aae-3f567f8a3819"
`

const INDEX = JSON.stringify({
  schema_version: 1,
  exemplars: [
    {
      id: "rydberg-cz",
      platform: "rydberg",
      kind: "gate_synthesis",
      size: 2,
      path: "rydberg-cz/script.jl",
      packages: ["Piccolo", "CairoMakie", "JLD2", "LinearAlgebra", "TOML", "Printf"],
      baseline_hash: "sha256:deadbeef",
    },
  ],
})

function seed() {
  writeFileSync(join(dir, "registry.toml"), REGISTRY)
  writeFileSync(join(dir, "index.json"), INDEX)
  return {
    registry: loadRegistry(join(dir, "registry.toml")),
    exemplars: loadExemplarsIndex(join(dir, "index.json")),
  }
}

const PUBLIC_ALLOW = ["Piccolo", "Legato", "Intonato", "NamedTrajectories", "DirectTrajOpt"]

describe("loaders", () => {
  it("registry parses templates, support set, uuids, tolerance", () => {
    const { registry } = seed()
    expect(registry.templates).toHaveLength(3)
    expect(registry.support).toEqual(["JLD2", "CairoMakie", "TOML", "Printf"])
    expect(registry.uuids.Piccolo).toBe("c4671d76-df94-11ed-2057-43d4fd632fad")
    expect(registry.verifyTolerance).toBe(0.01)
  })
  it("missing files → empty catalog, never throws", () => {
    expect(loadRegistry(join(dir, "nope.toml")).templates).toEqual([])
    expect(loadExemplarsIndex(join(dir, "nope.json")).exemplars).toEqual([])
  })
})

describe("matchShape", () => {
  it("exact vetted template match → tier 1", () => {
    const { registry, exemplars } = seed()
    const match = matchShape({ platform: "transmon", kind: "gate_synthesis", size: 1 }, registry, exemplars, PUBLIC_ALLOW)
    expect(match.tier).toBe("vetted")
    expect(match.template?.id).toBe("transmon-gate-1q")
  })
  it("experimental templates are NEVER tier 1 — falls through to the exemplar", () => {
    const { registry, exemplars } = seed()
    const match = matchShape({ platform: "rydberg", kind: "gate_synthesis", size: 2 }, registry, exemplars, PUBLIC_ALLOW)
    expect(match.tier).toBe("composed")
    expect(match.exemplar?.id).toBe("rydberg-cz")
  })
  it("no template and no exemplar → tier 3 (free)", () => {
    const { registry, exemplars } = seed()
    expect(matchShape({ platform: "ions", kind: "gate_synthesis", size: 1 }, registry, exemplars, PUBLIC_ALLOW).tier).toBe("free")
  })
  it("entitlement-blocked vetted match is excluded AND reported as blocked_higher", () => {
    const { registry, exemplars } = seed()
    const match = matchShape({ platform: "transmon", kind: "state_prep", size: 1 }, registry, exemplars, PUBLIC_ALLOW)
    expect(match.tier).toBe("free")
    expect(match.blockedHigher).toEqual({ tier: "vetted", requires: "issimo" })
    // with the issimo packages allowed, the same shape resolves tier 1
    const withIssimo = matchShape(
      { platform: "transmon", kind: "state_prep", size: 1 },
      registry,
      exemplars,
      [...PUBLIC_ALLOW, "Piccolissimo", "Strettissimo", "Intonatissimo"],
    )
    expect(withIssimo.tier).toBe("vetted")
    expect(withIssimo.template?.id).toBe("issimo-special-1q")
  })
  it("exemplar match on platform+kind tolerates a size mismatch (near match)", () => {
    const { registry, exemplars } = seed()
    const match = matchShape({ platform: "rydberg", kind: "gate_synthesis", size: 3 }, registry, exemplars, PUBLIC_ALLOW)
    expect(match.tier).toBe("composed")
  })
})
