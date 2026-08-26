import { beforeEach, describe, expect, test } from "bun:test"

const src = await Bun.file(new URL("../public/oc-theme-preload.js", import.meta.url)).text()

const run = () => Function(src)()

// Must match PINNED_THEME_ID in public/oc-theme-preload.js and lockThemeId in app.tsx.
const PINNED = "harmoniqs"

beforeEach(() => {
  document.head.innerHTML = ""
  document.documentElement.removeAttribute("data-theme")
  document.documentElement.removeAttribute("data-color-scheme")
  localStorage.clear()
  Object.defineProperty(window, "matchMedia", {
    value: () =>
      ({
        matches: false,
      }) as MediaQueryList,
    configurable: true,
  })
})

describe("theme preload", () => {
  test("pins the brand theme over a legacy id, and drops its cached css", () => {
    localStorage.setItem("opencode-theme-id", "oc-1")
    localStorage.setItem("opencode-theme-css-light", "--background-base:#fff;")
    localStorage.setItem("opencode-theme-css-dark", "--background-base:#000;")

    run()

    expect(document.documentElement.dataset.theme).toBe(PINNED)
    expect(document.documentElement.dataset.colorScheme).toBe("light")
    expect(localStorage.getItem("opencode-theme-id")).toBe(PINNED)
    expect(localStorage.getItem("opencode-theme-css-light")).toBeNull()
    expect(localStorage.getItem("opencode-theme-css-dark")).toBeNull()
    expect(document.getElementById("oc-theme-preload")).toBeNull()
  })

  // Regression: a stale id left by an earlier build used to stamp the pre-paint
  // frame with the old theme, which stayed visible until hydration corrected it.
  test("corrects a stale stored id instead of honouring it", () => {
    localStorage.setItem("opencode-theme-id", "oc-2")
    localStorage.setItem("opencode-theme-css-light", "--background-base:#fafafa;")

    run()

    expect(document.documentElement.dataset.theme).toBe(PINNED)
    expect(localStorage.getItem("opencode-theme-id")).toBe(PINNED)
    expect(localStorage.getItem("opencode-theme-css-light")).toBeNull()
  })

  test("applies cached css when the stored id already matches the pin", () => {
    localStorage.setItem("opencode-theme-id", PINNED)
    localStorage.setItem("opencode-theme-css-light", "--background-base:#fff;")

    run()

    expect(document.documentElement.dataset.theme).toBe(PINNED)
    expect(document.getElementById("oc-theme-preload")?.textContent).toContain("--background-base:#fff;")
  })

  test("paints the brand ground before any stylesheet lands", () => {
    run()

    // light scheme (matchMedia stubbed to no-match) — brand ground, not the stock #fafafa
    expect(document.documentElement.style.backgroundColor.toLowerCase()).toBe("#ffffff")
  })
})
