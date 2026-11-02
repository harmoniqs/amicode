// The plugin API is pinned exactly like the rest of the peer set: a hook rename in a newer @opencode/plugin must
// fail here, not in production. (seam.test.ts pins the engine packages; this adds @opencode/plugin to the set.)
import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../..")
const read = (...parts: string[]) => JSON.parse(fs.readFileSync(path.join(root, ...parts), "utf8"))

describe("@opencode/plugin pin", () => {
  test("is an exact version, installed as declared, and the same version as @opencode/server", () => {
    const pkg = read("package.json")
    expect(pkg.dependencies["@opencode/plugin"]).toMatch(/^\d+\.\d+\.\d+$/)
    expect(read("node_modules/@opencode/plugin/package.json").version).toBe(pkg.dependencies["@opencode/plugin"])
    expect(pkg.dependencies["@opencode/plugin"]).toBe(pkg.dependencies["@opencode/server"])
  })
  test("the hooks the host's plugins use still exist on the installed plugin API", () => {
    const dist = path.join(root, "node_modules/@opencode/plugin/dist/promise")
    const session = fs.readFileSync(path.join(dist, "session.d.ts"), "utf8")
    for (const hook of ["readonly prompt:", "readonly context:", 'readonly "model.request":', 'readonly "http.request":']) expect(session).toContain(hook)
    expect(fs.readFileSync(path.join(dist, "permission.d.ts"), "utf8")).toContain("readonly evaluate")
    expect(fs.readFileSync(path.join(dist, "tool.d.ts"), "utf8")).toContain('"execute.before"')
    expect(fs.readFileSync(path.join(dist, "shell.d.ts"), "utf8")).toContain('"create.before"')
    expect(fs.readFileSync(path.join(dist, "model.d.ts"), "utf8")).toContain("readonly default")
  })
})
