import * as vscode from "vscode";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

// ============================================================================
// The amicode iframe⇄extension command bridge, shared by ChatPanel (one
// iframe) and DeckPanel (N panes). The framed app renders LLM output, so the
// handler is paranoid by construction: strict command allowlist, https-only
// externals, visibility-gated clipboard reads, bounded payloads. Panes tag
// their messages with an opaque `tab` id; replies ECHO it so the shell can
// route the answer back to the asking pane. Single-iframe panels leave `tab`
// undefined and their relay simply forwards to the one iframe.
// ============================================================================

// Commands the in-app palette (opencode "Amico" command group) may trigger via
// the iframe→parent→extension postMessage bridge. STRICT allowlist: the framed
// app renders LLM output, so we never executeCommand anything outside this set.
export const BRIDGE_ALLOWED_COMMANDS: ReadonlySet<string> = new Set([
  "amicode.restartServer",
  "amicode.distillNow",
  "amicode.stopRun",
  "amicode.savePulse",
  "amicode.openRunDir",
  "amicode.openInspector",
  // ⌘⇧P inside the chat iframe lands in the APP's palette, not VS Code's —
  // the fork forwards it here so the editor's Command Palette (where every
  // Amicode: command lives) opens as users expect.
  "workbench.action.showCommands",
]);

/** Side channels the handler needs from its host panel. */
export interface BridgeIo {
  /** Clipboard reads only answer while the user can see the chat. */
  visible(): boolean;
  /** Replies (clipboard text) go back to the host webview; `tab` echoes along. */
  postToWebview(msg: unknown): void;
}

const isAmicode = (msg: unknown): msg is { source: "amicode"; kind: string; tab?: string } =>
  !!msg && typeof msg === "object" && (msg as { source?: unknown }).source === "amicode";

/** Handle one envelope from a framed app. Returns true when the message was
 *  consumed (hosts log the rest). */
export function handleAmicodeBridgeMessage(msg: unknown, io: BridgeIo): boolean {
  if (!isAmicode(msg)) return false;

  // target=_blank/window.open are dead inside the framed app — open https
  // links via the editor (system browser). https-only; scheme is
  // case-insensitive (RFC 3986).
  if (
    msg.kind === "open-external" &&
    typeof (msg as { url?: unknown }).url === "string" &&
    /^https:\/\//i.test((msg as unknown as { url: string }).url)
  ) {
    void vscode.env.openExternal(vscode.Uri.parse((msg as unknown as { url: string }).url));
    return true;
  }

  // File bridge (chat links to vault notes, run artifacts): the framed app
  // renders LLM output and can't open local files — the extension opens them
  // for it. file:// URLs only; the resolved path must be absolute,
  // bounded, and exist on disk. Posix path semantics (the fleet is mac/linux).
  if (
    msg.kind === "open-file" &&
    typeof (msg as { url?: unknown }).url === "string" &&
    /^file:\/\//i.test((msg as unknown as { url: string }).url)
  ) {
    let fsPath: string;
    try {
      fsPath = decodeURIComponent(new URL((msg as unknown as { url: string }).url).pathname);
    } catch {
      return true;
    }
    if (!path.isAbsolute(fsPath) || fsPath.length > 4096 || !fs.existsSync(fsPath)) return true;
    // Markdown (spec cards, vault notes) opens as a rendered preview tab;
    // anything else (run artifacts, .jld2, …) in the default editor.
    const command = /\.(md|markdown)$/i.test(fsPath) ? "markdown.showPreview" : "vscode.open";
    void vscode.commands.executeCommand(command, vscode.Uri.file(fsPath));
    return true;
  }

  // Paste bridge: navigator.clipboard is unavailable to the framed app (the
  // webview parent has no clipboard-read to delegate), so the app asks US —
  // the extension host reads the OS clipboard and replies. Visibility gate:
  // the app renders LLM-driven content, so a hidden panel must not be able to
  // sample the clipboard in the background.
  if (msg.kind === "clipboard-request") {
    if (!io.visible()) return true;
    void vscode.env.clipboard.readText().then((text) =>
      io.postToWebview({
        source: "amicode",
        kind: "clipboard",
        nonce: (msg as { nonce?: string }).nonce,
        text,
        tab: msg.tab,
      }),
    );
    return true;
  }

  // Copy bridge (mirror of clipboard-request): the framed app's native copy
  // can't reach the OS clipboard, so an in-chat ⌘C posts the text here and we
  // write it via vscode.env.clipboard — otherwise the paste bridge above reads
  // back stale content. Same visibility gate; payload is untrusted, so bound it.
  if (msg.kind === "clipboard-write" && typeof (msg as { text?: unknown }).text === "string") {
    if (!io.visible()) return true;
    const text = (msg as unknown as { text: string }).text;
    if (text.length > 5_000_000) return true;
    void vscode.env.clipboard.writeText(text);
    return true;
  }

  // Save bridge (run-card PNG export): downloads are dead inside the framed
  // app — the extension shows a save dialog and writes the file. PNG-only,
  // basename-only, bounded size: the payload is untrusted.
  if (
    msg.kind === "save-file" &&
    typeof (msg as { filename?: unknown }).filename === "string" &&
    typeof (msg as { dataUrl?: unknown }).dataUrl === "string"
  ) {
    const raw = msg as unknown as { filename: string; dataUrl: string };
    const prefix = "data:image/png;base64,";
    const base64 = raw.dataUrl.startsWith(prefix) ? raw.dataUrl.slice(prefix.length) : undefined;
    const name = path.basename(raw.filename).replace(/[^\w.-]+/g, "-");
    if (!base64 || base64.length > 24_000_000 || !name.endsWith(".png")) return true;
    void (async () => {
      const target = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(os.homedir(), "Downloads", name)),
        filters: { Images: ["png"] },
      });
      if (!target) return;
      await vscode.workspace.fs.writeFile(target, Buffer.from(base64, "base64"));
      const pick = await vscode.window.showInformationMessage(`Amicode: saved ${path.basename(target.fsPath)}`, "Reveal");
      if (pick === "Reveal") await vscode.commands.executeCommand("revealFileInOS", target);
    })();
    return true;
  }

  // The "Amico" palette group — allowlisted commands only.
  if (msg.kind === "command") {
    const command = (msg as unknown as { command?: unknown }).command;
    if (typeof command === "string" && BRIDGE_ALLOWED_COMMANDS.has(command)) {
      void vscode.commands.executeCommand(command);
      return true;
    }
    return false;
  }

  // Dashboard "Default model" control mirrors its choice into the
  // amicode.defaultModel setting, so the config pin (headless / first turn)
  // tracks the UI. "provider/model-id" only, bounded — untrusted.
  if (msg.kind === "set-default-model" && typeof (msg as { model?: unknown }).model === "string") {
    const model = (msg as unknown as { model: string }).model.trim();
    if (model.length > 0 && model.length <= 200 && /^[\w.-]+\/[\w.:-]+$/.test(model)) {
      void vscode.workspace.getConfiguration("amicode").update("defaultModel", model, vscode.ConfigurationTarget.Global);
    }
    return true;
  }

  return false;
}
