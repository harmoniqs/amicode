import { readFileSync } from "node:fs"
import { describe, expect, test } from "bun:test"

// ============================================================================
// The devtools "Developer Tools" section header and its rebuild status
// indicator (#940) sit side by side in a flex row. They use different font
// sizes, so align-items: center centers their line boxes but puts the status
// text's baseline slightly below the title's. Baseline alignment fixes that;
// .settings-v2-section-title also carries a padding-bottom meant for the
// normal case where a title sits above a settings list, so it must be reset
// in this row. The existing
// .settings-v2-providers and .settings-v2-models sections already override
// this padding to 0 for the same reason; this extends that same override to
// the devtools header.
// ============================================================================

function extractRule(css: string, selector: string): string {
  const start = css.indexOf(selector)
  if (start === -1) throw new Error(`selector "${selector}" not found`)
  const braceOpen = css.indexOf("{", start)
  const braceClose = css.indexOf("}", braceOpen)
  return css.slice(start, braceClose + 1)
}

describe("devtools section header title alignment (#940)", () => {
  test("the header aligns the title and status text on their shared baseline", () => {
    const css = readFileSync(new URL("./amicode.css", import.meta.url), "utf8")
    const rule = extractRule(css, ".devtools-section-header {")
    expect(rule).toContain("align-items: baseline")
  })

  test("the title's padding-bottom is zeroed out inside the devtools header, matching the providers/models precedent", () => {
    const css = readFileSync(new URL("./amicode.css", import.meta.url), "utf8")
    const rule = extractRule(css, ".devtools-section-header .settings-v2-section-title")
    expect(rule).toMatch(/padding-bottom:\s*0/)
  })
})
