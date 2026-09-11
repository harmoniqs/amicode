import { describe, expect, test } from "bun:test"
import { promptDesignPlaceholder, promptPlaceholder } from "./placeholder"

// harmoniqs/amicode#964 — the design placeholder takes the translate callback
// (the #929 contract, mirrored to the sync source). A 2-arg call passes
// undefined as the translate callback, which the helper calls in the
// non-shell branch: the "n is not a function" failure Aaron hit live
// post-cutover 2026-09-10.
describe("promptDesignPlaceholder", () => {
  const t = (key: string, params?: Record<string, string>) => {
    let out = key
    for (const [k, v] of Object.entries(params ?? {})) out = out.split(`{{${k}}}`).join(v)
    return out
  }

  test("returns the shell placeholder verbatim in shell mode", () => {
    expect(promptDesignPlaceholder("shell", "git status", t)).toBe("git status")
  })

  test("translates through the callback in normal mode", () => {
    expect(promptDesignPlaceholder("normal", "fallback", t)).toBe(
      "ui.promptInput.placeholder.normal",
    )
  })

  test("the translate callback is REQUIRED — the regressed 2-arg call throws", () => {
    expect(() =>
      (promptDesignPlaceholder as unknown as (mode: "normal", placeholder: string) => string)(
        "normal",
        "fallback",
      ),
    ).toThrow(/is not a function/)
  })
})

describe("promptPlaceholder", () => {
  const t = (key: string, params?: Record<string, string>) => `${key}${params?.example ? `:${params.example}` : ""}`

  test("returns shell placeholder in shell mode", () => {
    const value = promptPlaceholder({
      mode: "shell",
      commentCount: 0,
      example: "example",
      suggest: true,
      t,
    })
    expect(value).toBe("prompt.placeholder.shell:example")
  })

  test("returns summarize placeholders for comment context", () => {
    expect(promptPlaceholder({ mode: "normal", commentCount: 1, example: "example", suggest: true, t })).toBe(
      "prompt.placeholder.summarizeComment",
    )
    expect(promptPlaceholder({ mode: "normal", commentCount: 2, example: "example", suggest: true, t })).toBe(
      "prompt.placeholder.summarizeComments",
    )
  })

  test("returns default placeholder with example when suggestions enabled", () => {
    const value = promptPlaceholder({
      mode: "normal",
      commentCount: 0,
      example: "translated-example",
      suggest: true,
      t,
    })
    expect(value).toBe("prompt.placeholder.normal:translated-example")
  })

  test("returns simple placeholder when suggestions disabled", () => {
    const value = promptPlaceholder({
      mode: "normal",
      commentCount: 0,
      example: "translated-example",
      suggest: false,
      t,
    })
    expect(value).toBe("prompt.placeholder.simple")
  })
})
