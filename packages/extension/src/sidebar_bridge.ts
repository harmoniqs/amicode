// sidebar_bridge.ts — Typed message protocol for the sidebar webview.
// Separate from chat_bridge.ts and inspector_bridge.ts — the sidebar has its
// own vocabulary. Messages flow in both directions:
//   host → webview: SidebarDownMessage (state pushes)
//   webview → host: SidebarUpMessage (user actions)

// ── Data types ───────────────────────────────────────────────────────────────

export interface TreeRoot {
  path: string;
  name: string;
  projectType: "research" | "dev";
  metadata?: { phase?: string; lastActive?: string };
}

export interface TreeEntry {
  name: string;
  type: "file" | "directory";
  path: string;
}

// ── Host → Webview (down) ────────────────────────────────────────────────────

export type ChatActiveMessage = { kind: "chat-active"; active: boolean };
export type RootsMessage = { kind: "roots"; roots: TreeRoot[] };
export type ChildrenMessage = { kind: "children"; path: string; entries: TreeEntry[] };
export type FsChangedMessage = { kind: "fs-changed"; folder: string };

export type SidebarDownMessage =
  | ChatActiveMessage
  | RootsMessage
  | ChildrenMessage
  | FsChangedMessage;

// ── Webview → Host (up) ──────────────────────────────────────────────────────

export type OpenChatMessage = { kind: "open-chat" };
export type NewProjectMessage = { kind: "new-project" };
export type GetRootsMessage = { kind: "get-roots" };
export type GetChildrenMessage = { kind: "get-children"; path: string };
export type OpenFileMessage = { kind: "open-file"; path: string };

export type SidebarUpMessage =
  | OpenChatMessage
  | NewProjectMessage
  | GetRootsMessage
  | GetChildrenMessage
  | OpenFileMessage;

// ── Combined union (for the bridge type) ─────────────────────────────────────

export type SidebarMessage = SidebarUpMessage | SidebarDownMessage;

// ── Handler ──────────────────────────────────────────────────────────────────

export interface SidebarMessageHandlers {
  openChat: () => void;
  newProject: () => void;
  getRoots: () => TreeRoot[];
  getChildren: (path: string) => Promise<TreeEntry[]>;
  openFile: (path: string) => void;
  postMessage: (msg: SidebarDownMessage) => void;
}

/**
 * Handle a message received from the sidebar webview.
 * Dispatches to the appropriate handler based on message kind.
 * Unknown kinds are silently ignored (forward-compatible).
 */
export function handleSidebarMessage(
  msg: SidebarMessage,
  handlers: SidebarMessageHandlers,
): void | Promise<void> {
  switch (msg.kind) {
    case "open-chat":
      handlers.openChat();
      break;
    case "new-project":
      handlers.newProject();
      break;
    case "get-roots": {
      const roots = handlers.getRoots();
      handlers.postMessage({ kind: "roots", roots });
      break;
    }
    case "get-children":
      return handlers.getChildren(msg.path).then((entries) => {
        handlers.postMessage({ kind: "children", path: msg.path, entries });
      });
    case "open-file":
      handlers.openFile(msg.path);
      break;
    case "chat-active":
    case "roots":
    case "children":
    case "fs-changed":
      // Down-direction messages — no host-side handler needed (the webview
      // consumes them). If received on the host side, ignore.
      break;
  }
}
