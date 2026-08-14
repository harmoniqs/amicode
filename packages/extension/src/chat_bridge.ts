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
  // The composer's report-a-bug button (fork #116) posts this over the command
  // lane; the registered command owns the bug session end-to-end (#250).
  "amicode.reportBug",
  // ⌘⇧P inside the chat iframe lands in the APP's palette, not VS Code's —
  // the fork forwards it here so the editor's Command Palette (where every
  // Amicode: command lives) opens as users expect.
  "workbench.action.showCommands",
]);

/** The bug-session lifecycle sink (amicode#250) — the panels wire the
 *  BugReportManager's. Structural, so the bridge never imports the manager. */
export interface BugReportSink {
  filed(sessionID: string, url: string): void;
  closed(sessionID: string): void;
  poke(): void;
}

/** Side channels the handler needs from its host panel. */
export interface BridgeIo {
  /** Clipboard reads only answer while the user can see the chat. */
  visible(): boolean;
  /** Replies (clipboard text) go back to the host webview; `tab` echoes along. */
  postToWebview(msg: unknown): void;
  /** Bug-session lifecycle (bug-filed / bug-report-closed). Undefined until the
   *  manager registers at activation; the kinds are consumed regardless. */
  bugReport?: BugReportSink;
}

const isAmicode = (msg: unknown): msg is { source: "amicode"; kind: string; tab?: string } =>
  !!msg && typeof msg === "object" && (msg as { source?: unknown }).source === "amicode";

/** The optional model selection on the report-a-bug command (amicode#249):
 *  providerID + modelID + optional variant, all bounded strings. Returns
 *  undefined for absent/malformed — a bad model field never blocks the
 *  command; the manager just falls back to the server default. */
export function extractReportBugModel(
  msg: unknown,
): { providerID: string; modelID: string; variant?: string } | undefined {
  const model = (msg as { model?: unknown }).model;
  if (!model || typeof model !== "object") return undefined;
  const providerID = (model as { providerID?: unknown }).providerID;
  const modelID = (model as { modelID?: unknown }).modelID;
  const variant = (model as { variant?: unknown }).variant;
  if (typeof providerID !== "string" || providerID === "" || providerID.length > 200) return undefined;
  if (typeof modelID !== "string" || modelID === "" || modelID.length > 200) return undefined;
  return {
    providerID,
    modelID,
    ...(typeof variant === "string" && variant !== "" && variant.length <= 200 ? { variant } : {}),
  };
}

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
      // amicode#249 QA: the report-a-bug command may carry the composer's live
      // model selection (providerID + modelID + variant — the bug session
      // runs what the user was running). Shape-validated, bounded; anything
      // malformed is stripped, never fatal to the command.
      void vscode.commands.executeCommand(command);
      return true;
    }
    return false;
  }

  // Bug-session lifecycle up-kinds (#250): the dock's sentinel watcher reports
  // a filing, the close control reports a pre-file abandon. The manager owns
  // the known-id check (unknown ids drop there); we only shape-validate.
  // Consumed either way — these are our envelopes, never foreign noise.
  if (msg.kind === "bug-filed") {
    const sessionID = (msg as unknown as { sessionID?: unknown }).sessionID;
    const url = (msg as unknown as { url?: unknown }).url;
    if (typeof sessionID === "string" && sessionID !== "") {
      io.bugReport?.filed(sessionID, typeof url === "string" ? url : "");
    }
    return true;
  }
  if (msg.kind === "bug-report-closed") {
    const sessionID = (msg as unknown as { sessionID?: unknown }).sessionID;
    if (typeof sessionID === "string" && sessionID !== "") io.bugReport?.closed(sessionID);
    return true;
  }
  // The app's boot catch-up: re-post open-bug-report when a bug session is
  // live (heals a lost one-shot open — cold-boot race, webview reload).
  if (msg.kind === "bug-report-poke") {
    io.bugReport?.poke();
    return true;
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

  // Developer Tools settings: validate paths, write VS Code settings, restart
  // server / prompt reload as appropriate. The app posts on blur and on toggle.
  if (msg.kind === "dev-tools-update") {
    const enabled = (msg as { enabled?: unknown }).enabled === true;
    const opencodePath = typeof (msg as { opencodePath?: unknown }).opencodePath === "string"
      ? (msg as unknown as { opencodePath: string }).opencodePath.trim()
      : "";
    const amicodePath = typeof (msg as { amicodePath?: unknown }).amicodePath === "string"
      ? (msg as unknown as { amicodePath: string }).amicodePath.trim()
      : "";

    const reply: {
      source: "amicode"; kind: "dev-tools-status"; tab?: string;
      opencodeValid: boolean; opencodeError?: string;
      amicodeValid: boolean; amicodeError?: string;
      serverRestarted: boolean; reloadNeeded: boolean;
    } = {
      source: "amicode",
      kind: "dev-tools-status",
      tab: msg.tab,
      opencodeValid: true,
      amicodeValid: true,
      serverRestarted: false,
      reloadNeeded: false,
    };

    if (!enabled) {
      // Toggle OFF: clear overrides and restart with vendored binary
      void vscode.workspace.getConfiguration("amicode").update("opencodeBinary", "", vscode.ConfigurationTarget.Global);
      void vscode.workspace.getConfiguration("amicode").update("devAssetRoot", "", vscode.ConfigurationTarget.Global);
      void vscode.commands.executeCommand("amicode.restartServer");
      reply.serverRestarted = true;
      io.postToWebview(reply);
      return true;
    }

    // Validate opencode path: resolve the binary from the repo root
    let resolvedBinary = "";
    if (opencodePath) {
      // The dev binary lives at <root>/packages/opencode/dist/opencode/bin/opencode
      // or <root>/cmd/opencode (Go), or the user may point directly at a binary.
      const candidates = [
        path.join(opencodePath, "packages", "opencode", "dist", "opencode", "bin", "opencode"),
        path.join(opencodePath, "dist", "opencode", "bin", "opencode"),
        opencodePath, // direct binary path
      ];
      for (const candidate of candidates) {
        try {
          const stat = fs.statSync(candidate);
          if (stat.isFile()) {
            // Check executable bit (unix)
            try {
              fs.accessSync(candidate, fs.constants.X_OK);
              resolvedBinary = candidate;
              break;
            } catch {
              reply.opencodeValid = false;
              reply.opencodeError = "Binary exists but is not executable";
            }
          }
        } catch {
          // not found, try next
        }
      }
      if (!resolvedBinary && reply.opencodeValid) {
        reply.opencodeValid = false;
        reply.opencodeError = "Binary not found at this path";
      }
    }

    // Validate amicode path: must be a repo root with packages/extension
    if (amicodePath) {
      const extensionDir = path.join(amicodePath, "packages", "extension");
      try {
        const stat = fs.statSync(extensionDir);
        if (!stat.isDirectory()) {
          reply.amicodeValid = false;
          reply.amicodeError = "packages/extension not found in repo";
        }
      } catch {
        // Fall back: check if the path itself is a directory (maybe they pointed at the repo root
        // but packages/extension doesn't exist yet)
        try {
          const stat = fs.statSync(amicodePath);
          if (!stat.isDirectory()) {
            reply.amicodeValid = false;
            reply.amicodeError = "Path exists but is not a directory";
          } else {
            reply.amicodeValid = false;
            reply.amicodeError = "packages/extension not found in repo — is this the Amicode repo root?";
          }
        } catch {
          reply.amicodeValid = false;
          reply.amicodeError = "Directory does not exist";
        }
      }
    }

    // Apply valid settings
    if (reply.opencodeValid && opencodePath) {
      void vscode.workspace.getConfiguration("amicode").update(
        "opencodeBinary", resolvedBinary || opencodePath, vscode.ConfigurationTarget.Global,
      );
      void vscode.commands.executeCommand("amicode.restartServer");
      reply.serverRestarted = true;
    } else if (reply.opencodeValid && !opencodePath) {
      // Empty path with enabled ON → clear the override (use vendored)
      void vscode.workspace.getConfiguration("amicode").update("opencodeBinary", "", vscode.ConfigurationTarget.Global);
      void vscode.commands.executeCommand("amicode.restartServer");
      reply.serverRestarted = true;
    }

    if (reply.amicodeValid && amicodePath) {
      // Run a full extension build in the amicode repo root, then set devAssetRoot
      // to the built extension directory and prompt a reload with deep-link to
      // the developer tools section for continuity.
      const extensionDir = path.join(amicodePath, "packages", "extension");

      // Notify the app that a build is in progress
      io.postToWebview({ ...reply, building: true });

      // Build + reload is async; fire-and-forget from the sync handler.
      void (async () => {
        const { exec } = await import("child_process");
        const buildResult = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
          exec("bun run build", { cwd: amicodePath, timeout: 120_000 }, (err, _stdout, stderr) => {
            if (err) {
              resolve({ ok: false, error: stderr?.trim() || err.message });
            } else {
              resolve({ ok: true });
            }
          });
        });

        if (!buildResult.ok) {
          reply.amicodeValid = false;
          reply.amicodeError = `Build failed: ${buildResult.error?.slice(0, 200) ?? "unknown error"}`;
          io.postToWebview(reply);
          return;
        }

        void vscode.workspace.getConfiguration("amicode").update(
          "devAssetRoot", extensionDir, vscode.ConfigurationTarget.Global,
        );
        reply.reloadNeeded = true;
        io.postToWebview(reply);

        // Auto-reload after a short delay so the webview can persist state.
        setTimeout(() => {
          void vscode.commands.executeCommand("workbench.action.reloadWindow");
        }, 500);
      })();
    } else if (reply.amicodeValid && !amicodePath) {
      void vscode.workspace.getConfiguration("amicode").update("devAssetRoot", "", vscode.ConfigurationTarget.Global);
    }

    // For the async build case, the reply is posted from within the IIFE.
    // For all other cases, post the reply here.
    if (!(reply.amicodeValid && amicodePath)) {
      io.postToWebview(reply);
    }
    return true;
  }

  // Full rebuild: builds both opencode and amicode, then triggers reload.
  // mode: "local" = build from whatever's on disk; "remote" = git pull first.
  if (msg.kind === "dev-tools-rebuild") {
    const mode = (msg as { mode?: string }).mode === "remote" ? "remote" : "local";
    const opencodePath = typeof (msg as { opencodePath?: unknown }).opencodePath === "string"
      ? (msg as unknown as { opencodePath: string }).opencodePath.trim().replace(/^~/, os.homedir())
      : "";
    const amicodePath = typeof (msg as { amicodePath?: unknown }).amicodePath === "string"
      ? (msg as unknown as { amicodePath: string }).amicodePath.trim().replace(/^~/, os.homedir())
      : "";

    if (!opencodePath || !amicodePath) {
      io.postToWebview({
        source: "amicode", kind: "dev-tools-rebuild-status", tab: (msg as { tab?: string }).tab,
        state: "failed", error: "Both repo paths must be set",
      });
      return true;
    }

    // Notify the app that a rebuild is in progress
    io.postToWebview({
      source: "amicode", kind: "dev-tools-rebuild-status", tab: (msg as { tab?: string }).tab,
      state: "rebuilding",
    });

    void (async () => {
      const { exec } = await import("child_process");
      const run = (cmd: string, cwd: string): Promise<{ ok: boolean; error?: string }> =>
        new Promise((resolve) => {
          exec(cmd, { cwd, timeout: 180_000 }, (err, _stdout, stderr) => {
            if (err) resolve({ ok: false, error: stderr?.trim() || err.message });
            else resolve({ ok: true });
          });
        });

      try {
        // ── Session DB backup ──
        const dbDir = path.join(os.homedir(), ".local", "share", "opencode");
        const backupDir = path.join(dbDir, `.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`);
        try {
          const files = fs.readdirSync(dbDir).filter(f => f.startsWith("opencode") && f.endsWith(".db"));
          if (files.length > 0) {
            fs.mkdirSync(backupDir, { recursive: true });
            for (const f of files) {
              fs.copyFileSync(path.join(dbDir, f), path.join(backupDir, f));
              // Copy sidecars if they exist
              for (const ext of ["-wal", "-shm"]) {
                const sidecar = path.join(dbDir, f + ext);
                if (fs.existsSync(sidecar)) fs.copyFileSync(sidecar, path.join(backupDir, f + ext));
              }
            }
          }
        } catch {
          // DB backup is best-effort
        }

        // ── Git pull (remote mode only) ──
        // opencode: checkout local/amicode, amicode: checkout main
        if (mode === "remote") {
          const checkoutOc = await run("git fetch origin && git checkout local/amicode && git pull --rebase origin local/amicode", opencodePath);
          if (!checkoutOc.ok) {
            io.postToWebview({
              source: "amicode", kind: "dev-tools-rebuild-status", tab: (msg as { tab?: string }).tab,
              state: "failed", error: `git pull (opencode) failed: ${checkoutOc.error?.slice(0, 150)}`,
            });
            return;
          }
          const checkoutAc = await run("git fetch origin && git checkout main && git pull --rebase origin main", amicodePath);
          if (!checkoutAc.ok) {
            io.postToWebview({
              source: "amicode", kind: "dev-tools-rebuild-status", tab: (msg as { tab?: string }).tab,
              state: "failed", error: `git pull (amicode) failed: ${checkoutAc.error?.slice(0, 150)}`,
            });
            return;
          }
        }

        // ── Build opencode ──
        const ocBuildDir = path.join(opencodePath, "packages", "opencode");
        const buildOc = await run("bun run script/build.ts --single --skip-install", ocBuildDir);
        if (!buildOc.ok) {
          io.postToWebview({
            source: "amicode", kind: "dev-tools-rebuild-status", tab: (msg as { tab?: string }).tab,
            state: "failed", error: `opencode build failed: ${buildOc.error?.slice(0, 150)}`,
          });
          return;
        }

        // ── Build amicode ──
        const buildAc = await run("bun run build", amicodePath);
        if (!buildAc.ok) {
          io.postToWebview({
            source: "amicode", kind: "dev-tools-rebuild-status", tab: (msg as { tab?: string }).tab,
            state: "failed", error: `amicode build failed: ${buildAc.error?.slice(0, 150)}`,
          });
          return;
        }

        // ── Resolve and codesign the built binary ──
        const candidates = [
          path.join(opencodePath, "packages", "opencode", "dist", `opencode-darwin-arm64`, "bin", "opencode"),
          path.join(opencodePath, "packages", "opencode", "dist", `opencode-darwin-x64`, "bin", "opencode"),
          path.join(opencodePath, "packages", "opencode", "dist", "opencode", "bin", "opencode"),
        ];
        let resolvedBinary = "";
        for (const c of candidates) {
          try { if (fs.statSync(c).isFile()) { resolvedBinary = c; break; } } catch { /* next */ }
        }
        if (resolvedBinary) {
          await run(`codesign --sign - --force "${resolvedBinary}"`, opencodePath).catch(() => {});
        }

        // ── Apply VS Code settings ──
        const extensionDir = path.join(amicodePath, "packages", "extension");
        if (resolvedBinary) {
          void vscode.workspace.getConfiguration("amicode").update(
            "opencodeBinary", resolvedBinary, vscode.ConfigurationTarget.Global,
          );
        }
        void vscode.workspace.getConfiguration("amicode").update(
          "devAssetRoot", extensionDir, vscode.ConfigurationTarget.Global,
        );

        // ── Restart server + auto-reload ──
        void vscode.commands.executeCommand("amicode.restartServer");

        io.postToWebview({
          source: "amicode", kind: "dev-tools-rebuild-status", tab: (msg as { tab?: string }).tab,
          state: "done",
        });

        // Auto-reload the window after a short delay so the webview can
        // persist the "rebuilt" flag to localStorage before the reload hits.
        setTimeout(() => {
          void vscode.commands.executeCommand("workbench.action.reloadWindow");
        }, 500);
      } catch (e: unknown) {
        io.postToWebview({
          source: "amicode", kind: "dev-tools-rebuild-status", tab: (msg as { tab?: string }).tab,
          state: "failed", error: e instanceof Error ? e.message : "Unknown error",
        });
      }
    })();

    return true;
  }

  return false;
}
