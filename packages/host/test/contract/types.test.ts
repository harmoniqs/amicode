// Type-only contracts. Some upstream symbols are used by the host only as types (`Plugin.Plugin`, `Effect.Effect`):
// nothing exists at runtime to assert, so their gate is the TypeScript compiler. types.contract.ts is a small
// program that uses every type-only symbol the registry names, in the way src/ uses it; this test compiles it with
// the compiler API (so `bun test` alone catches a renamed/removed type, without a separate `tsc` run) and checks
// that the file really mentions every type-only contract.
import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { CONTRACTS, contractShapes } from "./registry.ts"
import { typeCheck } from "./typecheck.ts"

const file = path.join(import.meta.dir, "types.contract.ts")

describe("contract: type-only symbols", () => {
  test("types.contract.ts compiles against the installed published packages", () => {
    expect(typeCheck(file)).toEqual([])
  }, 120_000)

  test("every type-only contract in the registry is exercised in types.contract.ts", () => {
    const text = fs.readFileSync(file, "utf8")
    const missing = [...contractShapes(CONTRACTS)]
      .filter(([, shape]) => shape?.is === "type")
      .map(([id]) => id.split("#")[1]!)
      .filter((reference) => !text.includes(reference))
    expect(missing).toEqual([])
  })
})
