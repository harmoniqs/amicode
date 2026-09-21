import type { ServerConnection } from "./server"
import type { Tab } from "./tabs"

export function migrateTabs(
  value: unknown,
  fallback: ServerConnection.Key,
  knownServers?: ReadonlySet<ServerConnection.Key>,
): Tab[] {
  if (!Array.isArray(value)) return []
  return value.flatMap<Tab>((tab) => {
    if (!tab || typeof tab !== "object") return []
    if ("server" in tab && typeof tab.server !== "string") return []
    let server = ("server" in tab ? tab.server : fallback) as ServerConnection.Key
    // #1295: a tab persisted with an OLD-ERA server key (pre-fleet origin,
    // a retired host, a tunnel port change) routes into a ghost server
    // context — the timeline gate held "not-loaded" forever and the strip
    // never rendered those tabs (the frozen-panel-on-switch symptom).
    // The session IDs are still valid on the current server: rebase when
    // the key is known-stale (registry says so and it isn't the fallback).
    if (knownServers && knownServers.size > 0 && server !== fallback && !knownServers.has(server)) {
      server = fallback
    }
    if (tab.type === "session" && typeof tab.sessionId === "string") {
      return [{ type: tab.type, server, sessionId: tab.sessionId }]
    }
    if (
      tab.type === "draft" &&
      typeof tab.draftID === "string" &&
      typeof tab.directory === "string" &&
      (tab.worktree === undefined || typeof tab.worktree === "string")
    ) {
      return [{ type: tab.type, server, draftID: tab.draftID, directory: tab.directory, worktree: tab.worktree }]
    }
    return []
  })
}
