import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const sessionSource = readFileSync(join(import.meta.dir, "..", "session.tsx"), "utf8")
const draftSource = readFileSync(join(import.meta.dir, "..", "new-session.tsx"), "utf8")

describe("Amicode session relay routes", () => {
  test("publishes current session context and clears it for draft and unmount", () => {
    expect(sessionSource).toContain('window.parent.postMessage(sessionContextMessage(params.id), "*")')
    expect(sessionSource).toContain('window.parent.postMessage(sessionContextMessage(), "*")')
    expect(draftSource).toContain('window.parent.postMessage(sessionContextMessage(), "*")')
  })

  test("refetches opaque assessed detail without sending external paths to browser watching", () => {
    const assessedHandler = sessionSource.slice(
      sessionSource.indexOf("const onAssessedDiffInvalidate"),
      sessionSource.indexOf('window.addEventListener("message", onAssessedDiffInvalidate)'),
    )
    const legacyWatch = sessionSource.slice(
      sessionSource.indexOf("// #844: Preserve raw watch-files"),
      sessionSource.indexOf('window.parent.postMessage({ source: "amicode", kind: "watch-files", files }, "*")'),
    )

    expect(assessedHandler).toContain("if (!assessedDiffInvalidation(e.data)) return")
    expect(assessedHandler).toContain('sync().set("diff_version", sessionID')
    expect(assessedHandler).not.toContain("externalFileStatus")
    expect(legacyWatch).toContain("const files = (sessionDiffQuery.data ?? [])")
    expect(legacyWatch).not.toContain("reviewDiffs()")
  })
})
