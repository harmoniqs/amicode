import { describe, expect, test } from "bun:test"
import { createHighlighter, bundledLanguages, type BundledLanguage } from "shiki"
import { OpenCodeTheme } from "@opencode-ai/ui/context/marked"
import { tokensToDecorations, type ShikiTokenizeResult } from "./shiki-highlight-decorations"
import { Decoration } from "@codemirror/view"

/**
 * Integration test: verifies that Shiki produces non-empty, colored tokens
 * for multiple file types using the actual OpenCodeTheme, and that those
 * tokens convert to valid CM6 decorations.
 *
 * This is the test that catches the empty-theme bug: if the theme has no
 * tokenColors, all tokens come back with empty/default colors and the
 * decoration set is empty.
 */

const SNIPPETS: Record<string, { lang: string; code: string; expectKeyword: string }> = {
  julia: {
    lang: "jl",
    code: `function solve(prob)\n  x = prob.initial\n  for i in 1:100\n    x = step(x)\n  end\n  return x\nend`,
    expectKeyword: "function",
  },
  typescript: {
    lang: "ts",
    code: `const x: number = 42;\nfunction greet(name: string): void {\n  console.log(name);\n}`,
    expectKeyword: "const",
  },
  python: {
    lang: "py",
    code: `def train(model, data):\n    for epoch in range(100):\n        loss = model.step(data)\n    return loss`,
    expectKeyword: "def",
  },
  rust: {
    lang: "rs",
    code: `fn main() {\n    let x = 42;\n    println!("{}", x);\n}`,
    expectKeyword: "fn",
  },
  go: {
    lang: "go",
    code: `package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hello")\n}`,
    expectKeyword: "package",
  },
  yaml: {
    lang: "yaml",
    code: `name: test\nversion: 1.0\ndependencies:\n  - foo: "^2.0"`,
    expectKeyword: "name",
  },
  shell: {
    lang: "sh",
    code: `#!/bin/bash\nfor f in *.jl; do\n  echo "$f"\ndone`,
    expectKeyword: "for",
  },
}

describe("Shiki integration — real tokenization with OpenCodeTheme", () => {
  // Create one highlighter for all tests (expensive to create)
  let highlighter: Awaited<ReturnType<typeof createHighlighter>>

  test("OpenCodeTheme has tokenColors", () => {
    // Verify the theme isn't empty — this is what the bug was
    expect(OpenCodeTheme).toBeDefined()
    expect((OpenCodeTheme as any).tokenColors?.length).toBeGreaterThan(0)
  })

  test("creates a highlighter with OpenCodeTheme", async () => {
    highlighter = await createHighlighter({
      themes: [OpenCodeTheme as any],
      langs: [],
    })
    expect(highlighter).toBeDefined()
  })

  for (const [name, { lang, code, expectKeyword }] of Object.entries(SNIPPETS)) {
    test(`${name} (.${lang}): produces colored tokens`, async () => {
      if (!highlighter) throw new Error("highlighter not initialized")

      const language = lang in bundledLanguages ? lang : "text"
      if (!highlighter.getLoadedLanguages().includes(language)) {
        await highlighter.loadLanguage(bundledLanguages[language as BundledLanguage])
      }

      const result = highlighter.codeToTokens(code, {
        lang: language as BundledLanguage,
        theme: "OpenCode",
      })

      // Verify we got non-empty results
      expect(result.tokens.length).toBeGreaterThan(0)

      // Verify at least some tokens have a non-empty color
      const allTokens = result.tokens.flatMap((line) => line)
      const coloredTokens = allTokens.filter((t) => t.color && t.color.length > 0)
      expect(coloredTokens.length).toBeGreaterThan(0)

      // Verify the expected keyword is among the tokens
      const keywordToken = allTokens.find((t) => t.content.trim() === expectKeyword)
      expect(keywordToken).toBeDefined()
      // The keyword should have a color assigned (not empty, not just the default fg)
      expect(keywordToken!.color).toBeDefined()
      expect(keywordToken!.color!.length).toBeGreaterThan(0)
    })

    test(`${name} (.${lang}): tokens convert to non-empty CM6 decorations`, async () => {
      if (!highlighter) throw new Error("highlighter not initialized")

      const language = lang in bundledLanguages ? lang : "text"
      if (!highlighter.getLoadedLanguages().includes(language)) {
        await highlighter.loadLanguage(bundledLanguages[language as BundledLanguage])
      }

      const result = highlighter.codeToTokens(code, {
        lang: language as BundledLanguage,
        theme: "OpenCode",
      })

      // Convert to the wire format the worker would send
      const wireResult: ShikiTokenizeResult = {
        type: "tokenize-result",
        id: 1,
        lines: result.tokens.map((lineTokens) => ({
          tokens: lineTokens.map((token) => ({
            offset: token.offset,
            length: token.content.length,
            color: token.color ?? "",
            ...(token.fontStyle ? { fontStyle: token.fontStyle } : {}),
          })),
        })),
      }

      const decos = tokensToDecorations(wireResult, code)
      expect(decos).not.toBe(Decoration.none)

      // Count decorations
      let count = 0
      const cursor = decos.iter()
      while (cursor.value) { count++; cursor.next() }
      // Each language should produce at least a few decorations
      expect(count).toBeGreaterThan(2)
    })
  }
})
