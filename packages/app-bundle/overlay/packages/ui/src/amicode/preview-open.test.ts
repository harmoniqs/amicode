import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parsePreviewSentinel, previewOpenMessage, shouldAutoOpen } from "./preview-open"

// The LAST line exactly as packages/extension/opencode-plugin/preview_open.ts writes it.
const LINE = 'AMICODE_PREVIEW {"path":"/Users/j/.amico/dashboards/s/index.html","name":"index.html","bytes":21996}'
const OUTPUT = `Sent index.html to the user's Preview (side panel): it opens there now.\n${LINE}`

describe("parsePreviewSentinel", () => {
  test("parses the LAST line when it is a sentinel", () => {
    expect(parsePreviewSentinel(OUTPUT)).toEqual({
      path: "/Users/j/.amico/dashboards/s/index.html",
      name: "index.html",
      bytes: 21996,
    })
  })
  test("trailing whitespace is fine; a missing name falls back to the basename", () => {
    expect(parsePreviewSentinel(`x\nAMICODE_PREVIEW {"path":"/a/b/plot.png"}\n\n`)).toEqual({
      path: "/a/b/plot.png",
      name: "plot.png",
      bytes: undefined,
    })
  })
  test("refusals, non-strings, non-last sentinels, relative paths, bad JSON → undefined", () => {
    expect(parsePreviewSentinel(undefined)).toBeUndefined()
    expect(parsePreviewSentinel("Not opened: /x does not exist on this machine.")).toBeUndefined()
    expect(parsePreviewSentinel(`${LINE}\ntrailing prose`)).toBeUndefined()
    expect(parsePreviewSentinel('AMICODE_PREVIEW {"path":"rel/x.html"}')).toBeUndefined()
    expect(parsePreviewSentinel("AMICODE_PREVIEW {nope")).toBeUndefined()
    expect(parsePreviewSentinel('AMICODE_PREVIEW "/a.html"')).toBeUndefined()
  })
})

describe("previewOpenMessage", () => {
  test("is the session-targeted preview-file open, with refresh", () => {
    expect(previewOpenMessage("/a.html", "ses_1")).toEqual({
      source: "amicode",
      kind: "preview-file",
      path: "/a.html",
      refresh: true,
      sessionID: "ses_1",
    })
  })
  test("omits sessionID when the card has none (legacy broadcast)", () => {
    expect("sessionID" in previewOpenMessage("/a.html", undefined)).toBe(false)
  })
})

describe("shouldAutoOpen", () => {
  test("opens on a live completion, once", () => {
    expect(shouldAutoOpen({ sawLive: true, current: "completed", alreadyOpened: false })).toBe(true)
    expect(shouldAutoOpen({ sawLive: true, current: "completed", alreadyOpened: true })).toBe(false)
  })
  test("a replayed (already-completed) part never opens", () => {
    expect(shouldAutoOpen({ sawLive: false, current: "completed", alreadyOpened: false })).toBe(false)
  })
  test("errors and in-flight states never open", () => {
    for (const current of ["error", "running", "pending", undefined])
      expect(shouldAutoOpen({ sawLive: true, current, alreadyOpened: false })).toBe(false)
  })
})

// Wiring pins (JSX cannot render under bun here): the auto-open watcher lives in
// AmicodeToolCard (mounted from the pending render, so it sees the live
// transition) and goes through the pure gate above, at most once per part.
const card = readFileSync(join(import.meta.dir, "card.tsx"), "utf8")

describe("AmicodeToolCard wiring for amicode_open_preview", () => {
  test("the watcher latches on pending/running and opens through shouldAutoOpen, once", () => {
    expect(card).toContain('if (current === "pending" || current === "running") {')
    expect(card).toContain("shouldAutoOpen({ sawLive, current, alreadyOpened: autoOpenedPreviews.has(key) })")
    expect(card).toContain("autoOpenedPreviews.add(key)")
    expect(card).toContain("openInPreview(request.path, props.sessionID)")
  })
  test("a completed call renders the re-open chip", () => {
    expect(card).toMatch(/<Match when=\{previewRequest\(\)\}>\s*\{\(request\) => <PreviewOpenCard/)
  })
})
