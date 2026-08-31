// sidebar_bridge.ts — Typed message protocol for the sidebar webview.
// Separate from chat_bridge.ts and inspector_bridge.ts — the sidebar has its
// own vocabulary. Messages flow in both directions:
//   host → webview: SidebarDownMessage (state pushes)
//   webview → host: SidebarUpMessage (user actions)

// ── Host → Webview (down) ────────────────────────────────────────────────────

export type ChatActiveMessage = { kind: "chat-active"; active: boolean };

export type SidebarDownMessage = ChatActiveMessage;

// ── Webview → Host (up) ──────────────────────────────────────────────────────

export type OpenChatMessage = { kind: "open-chat" };
export type NewProjectMessage = { kind: "new-project" };

export type SidebarUpMessage = OpenChatMessage | NewProjectMessage;

// ── Combined union (for the bridge type) ─────────────────────────────────────

export type SidebarMessage = SidebarUpMessage | SidebarDownMessage;

// ── Handler ──────────────────────────────────────────────────────────────────

export interface SidebarMessageHandlers {
  openChat: () => void;
  newProject: () => void;
}

/**
 * Handle a message received from the sidebar webview.
 * Dispatches to the appropriate handler based on message kind.
 * Unknown kinds are silently ignored (forward-compatible).
 */
export function handleSidebarMessage(
  msg: SidebarMessage,
  handlers: SidebarMessageHandlers,
): void {
  switch (msg.kind) {
    case "open-chat":
      handlers.openChat();
      break;
    case "new-project":
      handlers.newProject();
      break;
    case "chat-active":
      // Down-direction message — no host-side handler needed (the webview
      // consumes it). If received on the host side, ignore.
      break;
  }
}
