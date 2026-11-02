// The plugin-side wildcard must agree with the engine's, or a policy that reads right would behave differently.
import { afterAll, expect, test } from "bun:test"
import path from "node:path"
import { match } from "../../src/plugins/wildcard.ts"
import { cleanup, hostEnv, makeSandbox } from "../helpers.ts"

afterAll(cleanup)

const vectors: Array<[string, string]> = [
  ["git status", "git *"],
  ["git", "git *"],
  ["gitx", "git *"],
  ["/work/src/a.ts", "/work/**"],
  ["/workshop/a.ts", "/work/**"],
  ["/etc/passwd", "/work/**"],
  ["a.b", "a.b"],
  ["axb", "a.b"],
  ["a+b", "a+b"],
  ["C:\\x\\y", "C:/x/*"],
  ["line1\nline2", "line1*line2"],
  ["x", "?"],
  ["xy", "?"],
  ["/home/u/.env", "*.env"],
  ["/home/u/.env.example", "*.env.*"],
]

test("agrees with @opencode/core/util/wildcard on a table of inputs", () => {
  const sb = makeSandbox("wildcard")
  const script = `
    const { Wildcard } = await import("@opencode/core/util/wildcard")
    console.log(JSON.stringify(${JSON.stringify(vectors)}.map(([input, pattern]) => Wildcard.match(input, pattern))))
  `
  const run = Bun.spawnSync([process.execPath, "-e", script], { cwd: path.resolve(import.meta.dir, "../.."), env: hostEnv(sb), stdout: "pipe", stderr: "pipe" })
  expect(run.stderr.toString()).toBe("")
  expect(vectors.map(([input, pattern]) => match(input, pattern))).toEqual(JSON.parse(run.stdout.toString()))
})
