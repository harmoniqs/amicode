import { describe, expect, test } from "bun:test"
import { settledToolStatus } from "./message-part-tool-status"

// harmoniqs/amicode#1427 — after Esc the subagent (task) card kept spinning:
// its tool part still read "running" although the assistant message that owns
// it had already been finalized by the cancel. A finished message cannot have a
// live tool call, so the spinner must resolve.
describe("settledToolStatus", () => {
  const done = { role: "assistant", time: { created: 1, completed: 2 } }
  const live = { role: "assistant", time: { created: 1 } }

  test("a running/pending tool under a completed assistant message is settled, not spinning", () => {
    expect(settledToolStatus("running", done)).not.toBe("running")
    expect(settledToolStatus("pending", done)).not.toBe("pending")
    expect(settledToolStatus("running", done)).toBe("error")
  })

  test("a running tool under a live assistant message keeps spinning", () => {
    expect(settledToolStatus("running", live)).toBe("running")
    expect(settledToolStatus("pending", live)).toBe("pending")
  })

  test("terminal statuses are never rewritten", () => {
    expect(settledToolStatus("completed", done)).toBe("completed")
    expect(settledToolStatus("error", done)).toBe("error")
    expect(settledToolStatus("completed", live)).toBe("completed")
  })

  test("a missing or non-assistant message leaves the status alone", () => {
    expect(settledToolStatus("running", undefined)).toBe("running")
    expect(settledToolStatus("running", { role: "user", time: { created: 1 } })).toBe("running")
  })
})
