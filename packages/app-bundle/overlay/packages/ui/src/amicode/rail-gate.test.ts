import { describe, expect, test } from "bun:test"
import { countAmicodeParts, sessionHasAmicodeParts } from "./rail-gate"

// Regression coverage for the missing entity chips.
//
// The gate used to be `part.tool.startsWith("amicode_")` alone, so a session that
// did its amicode work through the shell showed NO chips — observed 2026-07-29 on
// a session that created a problem workspace, wrote a solvespec, and drove a solve
// to iteration 29 with frames on disk, entirely via bash + amico-run.

const msgs = [{ id: "m1" }]
const parts =
  (...p: Array<Record<string, unknown>>) =>
  () =>
    p as never

const amicodeTool = (status = "completed") => ({ type: "tool", tool: "amicode_record_system", state: { status } })
const bash = (command: string) => ({ type: "tool", tool: "bash", state: { status: "running", input: { command } } })

describe("rail gate", () => {
  test("an amicode_* tool part opens the gate (unchanged behaviour)", () => {
    expect(sessionHasAmicodeParts(msgs, parts(amicodeTool()))).toBe(true)
  })

  test("a shell part that launches amico-run opens the gate", () => {
    expect(sessionHasAmicodeParts(msgs, parts(bash("nohup amico-run --spec s.json solve.jl &")))).toBe(true)
  })

  test("a shell part that only touches the problems dir opens the gate", () => {
    // the workspace gets created before any run exists
    expect(sessionHasAmicodeParts(msgs, parts(bash("mkdir -p ~/.amico/problems/x-gate-1")))).toBe(true)
  })

  test("an unrelated session still shows nothing — the gate's whole purpose", () => {
    expect(sessionHasAmicodeParts(msgs, parts(bash("git status"), bash("npm test")))).toBe(false)
    expect(sessionHasAmicodeParts(msgs, parts({ type: "text", text: "hello" }))).toBe(false)
    expect(sessionHasAmicodeParts([], () => undefined)).toBe(false)
  })

  test("a part whose input has not arrived yet does not match, and does not throw", () => {
    expect(sessionHasAmicodeParts(msgs, parts({ type: "tool", tool: "bash", state: { status: "pending" } }))).toBe(
      false,
    )
    expect(sessionHasAmicodeParts(msgs, parts({ type: "tool", tool: "bash" }))).toBe(false)
  })

  // The refetch key must NOT be broadened: shell parts don't mutate the problem
  // view through the tool seam, so counting them would refetch the problem on
  // unrelated shell activity.
  test("completed counts only amicode_* tools, never shell", () => {
    const c = countAmicodeParts(msgs, parts(amicodeTool("completed"), bash("amico-run solve.jl")))
    expect(c.any).toBe(2)
    expect(c.completed).toBe(1)
  })

  test("a non-completed amicode tool counts for the gate but not the refetch key", () => {
    const c = countAmicodeParts(msgs, parts(amicodeTool("running")))
    expect(c.any).toBe(1)
    expect(c.completed).toBe(0)
  })
})
