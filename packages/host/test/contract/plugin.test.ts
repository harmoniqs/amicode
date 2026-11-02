// Contract: the plugin registration entry point (#2062 builds on it). `SdkPlugins.Service.register(plugin)` is how an
// embedder contributes an in-process plugin; the plugin's `effect` runs when a Location boots. Asserted against the
// published packages in a sandboxed child process, built the way server-seam.ts builds its routes.
import { afterAll, describe, expect, test } from "bun:test"
import path from "node:path"
import { hostEnv } from "../helpers.ts"
import { cleanupContract, contractSandbox, packageRoot } from "./support.ts"

afterAll(cleanupContract)

describe("contract: plugin registration (@opencode/core/plugin/sdk)", () => {
  const sb = contractSandbox("plugin")
  const run = Bun.spawnSync([process.execPath, path.join(import.meta.dir, "plugin-probe.ts")], {
    cwd: packageRoot,
    env: hostEnv(sb, { CONTRACT_WORK_DIR: sb.work, CONTRACT_CONFIG_DIR: sb.serverConfig }),
    stdout: "pipe",
    stderr: "pipe",
  })
  const output = run.stdout.toString().trim().split("\n").pop() ?? ""
  const result = (() => {
    try {
      return JSON.parse(output) as Record<string, unknown>
    } catch {
      return { parseError: `no result (exit ${run.exitCode}): ${run.stderr.toString().slice(-600)}` }
    }
  })()

  test("the probe ran", () => {
    expect(result.parseError).toBeUndefined()
  })
  test("SdkPlugins.Service exposes register() and all()", () => {
    expect(result.registerIsFunction).toBe(true)
    expect(result.allIsFunction).toBe(true)
  })
  test("register() adds exactly one plugin generation", () => {
    expect(result.before).toBe(0)
    expect(result.after).toBe(1)
  })
  test("a registered plugin's effect runs once its Location boots (a Location-scoped request boots it)", () => {
    expect(result.bootStatus).toBe(200)
    expect(result.ran).toEqual(["effect-ran"])
  })
  test("GET /api/plugin keeps answering { data: [] } shape alongside in-process plugins", () => {
    expect(result.listedStatus).toBe(200)
    expect(result.listedIsArray).toBe(true)
  })
})
