// AMICODE: the activity vocabulary — one semantic role per state, shared by
// every status surface (run status, connection / MCP / LSP / server / vault
// health dots). Colours live in the app's design-polish.css as `--activity-*`
// (aliasing the theme's v2 state tokens); this module only names the role.
//
//   running   = blue   in progress (solving, pending, validating)
//   attention = amber  waiting on you (needs auth, expired, drift, stalled)
//   success   = green  done / healthy
//   error     = red    failed
//   idle      = grey   idle, aborted, stopped, disabled
//
// Yellow never encodes a state — it is brand and selection only.

export type Activity = "idle" | "running" | "attention" | "success" | "error"

export const ACTIVITY_COLOR: Record<Activity, string> = {
  idle: "var(--activity-idle)",
  running: "var(--activity-running)",
  attention: "var(--activity-attention)",
  success: "var(--activity-success)",
  error: "var(--activity-error)",
}

export const ACTIVITY_SOFT: Record<Activity, string> = {
  idle: "var(--activity-idle-soft)",
  running: "var(--activity-running-soft)",
  attention: "var(--activity-attention-soft)",
  success: "var(--activity-success-soft)",
  error: "var(--activity-error-soft)",
}

const RUN_ACTIVITY: Record<string, Activity> = {
  solving: "running",
  // wedged (OOM?) — must not read as live
  stalled: "attention",
  // a user-chosen stop: calm, not alarming, not live
  aborted: "idle",
  stopped: "idle",
  finished: "success",
  failed: "error",
}

export function runActivity(status: string): Activity {
  return RUN_ACTIVITY[status] ?? "idle"
}

const CONNECTION_ACTIVITY: Record<"success" | "critical" | "warning" | "pending" | "neutral", Activity> = {
  pending: "running",
  warning: "attention",
  success: "success",
  critical: "error",
  neutral: "idle",
}

export function connectionActivity(model: {
  tone: "success" | "critical" | "warning" | "pending" | "neutral"
  showDrift: boolean
}): Activity {
  // connected, but the submitter identity drifted — the user must look
  if (model.showDrift) return "attention"
  return CONNECTION_ACTIVITY[model.tone]
}

export function mcpActivity(status: string): Activity {
  if (status === "pending") return "running"
  if (status === "needs_auth" || status === "needs_client_registration") return "attention"
  if (status === "connected") return "success"
  if (status === "failed") return "error"
  return "idle"
}

export function lspActivity(status: string): Activity {
  if (status === "connected") return "success"
  if (status === "error") return "error"
  return "idle"
}
