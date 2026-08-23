;(function () {
  var key = "opencode-theme-id"
  // amicode: the app HARD-PINS the brand theme (lockThemeId in app.tsx), so the
  // pin is authoritative here too. Reading localStorage instead would let a
  // stale id from a previous build stamp the pre-paint frame with the old
  // theme, which then persists visibly until hydration corrects it.
  // MUST match lockThemeId in packages/app/src/app.tsx.
  var PINNED_THEME_ID = "harmoniqs"
  var themeId = PINNED_THEME_ID
  if (localStorage.getItem(key) !== themeId) {
    localStorage.setItem(key, themeId)
    localStorage.removeItem("opencode-theme-css-light")
    localStorage.removeItem("opencode-theme-css-dark")
  }

  if (themeId === "oc-1") {
    themeId = "oc-2"
    localStorage.setItem(key, themeId)
    localStorage.removeItem("opencode-theme-css-light")
    localStorage.removeItem("opencode-theme-css-dark")
  }

  // amicode: VS Code webview bridge — the extension passes ?colorScheme=light|dark
  // (from vscode.window.activeColorTheme). Seed the storage key BEFORE the read
  // below so the app boots in the editor's theme (prefers-color-scheme inside a
  // webview iframe reports the OS, not VS Code).
  try {
    var q = new URLSearchParams(location.search).get("colorScheme")
    if (q === "light" || q === "dark") localStorage.setItem("opencode-color-scheme", q)
  } catch (e) {
    /* storage unavailable — keep defaults */
  }

  var scheme = localStorage.getItem("opencode-color-scheme") || "system"
  var isDark = scheme === "dark" || (scheme === "system" && matchMedia("(prefers-color-scheme: dark)").matches)
  var mode = isDark ? "dark" : "light"

  document.documentElement.dataset.theme = themeId
  document.documentElement.dataset.colorScheme = mode
  // Brand ground, tracking harmoniqs.json palette.neutral (dark #000, light #fff).
  // This paints before any stylesheet, so a stock literal here shows through as
  // the old brand for the first frame.
  document.documentElement.style.backgroundColor = isDark ? "#0F0F0D" : "#ffffff"

  // Update theme-color meta tag to match app color scheme
  var metas = document.querySelectorAll("meta[name='theme-color']")
  if (metas.length > 0) metas[0].setAttribute("content", isDark ? "#0F0F0D" : "#ffffff")

  if (themeId === "oc-2") return // stock theme needs no cached CSS

  var css = localStorage.getItem("opencode-theme-css-" + mode)
  if (css) {
    var style = document.createElement("style")
    style.id = "oc-theme-preload"
    style.textContent =
      ":root{color-scheme:" +
      mode +
      ";--text-mix-blend-mode:" +
      (isDark ? "plus-lighter" : "multiply") +
      ";" +
      css +
      "}"
    document.head.appendChild(style)
  }
})()
