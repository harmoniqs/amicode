// The planted-break drill: the suite must be PROVEN capable of failing. Both drills run in the default `bun test`.
//   (a) scanner drill — copy the host sources, plant an import of a symbol that has no contract, and assert the
//       scan fails naming exactly that pair (and passes on the untouched copy).
//   (b) suite drill — copy the host package with its module resolution rewired so one used upstream export is
//       removed (shim.ts), run the real contract suite inside the copy in a child `bun test`, and assert it FAILS
//       on exactly that export while the rest stays green.
import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { plantBreak } from "./shim.ts"
import { bunEnv, packageRoot } from "./support.ts"

const cleanups: (() => void)[] = []
afterAll(() => cleanups.forEach((fn) => fn()))

const bun = (args: string[], cwd: string) => {
  const run = Bun.spawnSync([process.execPath, ...args], { cwd, env: bunEnv(), stdout: "pipe", stderr: "pipe" })
  return { exitCode: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString(), all: run.stdout.toString() + run.stderr.toString() }
}

describe("drill (a): the scan fails when an upstream import has no contract", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "h1d-drill-"))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  const src = path.join(dir, "src")
  fs.cpSync(path.join(packageRoot, "src"), src, { recursive: true })

  test("control: the untouched copy of src/ scans clean", () => {
    const run = bun(["scripts/contract-scan.ts", "--root", src], packageRoot)
    expect(run.exitCode).toBe(0)
  })

  test("a planted import of a symbol nobody has a contract for fails the scan and is named", () => {
    fs.writeFileSync(
      path.join(src, "planted.ts"),
      [
        `import { definitelyNotThere } from "@opencode/server/routes"`,
        `import { Ghost } from "@opencode/ghost/thing"`,
        `import { Effect } from "effect"`,
        `void [definitelyNotThere, Ghost, Effect.notARealMember]`,
        `export async function late() { const { lateBinding } = await import("@opencode/core/plugin/sdk"); return lateBinding }`,
      ].join("\n"),
    )
    const run = bun(["scripts/contract-scan.ts", "--root", src], packageRoot)
    expect(run.exitCode).toBe(1)
    expect(run.err).toContain("@opencode/server/routes#definitelyNotThere")
    expect(run.err).toContain("@opencode/ghost/thing")
    expect(run.err).toContain("@opencode/ghost/thing#Ghost")
    expect(run.err).toContain("effect#Effect.notARealMember")
    expect(run.err).toContain("@opencode/core/plugin/sdk#lateBinding")
    // and it does not cry wolf about pairs that do have contracts
    expect(run.err).not.toContain("@opencode/server/routes#createRoutes")
  })

  test("--json reports the same uncovered pairs", () => {
    const run = bun(["scripts/contract-scan.ts", "--json", "--root", src], packageRoot)
    expect(run.exitCode).toBe(1)
    expect(JSON.parse(run.out).uncovered).toContain("@opencode/server/routes#definitelyNotThere")
  })
})

describe("drill (b): the contract suite fails when a used upstream export disappears", () => {
  const ALWAYS = ["test/contract/modules.test.ts"]
  const failures = (all: string) => all.split("\n").filter((line) => line.startsWith("(fail)"))

  test("control: the unbroken package copy passes the module contracts (so the failures below are the planted break)", () => {
    const planted = plantBreak("@opencode/server/routes#createEmbeddedRoutes")
    cleanups.push(planted.cleanup)
    // removes an export of the same module that the host does not use: nothing the contract names may fail.
    const run = bun(["test", ...ALWAYS], planted.copy)
    expect(run.exitCode).toBe(0)
    expect(failures(run.all)).toEqual([])
  }, 120_000)

  test("createRoutes removed from @opencode/server/routes: the suite fails and names it, module tests and e2e alike", () => {
    const planted = plantBreak("@opencode/server/routes#createRoutes")
    cleanups.push(planted.cleanup)
    const run = bun(["test", ...ALWAYS, "test/contract/plugin.test.ts", "test/contract/http.test.ts", "test/contract/client.test.ts"], planted.copy)
    expect(run.exitCode).not.toBe(0)
    const failed = failures(run.all)
    expect(failed.some((line) => line.includes("contract: @opencode/server/routes > createRoutes has the shape"))).toBe(true)
    // the plugin probe builds the routes the way the seam does: it fails, naming the missing export
    expect(failed.some((line) => line.includes("contract: plugin registration"))).toBe(true)
    // the host process itself cannot start without it, so the end-to-end suites (HTTP, event stream, client) fail
    // in their setup, with the reason on record
    expect(run.all).toContain("host exited early")
    expect(run.all).toContain("createRoutes is not a function")
    expect(run.all).toMatch(/\b[3-9]\d* fail\b|\b\d{2,} fail\b/)
    // the other module contracts are unaffected: the failure is localised, not a blanket red
    expect(failed.some((line) => line.includes("contract: effect >"))).toBe(false)
    expect(failed.some((line) => line.includes("SessionRestart"))).toBe(false)
  }, 240_000)

  test("Scope.close removed from effect: the module contract names the member and the behaviour that relies on it", () => {
    const planted = plantBreak("effect#Scope.close")
    cleanups.push(planted.cleanup)
    const run = bun(["test", ...ALWAYS], planted.copy)
    expect(run.exitCode).not.toBe(0)
    const failed = failures(run.all)
    expect(failed.some((line) => line.includes("contract: effect > Scope.close has the shape"))).toBe(true)
    expect(failed.some((line) => line.includes("Scope finalizers run last-registered-first"))).toBe(true)
    expect(failed.some((line) => line.includes("Scope.make"))).toBe(false)
  }, 120_000)
})
