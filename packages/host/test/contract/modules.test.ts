// Contract: the upstream modules the host imports, asserted against the PUBLISHED packages. One describe per
// specifier ("contract: <specifier>"), one test per symbol and per used member, all derived from registry.ts —
// which scripts/contract-scan.ts holds equal to what the host's sources actually import (coverage.test.ts).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { behaviours } from "./behaviours.ts"
import { CONTRACTS } from "./registry.ts"
import { cleanupContract, packageRoot, runProbe } from "./support.ts"

afterAll(cleanupContract)

type ProbeOutput = { results: Record<string, string | null>; scenarios: Record<string, string | null> }
let probe: ProbeOutput

beforeAll(() => {
  const run = runProbe()
  const last = run.stdout.trim().split("\n").pop() ?? ""
  try {
    probe = JSON.parse(last) as ProbeOutput
  } catch {
    throw new Error(`contract probe produced no result (exit ${run.exitCode}):\n${run.stdout.slice(-800)}\n${run.stderr.slice(-800)}`)
  }
}, 120_000)

const pkgJson = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")) as { dependencies: Record<string, string> }

/** `@opencode/core/session/x` -> `@opencode/core`; `effect/http` -> `effect`. */
const packageOf = (specifier: string) => specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/")

for (const [specifier, module] of Object.entries(CONTRACTS)) {
  describe(`contract: ${specifier}`, () => {
    test("resolves from the published package (a node_modules copy at the pinned version, not a workspace link)", () => {
      const resolved = Bun.resolveSync(specifier, packageRoot)
      const real = fs.realpathSync(resolved)
      expect(real).toContain(`${path.sep}node_modules${path.sep}`)
      // the nearest package.json named after the package gives the installed version
      let dir = path.dirname(real)
      while (!fs.existsSync(path.join(dir, "package.json")) || JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).name !== packageOf(specifier)) {
        const parent = path.dirname(dir)
        if (parent === dir) throw new Error(`no ${packageOf(specifier)} package.json above ${real}`)
        dir = parent
      }
      expect(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version).toBe(pkgJson.dependencies[packageOf(specifier)]!)
    })

    test("loads", () => {
      expect(probe.results[specifier]).toBeNull()
    })

    for (const [symbol, shape] of Object.entries(module)) {
      test(`${symbol} has the shape the host relies on (${shape.is})`, () => {
        expect(probe.results[`${specifier}#${symbol}`]).toBeNull()
      })
      for (const member of Object.keys(shape.members ?? {})) {
        test(`${symbol}.${member} has the shape the host relies on (${shape.members![member]!.is})`, () => {
          expect(probe.results[`${specifier}#${symbol}.${member}`]).toBeNull()
        })
      }
    }
  })
}

describe("contract: behaviours the host depends on", () => {
  test("every behavioural scenario ran", () => {
    expect(Object.keys(probe.scenarios).length).toBeGreaterThan(0)
  })
  test.each(Object.keys(behaviours))("%s", (name) => {
    expect(probe.scenarios[name]).toBeNull()
  })
})
