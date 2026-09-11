import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { decodeExplorerGlyph } from "./vscode-explorer-file-icon"

describe("ExplorerFileIcon", () => {
  test("uses the validated opaque asset resolver and decodes font-theme glyphs", () => {
    const source = readFileSync(resolve(__dirname, "vscode-explorer-file-icon.tsx"), "utf8")

    expect(source).toContain("explorerIconAssetUrl(current.asset)")
    expect(source).toContain('data-component="vscode-explorer-file-icon"')
    expect(decodeExplorerGlyph("\\E02A")).toBe(String.fromCodePoint(0xE02A))
  })
})
