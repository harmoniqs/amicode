import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// harmoniqs/amicode#261 — paste inserted the same text twice in the webview.
//
// Two mod+V handlers used to be live inside the framed app:
//   1. utils/global-clipboard.ts — window-level, CAPTURE phase.
//   2. The composer's own keydown handler (v1 handleKeyDown / v2 onKeyDown),
//      which preventDefault'd but never stopPropagation'd, so BOTH bridge-
//      inserted the same text. An opt-out marker (data-amc-clipboard="self")
//      on the composer editors was tried, but the amicode fork hard-locks the
//      v2 layout and the marker contract proved too fragile to maintain across
//      the two composers.
//
// The current design removes the composers' keydown interception entirely:
// the window-level fallback is the SOLE ⌘V path in the webview (single
// insert), and the native paste event path (composer onPaste → handlePaste)
// remains for chords the fallback doesn't own (⌘⇧V). Image/screenshot paste
// over ⌘V is knowingly sacrificed — the fallback reads text only.
//
// This is a SOURCE assertion rather than a rendered-DOM one because the app has
// no component-render harness (no @solidjs/testing-library) — the same reason
// global-clipboard.test.ts exercises the fallback against a synthetic element
// it builds itself, which is exactly the gap that let #261 ship. Replace this
// with a render assertion the day a harness lands.
const source = readFileSync(join(import.meta.dir, "prompt-input.tsx"), "utf8")
const v2Interaction = readFileSync(
  join(import.meta.dir, "../../../session-ui/src/v2/components/prompt-input/interaction.ts"),
  "utf8",
)
const v2Attachments = readFileSync(
  join(import.meta.dir, "../../../session-ui/src/v2/components/prompt-input/attachments.ts"),
  "utf8",
)
const v2Editor = readFileSync(
  join(import.meta.dir, "../../../session-ui/src/v2/components/prompt-input/index.tsx"),
  "utf8",
)
const globalClipboard = readFileSync(join(import.meta.dir, "../utils/global-clipboard.ts"), "utf8")

describe("single ⌘V path in the webview (amicode#261)", () => {
  test("the v1 composer no longer intercepts ⌘V at keydown", () => {
    expect(source).not.toContain("inAmicode")
    expect(source).not.toContain('event.key.toLowerCase() === "v"')
  })

  test("the v2 composer no longer intercepts ⌘V at keydown", () => {
    expect(v2Interaction).not.toContain('event.key.toLowerCase() === "v"')
    expect(v2Interaction).not.toContain("handleFramedPaste")
    expect(v2Attachments).not.toContain("handleFramedPaste")
  })

  test("neither composer editor carries the opt-out marker", () => {
    // The marker contract is gone: the fallback owns ⌘V everywhere. A marker
    // here would silently re-orphan the composer (nothing would paste on ⌘V).
    expect(source).not.toContain('data-amc-clipboard="self"')
    expect(v2Editor).not.toContain('data-amc-clipboard="self"')
  })

  test("the window-level fallback still owns the ⌘V branch for editables", () => {
    expect(globalClipboard).toContain('key !== "v"')
    expect(globalClipboard).toContain("installGlobalClipboardFallback")
    expect(globalClipboard).toContain("readClipboardViaBridge")
  })

  test("the composers still wire the native paste path with bridge fallbacks", () => {
    // ⌘⇧V (and any non-prevented paste event) flows: onPaste → handlePaste,
    // which falls back to the host-clipboard bridges when the event carries
    // nothing readable.
    expect(source).toContain("onPaste={handlePaste}")
    expect(v2Interaction).toContain("handlePaste")
    expect(source).toContain("readClipboardViaBridge")
  })
})
