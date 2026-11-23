import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// #2016: with many session tabs open, each tab shrinks toward its 28px floor
// (`min-w-7`). At or below 64px the compact layout hides the title and centers
// the 20px close button. An opacity-0 (hover-reveal) button is still a live hit
// target, so on every narrow tab the close button covered almost the whole tab.
// Clicking a tab to select it closed it instead. The fix follows the browser
// convention: compact INACTIVE tabs drop the close button entirely, so a click
// anywhere selects the tab. The active tab keeps it, and middle-click still
// closes any tab.

const css = readFileSync(join(import.meta.dir, "titlebar-tab-nav.css"), "utf8")
const nav = readFileSync(join(import.meta.dir, "titlebar-tab-nav.tsx"), "utf8")

function containerBlock(source: string, query: string) {
  const start = source.indexOf(`@container ${query}`)
  if (start < 0) return ""
  let depth = 0
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    if (source[i] === "{") depth++
    if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1)
  }
  return ""
}

describe("titlebar tab close hit target (compact tabs)", () => {
  const compact = containerBlock(css, "(max-width: 64px)")

  test("the compact (<= 64px) tab layout exists", () => {
    expect(compact).toContain('[data-slot="tab-close"]')
  })

  test("a compact inactive tab has no close hit target, so a click selects it", () => {
    expect(compact).toMatch(
      /\[data-titlebar-tab\]:not\(\[data-active="true"\]\)\s+\[data-slot="tab-close"\]\s*\{[^}]*display:\s*none/,
    )
  })

  test("wide tabs keep the close button pinned to the 20px corner slot", () => {
    const base = css.slice(0, css.indexOf("}") + 1)
    expect(base).toContain('[data-titlebar-tab] [data-slot="tab-close"]')
    expect(base).toMatch(/width:\s*20px/)
    expect(base).toMatch(/height:\s*20px/)
  })

  test("middle-click still closes a session tab, with or without a close button", () => {
    expect(nav).toMatch(/onAuxClick=\{\(event\) => \{\s*if \(event\.button !== MIDDLE_MOUSE_BUTTON\) return\s*closeTab\(event\)/)
  })

  test("every tab close button is labeled for assistive tech", () => {
    const closeButtons = nav.split('<div data-slot="tab-close">').slice(1)
    expect(closeButtons.length).toBe(2)
    for (const button of closeButtons) expect(button.slice(0, button.indexOf("/>\n      </div>"))).toContain('aria-label="Close tab"')
  })
})
