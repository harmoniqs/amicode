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
  /** Local opencode server for Connections proxy — lets the webview delegate
   *  credential POSTs to the extension host so they succeed even while the
   *  chat SSE is streaming (browser per-host connection-pool starvation). */
  server?: { url: string; authorization: string };
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

  // Save bridge (run-card PNG + session markdown export): downloads are dead
  // inside the framed app — the extension shows a save dialog and writes the
  // file. Bounded size, basename-only: the payload is untrusted.
  if (
    msg.kind === "save-file" &&
    typeof (msg as { filename?: unknown }).filename === "string" &&
    typeof (msg as { dataUrl?: unknown }).dataUrl === "string"
  ) {
    const raw = msg as unknown as { filename: string; dataUrl: string };
    const name = path.basename(raw.filename).replace(/[^\w.-]+/g, "-");
    if (!name || !/\.(png|md|markdown|txt)$/i.test(name)) return true;
    let base64: string | undefined;
    if (raw.dataUrl.startsWith("data:image/png;base64,")) base64 = raw.dataUrl.slice("data:image/png;base64,".length);
    else if (raw.dataUrl.startsWith("data:text/markdown;base64,")) base64 = raw.dataUrl.slice("data:text/markdown;base64,".length);
    else if (raw.dataUrl.startsWith("data:text/plain;base64,")) base64 = raw.dataUrl.slice("data:text/plain;base64,".length);
    else {
      const m = raw.dataUrl.match(/^data:[^;]+;base64,(.+)$/s);
      if (m) base64 = m[1];
    }
    if (!base64 || base64.length > 24_000_000) return true;
    const isPng = name.toLowerCase().endsWith(".png");
    void (async () => {
      const target = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(os.homedir(), "Downloads", name)),
        filters: isPng ? { Images: ["png"] } : { Markdown: ["md", "txt", "markdown"] },
      });
      if (!target) return;
      await vscode.workspace.fs.writeFile(target, Buffer.from(base64!, "base64"));
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

  // Redo Onboarding: reset state and open the onboarding panel (#433/#438).
  if (msg.kind === "redo-onboarding") {
    void vscode.commands.executeCommand("amicode.redoOnboarding");
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
      // Toggle OFF: clear overrides, reinstall the marketplace extension, and reload.
      void vscode.workspace.getConfiguration("amicode").update("opencodeBinary", "", vscode.ConfigurationTarget.Global);
      void vscode.workspace.getConfiguration("amicode").update("devAssetRoot", "", vscode.ConfigurationTarget.Global);

      // Guard: write a temporary marker so onboarding won't re-trigger after
      // the reinstall. The marker is consumed (deleted) on next activation.
      // A manual uninstall by the user does NOT write this marker, so
      // onboarding correctly re-triggers for genuine fresh installs.
      try {
        const { writeDevtoolsRestoreMarker } = require("./substrate/vault_store") as typeof import("./substrate/vault_store");
        writeDevtoolsRestoreMarker();
      } catch { /* non-critical — worst case onboarding re-shows */ }

      // Reinstall from the marketplace to restore the user's current release.
      // The old backup approach was fragile (went stale on extension updates).
      // Uninstall+install is the only reliable way to restore a clean dist —
      // `--force` alone says "already installed" for the same version.
      const installedExt = vscode.extensions.getExtension("harmoniqs.amicode");
      if (installedExt) {
        const { exec } = require("child_process") as typeof import("child_process");
        const extId = "harmoniqs.amicode";
        exec(`code --uninstall-extension ${extId} && code --install-extension ${extId}`, { timeout: 60_000 }, (err) => {
          if (err) {
            console.warn("[amicode/bridge] marketplace reinstall failed:", err.message);
          } else {
            console.log("[amicode/bridge] reinstalled marketplace extension");
          }
          void vscode.commands.executeCommand("workbench.action.reloadWindow");
        });
      } else {
        void vscode.commands.executeCommand("workbench.action.reloadWindow");
      }

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

        // ── Install opencode dependencies ──
        const installOc = await run("bun install", opencodePath);
        if (!installOc.ok) {
          io.postToWebview({
            source: "amicode", kind: "dev-tools-rebuild-status", tab: (msg as { tab?: string }).tab,
            state: "failed", error: `opencode install failed: ${installOc.error?.slice(0, 150)}`,
          });
          return;
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

        // ── Install amicode dependencies ──
        const installAc = await run("pnpm install", amicodePath);
        if (!installAc.ok) {
          io.postToWebview({
            source: "amicode", kind: "dev-tools-rebuild-status", tab: (msg as { tab?: string }).tab,
            state: "failed", error: `amicode install failed: ${installAc.error?.slice(0, 150)}`,
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

        // ── Copy built extension into the installed extension dir ──
        // VS Code loads extension.js from the installed path; devAssetRoot only
        // overrides resource resolution (templates, scores). To make the rebuild
        // self-hosting, we copy the freshly-built dist into the installed location.
        const installedExt = vscode.extensions.getExtension("harmoniqs.amicode");
        if (installedExt) {
          const installedDist = path.join(installedExt.extensionPath, "dist");
          const builtDist = path.join(amicodePath, "packages", "extension", "dist");
          // Backup the original marketplace dist once (idempotent)
          const backupDist = path.join(installedExt.extensionPath, "dist.marketplace-backup");
          if (!fs.existsSync(backupDist)) {
            try {
              fs.cpSync(installedDist, backupDist, { recursive: true });
              console.log("[amicode/bridge] backed up marketplace dist to", backupDist);
            } catch (backupErr) {
              console.warn("[amicode/bridge] dist backup failed:", backupErr);
            }
          }
          // Copy all built .js and .js.map files over
          try {
            const builtFiles = fs.readdirSync(builtDist).filter(f => f.endsWith(".js") || f.endsWith(".js.map"));
            for (const f of builtFiles) {
              fs.copyFileSync(path.join(builtDist, f), path.join(installedDist, f));
            }
            console.log("[amicode/bridge] copied", builtFiles.length, "files to installed extension dist");
          } catch (copyErr) {
            console.warn("[amicode/bridge] extension dist copy failed:", copyErr);
          }
          // Sync content directories that resolve via __dirname or
          // ctx.extensionPath at runtime. Without this, local changes to
          // skills, scores, templates, exemplars, the plugin, julia pins,
          // AGENTS.md, and tools are invisible until a fresh vsix install.
          const contentDirs = [
            "skills",
            "scores",
            "templates",
            "exemplars",
            "opencode-plugin",
            "julia",
            "tools",
          ];
          for (const dir of contentDirs) {
            try {
              const src = path.join(amicodePath, "packages", "extension", dir);
              const dest = path.join(installedExt.extensionPath, dir);
              if (fs.existsSync(src)) {
                fs.cpSync(src, dest, { recursive: true });
              }
            } catch (syncErr) {
              console.warn(`[amicode/bridge] ${dir}/ sync failed:`, syncErr);
            }
          }
          // Sync top-level markdown files (AGENTS.md, DISTILLER.md, etc.)
          const mdFiles = ["AGENTS.md", "DISTILLER.md", "CONTRACT.md"];
          for (const f of mdFiles) {
            try {
              const src = path.join(amicodePath, "packages", "extension", f);
              const dest = path.join(installedExt.extensionPath, f);
              if (fs.existsSync(src)) {
                fs.copyFileSync(src, dest);
              }
            } catch (syncErr) {
              console.warn(`[amicode/bridge] ${f} sync failed:`, syncErr);
            }
          }
          // Sync package.json — VS Code reads view/command contributions from
          // the installed extension's package.json at activation time. Without
          // this, a rebuilt extension.js that references renamed or new views
          // (e.g. amicode.workspace vs the old amicode.armonia) fails with
          // "No view is registered with id: ..." because the stale manifest
          // doesn't declare them.
          try {
            const src = path.join(amicodePath, "packages", "extension", "package.json");
            const dest = path.join(installedExt.extensionPath, "package.json");
            if (fs.existsSync(src)) {
              fs.copyFileSync(src, dest);
            }
          } catch (syncErr) {
            console.warn("[amicode/bridge] package.json sync failed:", syncErr);
          }
          console.log("[amicode/bridge] synced content dirs + markdown + package.json to installed extension");
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

        // ── Auto-reload ──
        // Don't restart the server separately — reloading the window restarts
        // the entire extension host, which spawns a fresh server with the new
        // binary. Restarting the server first kills the webview's HTTP source
        // and makes the "Rebuilding..." state vanish prematurely.
        io.postToWebview({
          source: "amicode", kind: "dev-tools-rebuild-status", tab: (msg as { tab?: string }).tab,
          state: "done",
        });

        // Brief pause so the webview can persist localStorage flags before reload
        await new Promise(r => setTimeout(r, 300));
        void vscode.commands.executeCommand("workbench.action.reloadWindow");
      } catch (e: unknown) {
        io.postToWebview({
          source: "amicode", kind: "dev-tools-rebuild-status", tab: (msg as { tab?: string }).tab,
          state: "failed", error: e instanceof Error ? e.message : "Unknown error",
        });
      }
    })();

    return true;
  }

  // Devcontainer VSIX build: builds both repos using the pnpm-based workflow
  // and emits a .vsix to the configured output path for manual installation.
  if (msg.kind === "dev-tools-build-vsix") {
    const opencodePath = typeof (msg as { opencodePath?: unknown }).opencodePath === "string"
      ? (msg as unknown as { opencodePath: string }).opencodePath.trim().replace(/^~/, os.homedir())
      : "";
    const amicodePath = typeof (msg as { amicodePath?: unknown }).amicodePath === "string"
      ? (msg as unknown as { amicodePath: string }).amicodePath.trim().replace(/^~/, os.homedir())
      : "";
    const outputPath = typeof (msg as { outputPath?: unknown }).outputPath === "string"
      ? (msg as unknown as { outputPath: string }).outputPath.trim().replace(/^~/, os.homedir())
      : "";

    if (!opencodePath || !amicodePath || !outputPath) {
      io.postToWebview({
        source: "amicode", kind: "dev-tools-build-vsix-status", tab: (msg as { tab?: string }).tab,
        state: "failed", error: "All three paths (opencode, amicode, output) must be set",
      });
      return true;
    }

    io.postToWebview({
      source: "amicode", kind: "dev-tools-build-vsix-status", tab: (msg as { tab?: string }).tab,
      state: "building",
    });

    void (async () => {
      const { exec, execFile } = await import("child_process");
      const run = (cmd: string, cwd: string): Promise<{ ok: boolean; error?: string; stdout?: string }> =>
        new Promise((resolve) => {
          exec(cmd, { cwd, timeout: 300_000, env: { ...process.env, NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--max-old-space-size=4096", AMICODE_OPENCODE_SRC: opencodePath } },
            (err, stdout, stderr) => {
              if (err) resolve({ ok: false, error: stderr?.trim() || err.message });
              else resolve({ ok: true, stdout: stdout?.trim() });
            });
        });

      try {
        // ── Step 1: Install opencode deps (bun-based repo) ──
        const installOc = await run("bun install", opencodePath);
        if (!installOc.ok) {
          io.postToWebview({
            source: "amicode", kind: "dev-tools-build-vsix-status", tab: (msg as { tab?: string }).tab,
            state: "failed", error: `bun install (opencode) failed: ${installOc.error?.slice(0, 200)}`,
          });
          return;
        }

        // ── Step 2: Install amicode deps (pnpm-based repo) ──
        const installAc = await run("pnpm install", amicodePath);
        if (!installAc.ok) {
          io.postToWebview({
            source: "amicode", kind: "dev-tools-build-vsix-status", tab: (msg as { tab?: string }).tab,
            state: "failed", error: `pnpm install (amicode) failed: ${installAc.error?.slice(0, 200)}`,
          });
          return;
        }

        // ── Step 3: Build extension bundle (esbuild) ──
        const buildExt = await run("pnpm --filter amicode build", amicodePath);
        if (!buildExt.ok) {
          io.postToWebview({
            source: "amicode", kind: "dev-tools-build-vsix-status", tab: (msg as { tab?: string }).tab,
            state: "failed", error: `pnpm build failed: ${buildExt.error?.slice(0, 200)}`,
          });
          return;
        }

        // ── Step 4: Build opencode binary + vendor it ──
        const buildOc = await run("pnpm --filter amicode opencode:build", amicodePath);
        if (!buildOc.ok) {
          io.postToWebview({
            source: "amicode", kind: "dev-tools-build-vsix-status", tab: (msg as { tab?: string }).tab,
            state: "failed", error: `opencode:build failed: ${buildOc.error?.slice(0, 200)}`,
          });
          return;
        }

        // ── Step 5: Package vsix ──
        const extDir = path.join(amicodePath, "packages", "extension");
        const vsixName = `amicode-${Date.now()}.vsix`;
        const vsixDest = path.join(outputPath, vsixName);

        fs.mkdirSync(outputPath, { recursive: true });

        // Use execFile (no shell) to avoid command injection via outputPath
        const packResult = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
          execFile("pnpm", ["exec", "vsce", "package", "--no-dependencies", "--allow-missing-repository", "-o", vsixDest],
            { cwd: extDir, timeout: 300_000, env: { ...process.env, NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--max-old-space-size=4096", AMICODE_OPENCODE_SRC: opencodePath } },
            (err, _stdout, stderr) => {
              if (err) resolve({ ok: false, error: stderr?.trim() || err.message });
              else resolve({ ok: true });
            });
        });
        if (!packResult.ok) {
          io.postToWebview({
            source: "amicode", kind: "dev-tools-build-vsix-status", tab: (msg as { tab?: string }).tab,
            state: "failed", error: `vsce package failed: ${packResult.error?.slice(0, 200)}`,
          });
          return;
        }

        io.postToWebview({
          source: "amicode", kind: "dev-tools-build-vsix-status", tab: (msg as { tab?: string }).tab,
          state: "done", vsixPath: vsixDest,
        });
      } catch (e: unknown) {
        io.postToWebview({
          source: "amicode", kind: "dev-tools-build-vsix-status", tab: (msg as { tab?: string }).tab,
          state: "failed", error: e instanceof Error ? e.message : "Unknown error",
        });
      }
    })();

    return true;
  }

  // #351 reverse: Work Column Device Inspector → extension refresh
  if (msg.kind === "device:refresh" && typeof (msg as { device?: unknown }).device === "string") {
    void vscode.commands.executeCommand("amicode.device.refresh");
    return true;
  }

  // Connections proxy (chat-busy fix): the webview delegates credential
  // mutations to the extension host so they don't compete with the chat SSE
  // for the browser's per-host connection pool. The extension forwards via
  // Node fetch with the per-boot Authorization header.
  if (
    typeof msg.kind === "string" &&
    (msg.kind === "connections-credential" ||
      msg.kind === "connections-disconnect" ||
      msg.kind === "connections-revalidate" ||
      msg.kind === "connections-auth" ||
      msg.kind === "connections-choose-project" ||
      msg.kind === "connections-add-custom" ||
      msg.kind === "connections-remove")
  ) {
    const tab = (msg as { tab?: string }).tab;
    const nonce = (msg as { nonce?: string }).nonce;
    const routeMap: Record<string, string> = {
      "connections-credential": "/amicode/connections/credential",
      "connections-disconnect": "/amicode/connections/disconnect",
      "connections-revalidate": "/amicode/connections/revalidate",
      "connections-auth": "/amicode/connections/auth",
      "connections-choose-project": "/amicode/connections/choose-project",
      "connections-add-custom": "/amicode/connections/add-custom",
      "connections-remove": "/amicode/connections/remove",
    };
    const route = routeMap[msg.kind];
    if (!route) return true;
    if (!io.server) {
      io.postToWebview({ source: "amicode", kind: `${msg.kind}-result`, tab, nonce, ok: false, error: "Amico server not ready" });
      return true;
    }
    const body = (msg as { body?: unknown }).body;
    const payload = typeof body === "string" ? body : JSON.stringify(body ?? {});
    void fetch(new URL(route, io.server.url).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: io.server.authorization },
      body: payload,
    })
      .then(async (res) => {
        let text: string;
        try {
          text = await res.text();
        } catch {
          text = JSON.stringify({ ok: false, error: "proxy: failed to read response" });
        }
        io.postToWebview({ source: "amicode", kind: `${msg.kind}-result`, tab, nonce, ok: res.ok, body: text, status: res.status });
      })
      .catch((e) => {
        io.postToWebview({
          source: "amicode",
          kind: `${msg.kind}-result`,
          tab,
          nonce,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      });
    return true;
  }

  // Data & Storage settings (#378): query resolved defaults on mount, and
  // update overrides (validate, write VS Code settings, restart server).
  if (msg.kind === "data-storage-query") {
    // Resolve the XDG defaults that opencode would use if no override is set.
    // Display with ~/ prefix for readability (consistent with Developer Tools).
    const xdgData = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
    const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
    const defaultDbPath = path.join(xdgData, "opencode", "opencode.db");
    const defaultConfigDir = path.join(xdgConfig, "opencode");
    const home = os.homedir();
    const shorten = (p: string) => p.startsWith(home) ? "~" + p.slice(home.length) : p;
    io.postToWebview({
      source: "amicode",
      kind: "data-storage-defaults",
      databasePath: shorten(defaultDbPath),
      configDir: shorten(defaultConfigDir),
      tab: msg.tab,
    });
    return true;
  }

  if (msg.kind === "data-storage-update") {
    const databasePath = typeof (msg as { databasePath?: unknown }).databasePath === "string"
      ? (msg as unknown as { databasePath: string }).databasePath.trim().replace(/^~/, os.homedir())
      : "";
    const configDir = typeof (msg as { configDir?: unknown }).configDir === "string"
      ? (msg as unknown as { configDir: string }).configDir.trim().replace(/^~/, os.homedir())
      : "";

    const reply: {
      source: "amicode"; kind: "data-storage-status"; tab?: string;
      databaseValid: boolean; databaseError?: string;
      configValid: boolean; configError?: string;
      serverRestarted: boolean;
    } = {
      source: "amicode",
      kind: "data-storage-status",
      tab: msg.tab,
      databaseValid: true,
      configValid: true,
      serverRestarted: false,
    };

    // Validate database path: must be absolute, parent directory must exist.
    if (databasePath) {
      if (!path.isAbsolute(databasePath)) {
        reply.databaseValid = false;
        reply.databaseError = "Path must be absolute";
      } else {
        const parentDir = path.dirname(databasePath);
        try {
          const stat = fs.statSync(parentDir);
          if (!stat.isDirectory()) {
            reply.databaseValid = false;
            reply.databaseError = "Parent path exists but is not a directory";
          }
        } catch {
          reply.databaseValid = false;
          reply.databaseError = "Parent directory does not exist";
        }
      }
    }

    // Validate config directory: must be absolute and must exist as a directory.
    if (configDir) {
      if (!path.isAbsolute(configDir)) {
        reply.configValid = false;
        reply.configError = "Path must be absolute";
      } else {
        try {
          const stat = fs.statSync(configDir);
          if (!stat.isDirectory()) {
            reply.configValid = false;
            reply.configError = "Path exists but is not a directory";
          }
        } catch {
          reply.configValid = false;
          reply.configError = "Directory does not exist";
        }
      }
    }

    // Write valid settings and restart server
    if (reply.databaseValid) {
      void vscode.workspace.getConfiguration("amicode").update(
        "sessionDatabase", databasePath, vscode.ConfigurationTarget.Global,
      );
    }
    if (reply.configValid) {
      void vscode.workspace.getConfiguration("amicode").update(
        "configDir", configDir, vscode.ConfigurationTarget.Global,
      );
    }

    // Restart the server so it picks up the new env vars
    if (reply.databaseValid && reply.configValid) {
      void vscode.commands.executeCommand("amicode.restartServer");
      reply.serverRestarted = true;
    }

    io.postToWebview(reply);
    return true;
  }

  return false;
}
