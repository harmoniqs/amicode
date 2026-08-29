// amicode developer-mode boot flag: the extension passes
// `amicode_developer=1` in the iframe URL when `devAssetRoot` is configured
// (i.e. the user ran "Rebuild from Latest"). The app reads it once at boot
// (same convention as amicode-bug-report / amicode-hide-project) and uses it
// to auto-enable settings.developer.enabled — without this, ephemeral ports
// rotate the localStorage origin on every reload and the developer toggle
// is lost.
let enabled = false

/** Adopt the boot flag from a URL search string. Called once from entry.tsx. */
export function adoptDeveloperFlag(search: string): void {
  enabled = new URLSearchParams(search).get("amicode_developer") === "1"
}

/** Whether the extension signalled developer mode at boot. */
export function developerBootFlag(): boolean {
  return enabled
}
