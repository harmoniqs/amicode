import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  adoptExplorerIconTheme,
  explorerIconAssetUrl,
  resolveExplorerFileIcon,
  resetExplorerIconTheme,
} from "./vscode-explorer-icon-theme"

afterEach(() => resetExplorerIconTheme())

describe("VS Code Explorer icon theme bridge", () => {
  test("requests the theme on app boot and adopts only the reply envelope", () => {
    const app = readFileSync(resolve(__dirname, "..", "app.tsx"), "utf8")

    expect(app).toContain('kind: "explorer-icon-theme-request"')
    expect(app).toContain('d.kind === "explorer-icon-theme"')
    expect(app).toContain("adoptExplorerIconTheme(d.theme)")
  })

  test("resolves exact-name and extension icons from opaque assets", () => {
    adoptExplorerIconTheme({
      mode: "svg",
      assets: {
        "asset-0": { mime: "image/svg+xml", data: "PHN2Zy8+" },
        "asset-1": { mime: "image/svg+xml", data: "PHN2Zy8+" },
      },
      fileExtensions: {
        md: { kind: "svg", asset: "asset-0" },
        png: { kind: "svg", asset: "asset-0" },
        ts: { kind: "svg", asset: "asset-0" },
        "d.ts": { kind: "svg", asset: "asset-1" },
      },
      fileNames: { "README.md": { kind: "svg", asset: "asset-0" } },
    })

    expect(resolveExplorerFileIcon("/research/README.md")).toEqual({ kind: "svg", asset: "asset-0" })
    expect(resolveExplorerFileIcon("/research/notes.md")).toEqual({ kind: "svg", asset: "asset-0" })
    expect(resolveExplorerFileIcon("/research/plot.png")).toEqual({ kind: "svg", asset: "asset-0" })
    expect(resolveExplorerFileIcon("/research/types.d.ts")).toEqual({ kind: "svg", asset: "asset-1" })
    expect(explorerIconAssetUrl("asset-0")).toBe("data:image/svg+xml;base64,PHN2Zy8+")
  })

  test("rejects malformed assets instead of creating a file transport", () => {
    adoptExplorerIconTheme({
      mode: "svg",
      assets: { "../../etc/passwd": { mime: "image/svg+xml", data: "PHN2Zy8+" } },
      fileExtensions: { md: { kind: "svg", asset: "../../etc/passwd" } },
      fileNames: {},
    })

    expect(resolveExplorerFileIcon("/research/notes.md")).toBeUndefined()
    expect(explorerIconAssetUrl("../../etc/passwd")).toBeUndefined()
  })
})
