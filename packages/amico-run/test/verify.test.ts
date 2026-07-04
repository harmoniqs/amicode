import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runVerification } from "../src/verify.js"
import { readToml } from "./helpers.js"
import type { AuthoringConfig } from "../src/authoring.js"
import type { SpecStamp } from "../src/types.js"

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "amico-verify-"))
})
afterEach(() => {
  delete process.env.AMICO_VERIFY_RUNNER
  rmSync(root, { recursive: true, force: true })
})

// A fake harness = a node script that writes verification.toml into argv[1] (the run dir).
function fakeHarness(name: string, body: string): string {
  const p = join(root, name)
  writeFileSync(p, `#!/usr/bin/env node\n${body}\n`)
  chmodSync(p, 0o755)
  return p
}

function authoring(harness?: string): AuthoringConfig {
  return {
    allowlist: [],
    support_set: [],
    verify_harness: harness,
    verify_tolerance: 0.01,
  }
}
const FREE_SPEC: SpecStamp = { canonical: "{}", tier: "free" }

describe("runVerification", () => {
  it("harness writes verification.toml → left intact", async () => {
    const runDir = join(root, "run")
    mkdirSync(runDir)
    const harness = fakeHarness(
      "h.js",
      `const fs=require('fs'),p=require('path');fs.writeFileSync(p.join(process.argv[2],'verification.toml'),'schema_version = "1"\\nagree = true\\nfidelity_rerolled = 0.998\\n')`,
    )
    process.env.AMICO_VERIFY_RUNNER = "node"
    await runVerification(runDir, FREE_SPEC, authoring(harness))
    const v = readToml(join(runDir, "verification.toml"))
    expect(v.agree).toBe(true)
    expect(v.fidelity_rerolled).toBe(0.998)
  })
  it("missing harness path → fallback verification.toml agree=false + error", async () => {
    const runDir = join(root, "run")
    mkdirSync(runDir)
    await runVerification(runDir, FREE_SPEC, authoring(join(root, "nonexistent.jl")))
    const v = readToml(join(runDir, "verification.toml"))
    expect(v.agree).toBe(false)
    expect(String(v.error)).toMatch(/harness/)
  })
  it("harness exits nonzero WITHOUT writing → fallback agree=false + error", async () => {
    const runDir = join(root, "run")
    mkdirSync(runDir)
    const harness = fakeHarness("h.js", `process.exit(3)`)
    process.env.AMICO_VERIFY_RUNNER = "node"
    await runVerification(runDir, FREE_SPEC, authoring(harness))
    const v = readToml(join(runDir, "verification.toml"))
    expect(v.agree).toBe(false)
    expect(existsSync(join(runDir, "verification.toml"))).toBe(true)
  })
  it("no harness configured at all → fallback agree=false (never verification-less)", async () => {
    const runDir = join(root, "run")
    mkdirSync(runDir)
    await runVerification(runDir, FREE_SPEC, authoring(undefined))
    expect(existsSync(join(runDir, "verification.toml"))).toBe(true)
    expect(readToml(join(runDir, "verification.toml")).agree).toBe(false)
  })
})
