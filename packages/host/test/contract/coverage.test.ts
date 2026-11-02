// The gate: every upstream (specifier, symbol, member) the host's sources use must be named by a contract in
// registry.ts. This test runs in the default `bun test`, so the scan cannot be skipped.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { coverage, scanSources } from "../../scripts/contract-scan.ts"
import { CONTRACTS, DYNAMIC_IMPORTS } from "./registry.ts"
import { bunEnv, packageRoot } from "./support.ts"

describe("contract coverage of the host's upstream imports", () => {
  const inventory = scanSources([path.join(packageRoot, "src"), path.join(packageRoot, "bin")])

  test("the inventory is not empty (the scan is actually seeing the host's imports)", () => {
    expect(inventory.entries.length).toBeGreaterThan(0)
    expect(inventory.entries.map((e) => e.specifier)).toContain("@opencode/server/routes")
  })

  test("every (specifier, symbol, member) the host uses has a contract", () => {
    expect(coverage(inventory, CONTRACTS).uncovered).toEqual([])
  })

  test("a contract may not call a value the host uses at runtime 'type-only'", () => {
    expect(coverage(inventory, CONTRACTS).mismatched).toEqual([])
  })

  test("the CLI agrees with the library: exit 0, and --json lists no uncovered pair", () => {
    const run = Bun.spawnSync([process.execPath, "scripts/contract-scan.ts", "--json"], { cwd: packageRoot, env: bunEnv(), stdout: "pipe", stderr: "pipe" })
    expect(run.exitCode).toBe(0)
    const report = JSON.parse(run.stdout.toString())
    expect(report.uncovered).toEqual([])
    expect(report.inventory.entries.length).toBe(inventory.entries.length)
  })

  test("every dynamic import with a non-literal specifier is acknowledged in the registry allowlist (file + expression + reason)", () => {
    const result = coverage(inventory, CONTRACTS, DYNAMIC_IMPORTS)
    expect(result.unacknowledged.map((u) => `${u.file}:${u.line} ${u.text}`)).toEqual([])
  })

  test("every allowlist entry still matches a real import site, and says why it is allowed", () => {
    const result = coverage(inventory, CONTRACTS, DYNAMIC_IMPORTS)
    expect(result.staleAllowances.map((a) => `${a.file} ${a.text}`)).toEqual([])
    for (const allowance of DYNAMIC_IMPORTS) expect(allowance.reason.length).toBeGreaterThan(20)
  })
})
