import { expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

// #1834: stdout is the CLI data channel (`opencode run --format json`).
// Request/stream handlers run inside CLI processes too, so they must never
// write to stdout — engine telemetry goes to stderr / the logger.
test("server route handlers never write to stdout", () => {
  const root = path.join(import.meta.dir, "../../src/server/routes")
  const offenders: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name)
      if (statSync(file).isDirectory()) walk(file)
      else if (/\.tsx?$/.test(name)) {
        readFileSync(file, "utf8")
          .split("\n")
          .forEach((line, i) => {
            if (/\bconsole\.(log|info)\(/.test(line)) offenders.push(`${path.relative(root, file)}:${i + 1}`)
          })
      }
    }
  }
  walk(root)
  expect(offenders).toEqual([])
})
