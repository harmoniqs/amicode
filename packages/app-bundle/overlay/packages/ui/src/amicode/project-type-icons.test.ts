import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { resolve } from "path"

const src = readFileSync(resolve(__dirname, "../v2/components/icon.tsx"), "utf-8")

describe("v2 icon sprite", () => {
  test("contains flask and code-brackets icons with 16x16 viewBox", () => {
    // flask is a valid identifier — key is unquoted in the source
    expect(src).toMatch(/\bflask:\s*\{/)
    expect(src).toMatch(/flask[\s\S]*?viewBox:\s*"0 0 16 16"/)
    // code-brackets must be quoted because of the hyphen
    expect(src).toContain('"code-brackets"')
    expect(src).toMatch(/code-brackets[\s\S]*?viewBox:\s*"0 0 16 16"/)
  })
})
