import { describe, expect, test, beforeEach } from "bun:test"
import {
  getActiveShikiTheme,
  getActiveThemeObject,
  handleSyntaxThemeMessage,
  onThemeChange,
  resetToFallback,
} from "./shiki-theme-state"

describe("shiki-theme-state", () => {
  beforeEach(() => {
    resetToFallback()
  })

  test("defaults to OpenCode fallback theme", () => {
    expect(getActiveShikiTheme()).toBe("OpenCode")
    expect(getActiveThemeObject()).toBeNull()
  })

  test("accepts a Shiki built-in name string", () => {
    handleSyntaxThemeMessage("dark-plus")
    expect(getActiveShikiTheme()).toBe("dark-plus")
    expect(getActiveThemeObject()).toBeNull()
  })

  test("accepts a full TextMate theme object", () => {
    const themeObj = {
      name: "My Theme",
      tokenColors: [{ scope: "comment", settings: { foreground: "#888" } }],
    }
    handleSyntaxThemeMessage(themeObj)
    expect(getActiveShikiTheme()).toBe("vscode-active")
    expect(getActiveThemeObject()).toBe(themeObj)
  })

  test("notifies listeners on theme change", () => {
    const received: string[] = []
    const unsub = onThemeChange((name) => received.push(name))

    handleSyntaxThemeMessage("dracula")
    handleSyntaxThemeMessage("nord")
    unsub()
    handleSyntaxThemeMessage("monokai") // should not be received

    expect(received).toEqual(["dracula", "nord"])
  })

  test("resetToFallback restores OpenCode", () => {
    handleSyntaxThemeMessage("dark-plus")
    expect(getActiveShikiTheme()).toBe("dark-plus")

    resetToFallback()
    expect(getActiveShikiTheme()).toBe("OpenCode")
    expect(getActiveThemeObject()).toBeNull()
  })

  test("ignores invalid theme values", () => {
    handleSyntaxThemeMessage("dark-plus")
    handleSyntaxThemeMessage(null as any)
    expect(getActiveShikiTheme()).toBe("dark-plus") // unchanged

    handleSyntaxThemeMessage(undefined as any)
    expect(getActiveShikiTheme()).toBe("dark-plus") // unchanged
  })
})
