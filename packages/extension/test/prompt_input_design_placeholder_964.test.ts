import { describe, expect, test } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// amicode#964 — the fork→overlay sync ff7b69c8 regressed #929's fix: the v2
// composer's design placeholder went back to the 2-arg call, but the
// materialized helper (upstream v1.18.29 prompt-input/placeholder.ts) takes
// THREE args and calls the third — the translate callback — in the non-shell
// branch. The 2-arg call passes undefined there: minified "n is not a
// function" on every non-shell composer render. Aaron hit it live
// post-cutover (2026-09-10) and fixed the deployed dist-app; #964 commits
// that fix to the overlay. This test pins the invocation contract.
//
// This is a SOURCE + contract-replica assertion rather than a rendered-DOM
// one — the app has no component-render harness (no @solidjs/testing-library;
// the same reason prompt-input-clipboard-structure.test.ts asserts source).
// Replace with a render assertion the day a harness lands.
const v2Source = readFileSync(
  join(
    __dirname,
    "..",
    "..",
    "app-bundle",
    "overlay",
    "packages",
    "app",
    "src",
    "components",
    "prompt-input-v2.tsx",
  ),
  "utf8",
)

// The upstream v1.18.29 helper contract (packages/app/src/components/
// prompt-input/placeholder.ts), reproduced verbatim: the overlay does not
// carry that file (it resolves from the materialized upstream base) and CI
// has no fork clone to read it from.
type PromptPlaceholderInput = {
  mode: "normal" | "shell"
  commentCount: number
  example: string
  suggest: boolean
  t: (key: string, params?: Record<string, string>) => string
}
type Translate = PromptPlaceholderInput["t"]
const promptDesignPlaceholder = (mode: PromptPlaceholderInput["mode"], placeholder: string, t: Translate) =>
  mode === "shell" ? placeholder : t("ui.promptInput.placeholder.normal", { slash: "/", at: "@" })

// The exact callback shape the component constructs (the language.t adapter
// in prompt-input-v2.tsx), over a fixture translation table.
const makeT = (translations: Record<string, string>): Translate => (key, params) => {
  let out = translations[key] ?? key
  for (const [k, v] of Object.entries(params ?? {})) out = out.split(`{{${k}}}`).join(v)
  return out
}

// Slice the source from the designPlaceholder call to its matching close
// paren (the call contains nested parens — the language.t adapter — so a
// naive indexOf(")") would truncate).
function callSite(source: string): string {
  const start = source.indexOf("promptDesignPlaceholder(")
  if (start === -1) return ""
  let depth = 0
  for (let i = start; i < source.length; i++) {
    if (source[i] === "(") depth++
    if (source[i] === ")") {
      depth--
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  return ""
}

describe("the v2 composer's design placeholder takes the translate callback (#964 / #929)", () => {
  test("the component's designPlaceholder passes a translate callback as the THIRD argument", () => {
    const call = callSite(v2Source)
    expect(call).toContain("promptDesignPlaceholder(mode(), placeholder(),")
    // the third argument is the language.t adapter, not a bare value
    expect(call).toContain("language.t(")
  })

  test("constructing the call the component makes resolves without throwing", () => {
    const t = makeT({ "ui.promptInput.placeholder.normal": "Ask anything, {{slash}} for commands, {{at}} for context..." })
    expect(promptDesignPlaceholder("normal", "fallback", t)).toBe("Ask anything, / for commands, @ for context...")
    expect(promptDesignPlaceholder("shell", "git status", t)).toBe("git status")
  })

  test("the regressed 2-arg call is the 'n is not a function' class of failure", () => {
    const t = makeT({})
    const twoArg = promptDesignPlaceholder as unknown as (mode: "normal", placeholder: string) => string
    expect(() => twoArg("normal", "fallback")).toThrow(TypeError)
    expect(() => twoArg("normal", "fallback")).toThrow(/is not a function/)
  })
})
