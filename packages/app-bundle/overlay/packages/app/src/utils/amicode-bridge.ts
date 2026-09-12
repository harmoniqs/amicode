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
