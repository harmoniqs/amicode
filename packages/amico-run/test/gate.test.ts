import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runGate } from "../src/gate.js"
import { maskedHash } from "../src/baseline.js"
import type { AuthoringConfig } from "../src/authoring.js"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "amico-gate-"))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const EXEMPLAR_SCRIPT = `using Piccolo\nusing JLD2, TOML\n# ── FILL IN ──────\nT = 10.0\n# ─────────────────\nsolve()\n`

function authoring(overrides?: Partial<AuthoringConfig>): AuthoringConfig {
  // exemplars index on disk with the fixture exemplar's build-time baseline
  const index = join(dir, "index.json")
  writeFileSync(
    index,
    JSON.stringify({
      schema_version: 1,
      exemplars: [
        {
          id: "ex-1",
          platform: "rydberg",
          kind: "gate_synthesis",
          size: 2,
          path: "ex-1/script.jl",
          packages: ["Piccolo", "JLD2", "TOML"],
          baseline_hash: maskedHash(EXEMPLAR_SCRIPT),
        },
      ],
    }),
  )
  return {
    allowlist: ["Piccolo", "Legato"],
    support_set: ["JLD2", "CairoMakie", "TOML", "Printf"],
    exemplars: index,
    verify_tolerance: 0.01,
    ...overrides,
  }
}

function spec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: "2",
    script_path: join(dir, "solve.jl"),
    lab_id: "default",
    executor: "local",
    tier: "vetted",
    env: { kind: "provisioned" },
    ...overrides,
  }
}

describe("runGate", () => {
  it("step 1: schema-invalid spec → one-line schema reason", () => {
    const result = runGate({ nope: true }, "using Piccolo\n", authoring())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/schema/)
  })
  it("step 2: blocked import → reason names the package", () => {
    const result = runGate(spec(), "using Piccolo\nusing Zygote\n", authoring())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/Zygote/)
  })
  it("step 3: free tier requires a sandbox env", () => {
    const result = runGate(spec({ tier: "free", env: { kind: "provisioned" } }), "using Piccolo\n", authoring())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/free tier requires a sandbox env/)
  })
  it("step 3: project env without a Manifest.toml → instantiate message", () => {
    const env = join(dir, "env")
    mkdirSync(env)
    writeFileSync(join(env, "Project.toml"), `[deps]\nPiccolo = "c4671d76-df94-11ed-2057-43d4fd632fad"\n`)
    const result = runGate(spec({ env: { kind: "project", project: env } }), "using Piccolo\n", authoring())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/instantiate/)
  })
  it("step 3b: stale env — Project dep missing from its OWN Manifest → named + re-instantiate", () => {
    const env = join(dir, "env")
    mkdirSync(env)
    writeFileSync(
      join(env, "Project.toml"),
      `[deps]\nPiccolo = "c4671d76-df94-11ed-2057-43d4fd632fad"\nJLD2 = "033835bb-8acc-5ee8-8aae-3f567f8a3819"\n`,
    )
    writeFileSync(join(env, "Manifest.toml"), `julia_version = "1.11.0"\n\n[[deps.Piccolo]]\nversion = "1.19.0"\n`)
    const result = runGate(spec({ env: { kind: "project", project: env } }), "using Piccolo\n", authoring())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/stale env.*JLD2.*re-instantiate/)
    // consistent pair passes
    writeFileSync(
      join(env, "Manifest.toml"),
      `julia_version = "1.11.0"\n\n[[deps.Piccolo]]\nversion = "1.19.0"\n\n[[deps.JLD2]]\nversion = "0.5.0"\n`,
    )
    expect(runGate(spec({ env: { kind: "project", project: env } }), "using Piccolo\n", authoring()).ok).toBe(true)
  })
  it("step 3: non-local executor rejected at schema level", () => {
    const result = runGate(spec({ executor: "cloud" }), "using Piccolo\n", authoring())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/executor/)
  })
  it("step 4: composed — inside-fill-point edits pass; outside edits reject with demote_to", () => {
    const sandboxSpec = spec({ tier: "composed", source: { exemplar_id: "ex-1" } })
    const filled = EXEMPLAR_SCRIPT.replace("T = 10.0", "T = 25.0")
    expect(runGate(sandboxSpec, filled, authoring()).ok).toBe(true)
    const hacked = EXEMPLAR_SCRIPT.replace("solve()", "solve!(other_physics)")
    const result = runGate(sandboxSpec, hacked, authoring())
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/no longer the exemplar/)
      expect(result.demote_to).toBe("free")
    }
  })
  it("step 4: composed without exemplar_id → clear reason", () => {
    const result = runGate(spec({ tier: "composed" }), EXEMPLAR_SCRIPT, authoring())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/exemplar_id/)
  })
  it("step 5: pass returns the stamp; spec_hash is gate-computed and spec-sensitive", () => {
    const specA = spec({ hashes: { system_hash: "sha256:ab" } })
    const resultA = runGate(specA, "using Piccolo\n", authoring())
    expect(resultA.ok).toBe(true)
    if (resultA.ok) {
      expect(resultA.stamp.tier).toBe("vetted")
      expect(resultA.stamp.hashes.system_hash).toBe("sha256:ab")
      expect(resultA.stamp.hashes.spec_hash).toMatch(/^sha256:/)
      expect(JSON.parse(resultA.stamp.specCanonical)).toMatchObject({ tier: "vetted" })
      const resultB = runGate(spec({ hashes: { system_hash: "sha256:cd" } }), "using Piccolo\n", authoring())
      if (resultB.ok) expect(resultB.stamp.hashes.spec_hash).not.toBe(resultA.stamp.hashes.spec_hash)
    }
  })
  it("v1 specs (no tier) pass through with import scan only", () => {
    const v1 = { schema_version: "1", script_path: "/s.jl", lab_id: "default" }
    expect(runGate(v1, "using Piccolo\n", authoring()).ok).toBe(true)
    expect(runGate(v1, "using Zygote\n", authoring()).ok).toBe(false)
  })
})
