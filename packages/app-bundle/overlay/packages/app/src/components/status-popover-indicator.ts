import type { LspStatus } from "@opencode-ai/sdk/v2/client"
import type { McpServer } from "@opencode-ai/client/promise"

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

export function serverStatusDotClass(input: {
  ready: boolean
  serverHealth: boolean | undefined
  attention?: boolean
  issue: boolean
}) {
  if (input.serverHealth === false) return "bg-icon-critical-base"
  if (!input.ready || input.serverHealth === undefined) return "bg-border-weak-base"
  // A bare yellow fill is 1.07:1 on the light ground, so the most urgent state
  // was the only invisible one. The ink ring is what makes it readable.
  if (input.attention) return "bg-v2-background-bg-accent ring-1 ring-[var(--accent-edge-ink)]"
  if (input.issue) return "bg-icon-warning-base"
  if (input.serverHealth === true) return "bg-icon-success-base"
  return "bg-border-weak-base"
}
