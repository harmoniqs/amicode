import { describe, expect, test } from "bun:test"
import { ACTIVITY_COLOR, ACTIVITY_SOFT, connectionActivity, lspActivity, mcpActivity, runActivity } from "./activity"

describe("activity tokens", () => {
  test("every role resolves to its --activity-* token, never a hex", () => {
    expect(ACTIVITY_COLOR).toEqual({
      idle: "var(--activity-idle)",
      running: "var(--activity-running)",
      attention: "var(--activity-attention)",
      success: "var(--activity-success)",
      error: "var(--activity-error)",
    })
    expect(ACTIVITY_SOFT.running).toBe("var(--activity-running-soft)")
    expect(ACTIVITY_SOFT.attention).toBe("var(--activity-attention-soft)")
  })
})

describe("runActivity", () => {
  test("solving is running (blue)", () => expect(runActivity("solving")).toBe("running"))
  test("stalled is attention (amber)", () => expect(runActivity("stalled")).toBe("attention"))
  test("aborted is idle (grey) — a user-chosen stop", () => expect(runActivity("aborted")).toBe("idle"))
  test("stopped is idle", () => expect(runActivity("stopped")).toBe("idle"))
  test("finished is success", () => expect(runActivity("finished")).toBe("success"))
  test("failed is error", () => expect(runActivity("failed")).toBe("error"))
  test("recorded / unknown stays idle", () => {
    expect(runActivity("recorded")).toBe("idle")
    expect(runActivity("whatever")).toBe("idle")
  })
})

describe("connectionActivity", () => {
  test("pending → running", () => expect(connectionActivity({ tone: "pending", showDrift: false })).toBe("running"))
  test("expired / unreachable (warning) → attention", () =>
    expect(connectionActivity({ tone: "warning", showDrift: false })).toBe("attention"))
  test("connected → success", () => expect(connectionActivity({ tone: "success", showDrift: false })).toBe("success"))
  test("connected with submitter drift → attention", () =>
    expect(connectionActivity({ tone: "success", showDrift: true })).toBe("attention"))
  test("invalid / unentitled (critical) → error", () =>
    expect(connectionActivity({ tone: "critical", showDrift: false })).toBe("error"))
  test("needs-key (neutral) → idle", () =>
    expect(connectionActivity({ tone: "neutral", showDrift: false })).toBe("idle"))
})

describe("mcpActivity / lspActivity", () => {
  test("mcp states", () => {
    expect(mcpActivity("pending")).toBe("running")
    expect(mcpActivity("needs_auth")).toBe("attention")
    expect(mcpActivity("needs_client_registration")).toBe("attention")
    expect(mcpActivity("connected")).toBe("success")
    expect(mcpActivity("failed")).toBe("error")
    expect(mcpActivity("disabled")).toBe("idle")
  })
  test("lsp states", () => {
    expect(lspActivity("connected")).toBe("success")
    expect(lspActivity("error")).toBe("error")
  })
})
