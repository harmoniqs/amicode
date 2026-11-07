import { describe, expect, test } from "bun:test"
import {
  hasNonBlockingServiceIssue,
  hasServiceNeedingAttention,
  serverStatusActivity,
  serverStatusLabel,
} from "./status-popover-indicator"

describe("serverStatusActivity", () => {
  test("success while the server and services are healthy", () => {
    expect(serverStatusActivity({ ready: true, serverHealth: true, issue: false })).toBe("success")
  })

  test("attention (amber, never yellow) when a service needs the user", () => {
    expect(serverStatusActivity({ ready: true, serverHealth: true, attention: true, issue: true })).toBe("attention")
  })

  test("attention for non-blocking service issues while the server is online", () => {
    expect(serverStatusActivity({ ready: true, serverHealth: true, issue: true })).toBe("attention")
  })

  test("error only after the server connection drops", () => {
    expect(serverStatusActivity({ ready: true, serverHealth: false, issue: false })).toBe("error")
    expect(serverStatusActivity({ ready: true, serverHealth: false, issue: true })).toBe("error")
  })

  test("running (pending) before status is ready", () => {
    expect(serverStatusActivity({ ready: false, serverHealth: true, issue: false })).toBe("running")
    expect(serverStatusActivity({ ready: false, serverHealth: undefined, issue: false })).toBe("running")
  })
})

describe("serverStatusLabel", () => {
  test("every activity carries a distinct accessible label", () => {
    const labels = (["idle", "running", "attention", "success", "error"] as const).map((activity) =>
      serverStatusLabel({ activity, attention: false }),
    )
    expect(new Set(labels).size).toBe(labels.length)
    expect(serverStatusLabel({ activity: "attention", attention: true })).not.toBe(
      serverStatusLabel({ activity: "attention", attention: false }),
    )
  })
})

describe("hasNonBlockingServiceIssue", () => {
  test("detects MCP failures that do not block chatting", () => {
    expect(hasNonBlockingServiceIssue({ mcp: ["failed"], lsp: [] })).toBe(true)
    expect(hasNonBlockingServiceIssue({ mcp: ["needs_auth"], lsp: [] })).toBe(true)
    expect(hasNonBlockingServiceIssue({ mcp: ["needs_client_registration"], lsp: [] })).toBe(true)
    expect(hasNonBlockingServiceIssue({ mcp: ["connected", "pending", "disabled"], lsp: [] })).toBe(false)
  })

  test("detects LSP failures that do not block chatting", () => {
    expect(hasNonBlockingServiceIssue({ mcp: [], lsp: ["error"] })).toBe(true)
    expect(hasNonBlockingServiceIssue({ mcp: [], lsp: ["connected"] })).toBe(false)
  })
})

describe("hasServiceNeedingAttention", () => {
  test("detects MCP states that need user attention", () => {
    expect(hasServiceNeedingAttention({ mcp: ["needs_auth"] })).toBe(true)
    expect(hasServiceNeedingAttention({ mcp: ["needs_client_registration"] })).toBe(true)
  })

  test("ignores states that do not need user attention", () => {
    expect(hasServiceNeedingAttention({ mcp: ["failed"] })).toBe(false)
    expect(hasServiceNeedingAttention({ mcp: ["connected", "pending", "disabled"] })).toBe(false)
  })
})
