// The seam's contract with the published opencode packages: exact pins, and the exact surface server-seam.ts uses.
// Drift (a bumped pin that renames an export) must fail here, not at 3 a.m. in production.
import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { cleanup, hostEnv, makeSandbox } from "./helpers.ts"

afterAll(cleanup)

const root = path.resolve(import.meta.dir, "..")
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { dependencies: Record<string, string> }
const PINNED = ["@opencode/core", "@opencode/protocol", "@opencode/schema", "@opencode/sdk", "@opencode/server", "effect"]

describe("pinned peer set", () => {
  test.each(PINNED)("%s is pinned to an exact version (no ranges) and the installed copy matches", (name) => {
    const declared = pkg.dependencies[name]
    expect(declared).toMatch(/^\d+\.\d+\.\d+$/)
    const installed = JSON.parse(fs.readFileSync(path.join(root, "node_modules", name, "package.json"), "utf8")).version
    expect(installed).toBe(declared)
  })
  test("all @opencode packages share one version, and effect is the version they pin", () => {
    expect(new Set(PINNED.filter((n) => n.startsWith("@opencode/")).map((n) => pkg.dependencies[n])).size).toBe(1)
    const server = JSON.parse(fs.readFileSync(path.join(root, "node_modules/@opencode/server/package.json"), "utf8"))
    expect(server.dependencies.effect).toBe(pkg.dependencies.effect)
  })
})

describe("surface used by server-seam.ts", () => {
  // Run in a child process under a sandbox: the engine computes (and may create) its global dirs at import time.
  test("createRoutes, SessionRestart.resumeSuspendedSessions and the web-handler helpers exist", () => {
    const sb = makeSandbox("seam")
    const script = `
      const { createRoutes } = await import("@opencode/server/routes")
      const { SessionRestart } = await import("@opencode/core/session/execution/restart")
      const { Context, Effect, Exit, Layer, Scope } = await import("effect")
      const { HttpEffect, HttpMiddleware, HttpRouter, HttpServer } = await import("effect/http")
      const shape = {
        createRoutes: typeof createRoutes,
        createRoutesArity: createRoutes.length <= 3,
        restartTag: typeof SessionRestart.Service,
        restartLayer: typeof SessionRestart.layer,
        effect: [Context.get, Effect.runPromise, Effect.runFork, Exit.void, Layer.buildWithScope, Scope.make, Scope.close, Scope.addFinalizer].every((x) => x !== undefined),
        http: [HttpEffect.toWebHandlerWith, HttpMiddleware.make, HttpRouter.HttpRouter, HttpServer.layerServices].every((x) => x !== undefined),
      }
      console.log(JSON.stringify(shape))
    `
    const run = Bun.spawnSync([process.execPath, "-e", script], { cwd: root, env: hostEnv(sb), stdout: "pipe", stderr: "pipe" })
    expect(run.stderr.toString()).toBe("")
    expect(JSON.parse(run.stdout.toString())).toEqual({
      createRoutes: "function",
      createRoutesArity: true,
      restartTag: "function",
      restartLayer: "function",
      effect: true,
      http: true,
    })
  })
})
