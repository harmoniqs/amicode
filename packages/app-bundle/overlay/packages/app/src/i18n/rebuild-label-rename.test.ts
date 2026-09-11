import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

// ============================================================================
// The devtools "rebuild from remote" button label was renamed away from its
// old wording (#940) — the old label was inaccurate (the remote rebuild
// pulls different tracked branches for the opencode vs. amicode repos, not
// "latest" in any single sense). This regression test guards against a
// partial rename: every locale's key must carry the new label, and no
// stale reference (including code comments) may remain anywhere in the
// app package's source tree.
// ============================================================================

const OLD_LABEL = ["Rebuild", "from", "Latest"].join(" ")
const NEW_LABEL = "Rebuild from Main"

const i18nDir = dirname(fileURLToPath(import.meta.url))
const appSrcDir = join(i18nDir, "..")
const selfFile = fileURLToPath(import.meta.url)

function walkTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...walkTsFiles(full))
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      out.push(full)
    }
  }
  return out
}

describe("devtools rebuild-remotely label rename (#940)", () => {
  test("no source file under the app package still carries the old label", () => {
    const offenders = walkTsFiles(appSrcDir).filter(
      (file) => file !== selfFile && readFileSync(file, "utf8").includes(OLD_LABEL),
    )
    expect(offenders).toEqual([])
  })

  test("en.ts carries the new label for the rebuildRemotely key", async () => {
    const module: unknown = await import("./en")
    if (typeof module !== "object" || module === null || !("dict" in module)) {
      throw new Error("Invalid en.ts dictionary module")
    }
    const dict = (module as { dict: Record<string, string> }).dict
    expect(dict["settings.general.row.devTools.rebuildRemotely"]).toBe(NEW_LABEL)
  })
})
