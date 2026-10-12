// amicode: the app↔extension postMessage bridge. chat_panel.ts relays the
// envelope to an ALLOWLISTED vscode command, so the exact envelope shape and
// command strings are a contract. Extracted from use-amicode-commands.tsx so
// non-palette surfaces (the report-a-bug button, the entity rail's pulse
// chip) can post without dragging the command-registry module in.

// Gates every bridge surface out of the public web/share build, where there
// is no extension host to relay to (unframed: self === top).
export const inAmicode = () => typeof window !== "undefined" && window.self !== window.top

export const postAmicode = (command: string) => {
  try {
    window.parent?.postMessage({ source: "amicode", kind: "command", command }, "*")
  } catch {}
}

// #1551: the self-owned enable-control act. A PAYLOAD envelope (not the bare
// command lane, which cannot carry a target): the extension host shows the ADR
// 0034 D4 native modal and, on confirm, mints the self-owned control grant for
// the target peer. On success the next fleet-projection poll flips the session's
// projected control state to `interactive` and the driving banner lights — the
// app never self-declares interactive (the SoT projection is the source).
export const postAmicodeFleetEnableControl = (req: { ownerMachineId: string; sessionID: string }) => {
  try {
    window.parent?.postMessage(
      { source: "amicode", kind: "fleet-enable-control", ownerMachineId: req.ownerMachineId, sessionID: req.sessionID },
      "*",
    )
  } catch {}
}
