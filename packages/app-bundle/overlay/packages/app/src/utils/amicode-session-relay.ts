export type SessionContextMessage =
  | { source: "amicode"; kind: "session-context"; sessionID: string }
  | { source: "amicode"; kind: "session-context"; draft: true }

export type AssessedDiffInvalidation = {
  reference: string
  revision: number
}

export function sessionContextMessage(sessionID?: string): SessionContextMessage {
  if (sessionID) return { source: "amicode", kind: "session-context", sessionID }
  return { source: "amicode", kind: "session-context", draft: true }
}

export function assessedDiffInvalidation(message: unknown): AssessedDiffInvalidation | undefined {
  if (!message || typeof message !== "object") return
  const data = message as { source?: unknown; kind?: unknown; reference?: unknown; revision?: unknown }
  if (data.source !== "amicode" || data.kind !== "assessed-diff-invalidate") return
  if (
    typeof data.reference !== "string" ||
    data.reference === "" ||
    typeof data.revision !== "number" ||
    !Number.isInteger(data.revision)
  )
    return
  return { reference: data.reference, revision: data.revision }
}
