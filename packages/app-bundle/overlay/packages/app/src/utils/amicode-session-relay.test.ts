import { describe, expect, test } from "bun:test"
import { assessedDiffInvalidation, sessionContextMessage } from "./amicode-session-relay"

describe("Amicode session relay", () => {
  test("publishes a live session and clears draft context", () => {
    expect(sessionContextMessage("ses_live")).toEqual({
      source: "amicode",
      kind: "session-context",
      sessionID: "ses_live",
    })
    expect(sessionContextMessage()).toEqual({
      source: "amicode",
      kind: "session-context",
      draft: true,
    })
  })

  test("accepts only opaque assessed-diff invalidations", () => {
    expect(
      assessedDiffInvalidation({
        source: "amicode",
        kind: "assessed-diff-invalidate",
        reference: "external_opaque",
        revision: 7,
        file: "/canonical/path",
        patch: "secret patch",
        expectedDigest: "secret digest",
      }),
    ).toEqual({ reference: "external_opaque", revision: 7 })
    expect(
      assessedDiffInvalidation({ source: "amicode", kind: "assessed-diff-invalidate", reference: "external_opaque" }),
    ).toBeUndefined()
  })
})
