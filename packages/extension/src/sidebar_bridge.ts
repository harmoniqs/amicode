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
  gitStatus?: "modified" | "added" | "deleted" | "untracked" | "ignored" | "conflict";
}

// ── File operation types ─────────────────────────────────────────────────────

export interface FileOpRequest {
  op: "rename" | "delete" | "new-file" | "new-folder" | "copy-path" | "copy-relative-path" | "reveal-in-os" | "open-in-terminal" | "open-to-side" | "remove-from-workspace" | "new-session" | "move";
  path: string;
  newName?: string;
  name?: string;
  targetDir?: string;
}

export interface FileOpResult {
  ok: boolean;
  message?: string;
}

// ── Host → Webview (down) ────────────────────────────────────────────────────

export type ChatActiveMessage = { kind: "chat-active"; active: boolean };
export type RootsMessage = { kind: "roots"; roots: TreeRoot[] };
export type ChildrenMessage = { kind: "children"; path: string; entries: TreeEntry[] };
export type FsChangedMessage = { kind: "fs-changed"; folder: string };
export type FileOpErrorMessage = { kind: "file-op-error"; op: string; path: string; message: string };
export type ActiveProjectMessage = { kind: "active-project"; path: string | null };

export type SidebarDownMessage =
  | ChatActiveMessage
  | RootsMessage
  | ChildrenMessage
  | FsChangedMessage
  | FileOpErrorMessage
  | ActiveProjectMessage;

// ── Webview → Host (up) ──────────────────────────────────────────────────────

export type OpenChatMessage = { kind: "open-chat" };
export type NewProjectMessage = { kind: "new-project" };
export type AddExistingMessage = { kind: "add-existing" };
export type GetRootsMessage = { kind: "get-roots" };
export type GetChildrenMessage = { kind: "get-children"; path: string };
export type OpenFileMessage = { kind: "open-file"; path: string };
export type FileOpMessage = { kind: "file-op" } & FileOpRequest;

export type SidebarUpMessage =
  | OpenChatMessage
  | NewProjectMessage
  | AddExistingMessage
  | GetRootsMessage
  | GetChildrenMessage
  | OpenFileMessage
  | FileOpMessage;

// ── Combined union (for the bridge type) ─────────────────────────────────────

export type SidebarMessage = SidebarUpMessage | SidebarDownMessage;

// ── Handler ──────────────────────────────────────────────────────────────────

export interface SidebarMessageHandlers {
  openChat: () => void;
  newProject: () => void;
  addExisting: () => void;
  getRoots: () => TreeRoot[];
  getChildren: (path: string) => Promise<TreeEntry[]>;
  openFile: (path: string) => void;
  fileOp: (req: FileOpRequest) => Promise<FileOpResult>;
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
    case "add-existing":
      handlers.addExisting();
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
    case "file-op": {
      const { kind: _k, ...req } = msg;
      return handlers.fileOp(req as FileOpRequest).then((result) => {
        if (!result.ok) {
          handlers.postMessage({
            kind: "file-op-error",
            op: req.op,
            path: req.path,
            message: result.message ?? "Operation failed",
          });
        }
      });
    }
    case "chat-active":
    case "roots":
    case "children":
    case "fs-changed":
    case "file-op-error":
    case "active-project":
      // Down-direction messages — no host-side handler needed.
      break;
  }
}
