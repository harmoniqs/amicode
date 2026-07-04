import { describe, it, expect, beforeAll } from "vitest"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readToml } from "./helpers.js"

const BUNDLE = join(__dirname, "..", "dist", "amico-run.js")
beforeAll(() => {
  execFileSync("node", [join(__dirname, "..", "esbuild.config.mjs")], { cwd: join(__dirname, "..") })
})

function run(args: string[], env: Record<string, string> = {}): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("node", [BUNDLE, ...args], { encoding: "utf8", env: { ...process.env, ...env } })
    return { code: 0, stdout, stderr: "" }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { code: err.status ?? -1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" }
  }
}

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
[support]
packages = ["JLD2", "CairoMakie", "TOML", "Printf"]
[uuids]
Piccolo = "c4671d76-df94-11ed-2057-43d4fd632fad"
JLD2 = "033835bb-8acc-5ee8-8aae-3f567f8a3819"
`

function authoringDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "amico-sub-"))
  writeFileSync(join(dir, "registry.toml"), REGISTRY)
  writeFileSync(join(dir, "index.json"), JSON.stringify({ schema_version: 1, exemplars: [] }))
  writeFileSync(
    join(dir, "authoring.json"),
    JSON.stringify({
      schema_version: 1,
      allowlist: ["Piccolo", "Legato", "Intonato", "NamedTrajectories", "DirectTrajOpt"],
      support_set: ["JLD2", "CairoMakie", "TOML", "Printf"],
      registry: join(dir, "registry.toml"),
      exemplars: join(dir, "index.json"),
      verify_tolerance: 0.01,
    }),
  )
  return dir
}

describe("resolve subcommand", () => {
  it("exact vetted shape → tier vetted with template_path + packages", () => {
    const dir = authoringDir()
    const r = run(["resolve", "--platform", "transmon", "--kind", "gate_synthesis", "--size", "1"], {
      AMICO_AUTHORING_FILE: join(dir, "authoring.json"),
    })
    expect(r.code).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.tier).toBe("vetted")
    expect(out.template_path).toMatch(/solve_template\.jl$/)
    expect(out.packages).toContain("Piccolo")
    rmSync(dir, { recursive: true, force: true })
  })
  it("unknown shape → tier free WITH the skeleton's minimum package set", () => {
    const dir = authoringDir()
    const r = run(["resolve", "--platform", "ions", "--kind", "gate_synthesis", "--size", "1"], {
      AMICO_AUTHORING_FILE: join(dir, "authoring.json"),
    })
    const out = JSON.parse(r.stdout)
    expect(out.tier).toBe("free")
    expect(out.packages).toEqual(expect.arrayContaining(["Piccolo", "CairoMakie", "JLD2", "TOML", "Printf"]))
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("sandbox subcommand", () => {
  it("writes env/Project.toml with [deps] uuids + prints instantiate instructions", () => {
    const dir = authoringDir()
    const target = mkdtempSync(join(tmpdir(), "amico-ws-"))
    const r = run(["sandbox", target, "--packages", "Piccolo,JLD2"], {
      AMICO_AUTHORING_FILE: join(dir, "authoring.json"),
    })
    expect(r.code).toBe(0)
    expect(existsSync(join(target, "env", "Project.toml"))).toBe(true)
    const proj = readToml(join(target, "env", "Project.toml"))
    const deps = proj.deps as Record<string, string>
    expect(deps.Piccolo).toBe("c4671d76-df94-11ed-2057-43d4fd632fad")
    expect(deps.JLD2).toBe("033835bb-8acc-5ee8-8aae-3f567f8a3819")
    expect(r.stdout).toContain("JULIA_PKG_USE_CLI_GIT=true")
    expect(r.stdout).toContain("Pkg.instantiate()")
    rmSync(dir, { recursive: true, force: true })
    rmSync(target, { recursive: true, force: true })
  })
  it("unknown package (no uuid in registry) → exit 64 naming it", () => {
    const dir = authoringDir()
    const target = mkdtempSync(join(tmpdir(), "amico-ws-"))
    const r = run(["sandbox", target, "--packages", "Piccolo,Zygote"], {
      AMICO_AUTHORING_FILE: join(dir, "authoring.json"),
    })
    expect(r.code).toBe(64)
    expect(r.stderr).toMatch(/Zygote/)
    rmSync(dir, { recursive: true, force: true })
    rmSync(target, { recursive: true, force: true })
  })
})
