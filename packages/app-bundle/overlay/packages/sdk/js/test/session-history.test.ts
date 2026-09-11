import { expect, test } from "bun:test"
import type { SessionAssessedDiffData, V2SessionHistoryData } from "../src/v2/gen/types.gen"

test("uses numeric Session history positions", () => {
  const input = {
    path: { sessionID: "ses_test" },
    query: { after: 1, limit: 50 },
    url: "/api/session/{sessionID}/history",
  } satisfies V2SessionHistoryData

  expect(input.query.after).toBe(1)
})

test("requests generated external patches only explicitly", () => {
  const input = {
    path: { sessionID: "ses_test" },
    query: { patch: "true" },
    url: "/session/{sessionID}/diff/assessed",
  } satisfies SessionAssessedDiffData

  expect(input.query.patch).toBe("true")
})
