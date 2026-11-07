import type { LspStatus } from "@opencode-ai/sdk/v2/client"
import type { McpServer } from "@opencode-ai/client/promise"
import type { Activity } from "@opencode-ai/ui/amicode-activity"

export function hasServiceNeedingAttention(input: { mcp: Array<McpServer["status"]["status"]> }) {
  return input.mcp.some((status) => status === "needs_auth" || status === "needs_client_registration")
}

export function hasNonBlockingServiceIssue(input: {
  mcp: Array<McpServer["status"]["status"]>
  lsp: Array<LspStatus["status"]>
}) {
  return (
    input.mcp.some((status) => status !== "connected" && status !== "pending" && status !== "disabled") ||
    input.lsp.some((status) => status === "error")
  )
}

export function serverStatusActivity(input: {
  ready: boolean
  serverHealth: boolean | undefined
  attention?: boolean
  issue: boolean
}): Activity {
  if (input.serverHealth === false) return "error"
  // still checking — the pending state of the health probe
  if (!input.ready || input.serverHealth === undefined) return "running"
  // waiting on the user (sign-in) or a non-blocking service issue: amber.
  // Yellow never encodes a state.
  if (input.attention || input.issue) return "attention"
  return "success"
}

const SERVER_STATUS_LABEL: Record<Activity, string> = {
  idle: "Server status unknown",
  running: "Checking server status",
  attention: "A service has an issue",
  success: "Server and services healthy",
  error: "Server unreachable",
}

export function serverStatusLabel(input: { activity: Activity; attention?: boolean }) {
  if (input.activity === "attention" && input.attention) return "A service needs you to sign in"
  return SERVER_STATUS_LABEL[input.activity]
}
