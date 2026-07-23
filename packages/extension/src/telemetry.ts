import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { TelemetryContext } from "./server_auth";

// ============================================================================
// Run-corpus telemetry — the extension-host glue around server_auth.ts's pure
// gate/encoding (buildTelemetryEnv). This module owns the settings/secret/consent
// keys, first-run consent, and sourcing the resource attributes the ingest Lambda
// keys on (RUN_CORPUS_SPEC.md). Nothing here transmits — it only resolves a
// TelemetryContext; server_auth decides whether the gate is open.
// ============================================================================

/** SecretStorage key for the ingest key — a secret, so NEVER a plaintext setting. */
export const TELEMETRY_INGEST_KEY_SECRET = "amicode.telemetry.ingestKey";
/** globalState key recording the first-run consent decision (true = Enable,
 *  false = Disable). UNSET = not answered → nothing transmits (default-on is
 *  NOT transmit-before-consent). */
export const TELEMETRY_CONSENT_KEY = "amicode.telemetry.consent";

/** Per-activation session id (STUB): the extension does not yet surface
 *  opencode's own per-conversation session id, so this groups every run from one
 *  activation under one stable id. Rides BOTH x-amicode-session and
 *  amicode.session (they must match — the Lambda's S3 key layout keys on it).
 *  Swap for the real opencode session id when the extension tracks it. */
export function mintTelemetrySession(): string {
  return randomUUID();
}

/** Branch name (`ref: refs/heads/<b>` → `<b>`) or a detached short SHA, parsed
 *  from a `.git/HEAD` file's contents. "" when unparseable. Pure — unit-tested. */
export function parseGitHead(head: string): string {
  const s = head.trim();
  const m = s.match(/^ref:\s*refs\/heads\/(.+)$/);
  if (m) return m[1].trim();
  if (/^[0-9a-f]{7,40}$/i.test(s)) return s.slice(0, 12); // detached HEAD → short sha
  return "";
}

/** Read `.git/HEAD`, following a `gitdir:` pointer for linked worktrees (where
 *  `.git` is a file, not a directory). Throws on any missing/unreadable path —
 *  the caller swallows it. */
function readGitHead(root: string): string {
  const dotGit = path.join(root, ".git");
  const stat = fs.statSync(dotGit);
  let gitDir = dotGit;
  if (!stat.isDirectory()) {
    const m = fs.readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)$/m);
    const p = m ? m[1].trim() : "";
    gitDir = path.isAbsolute(p) ? p : path.resolve(root, p);
  }
  return fs.readFileSync(path.join(gitDir, "HEAD"), "utf8");
}

/** repo + git ref from the FIRST workspace folder (the active workspace). repo =
 *  folder basename; git ref = the checked-out branch (or detached short SHA)
 *  read from `<folder>/.git/HEAD`. Never throws; no workspace / no git → "" for
 *  the missing piece (the attribute then rides empty, which the Lambda tolerates). */
export function resolveWorkspaceRepoRef(): { repo: string; gitRef: string } {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return { repo: "", gitRef: "" };
  const repo = path.basename(root);
  let gitRef = "";
  try {
    gitRef = parseGitHead(readGitHead(root));
  } catch {
    /* not a git checkout / unreadable HEAD → ref stays "" */
  }
  return { repo, gitRef };
}

/** Resolve the full TelemetryContext synchronously from settings + globalState +
 *  machineId + the active workspace. The SECRET key is passed IN — the caller
 *  reads it from SecretStorage once at activation and re-reads on the set-key
 *  command (SecretStorage.get is async; this stays sync so every spawn site can
 *  call it inline). server_auth's buildTelemetryEnv then applies the gate. */
export function resolveTelemetryContext(
  ctx: vscode.ExtensionContext,
  opts: { sessionId: string; key: string | undefined },
): TelemetryContext {
  const cfg = vscode.workspace.getConfiguration("amicode");
  const { repo, gitRef } = resolveWorkspaceRepoRef();
  return {
    enabled: cfg.get<boolean>("telemetry.enabled", true),
    consentAnswered: ctx.globalState.get<boolean>(TELEMETRY_CONSENT_KEY) !== undefined,
    endpoint: (cfg.get<string>("telemetry.endpoint", "") || "").trim().replace(/\/+$/, ""),
    key: opts.key ?? "",
    sessionId: opts.sessionId,
    // machineId: VS Code's stable, anonymized per-install id — a reasonable
    // pseudonymous user handle. A configured override could slot in here later.
    userId: vscode.env.machineId,
    repo,
    gitRef,
  };
}

/** First-run consent notification (a non-modal VS Code toast — NOT a modal or OS
 *  dialog). Shows ONLY when consent is unset. Enable/Disable both record an answer
 *  (so we never re-prompt) and set `amicode.telemetry.enabled`; a dismissed or
 *  auto-hidden notification leaves consent UNSET so we ask again next
 *  activation. On Enable, `onEnable` lets the caller bounce the server so capture
 *  starts on THIS boot rather than the next. Until answered, the gate stays shut. */
export async function maybePromptTelemetryConsent(
  ctx: vscode.ExtensionContext,
  opts?: { onEnable?: () => void },
): Promise<void> {
  if (ctx.globalState.get<boolean>(TELEMETRY_CONSENT_KEY) !== undefined) return; // already answered
  const choice = await vscode.window.showInformationMessage(
    "Help improve Amico. With your consent, agent runs — including your prompts and tool output, which may contain source code — are captured to Harmoniqs' internal run corpus so we can debug and improve the agent. Nothing is sent until you choose here. You can change this any time in Settings (amicode.telemetry.enabled).",
    "Enable",
    "Disable",
  );
  if (choice === undefined) return; // dismissed → leave unset, ask again next activation
  const enabled = choice === "Enable";
  await vscode.workspace
    .getConfiguration("amicode")
    .update("telemetry.enabled", enabled, vscode.ConfigurationTarget.Global);
  await ctx.globalState.update(TELEMETRY_CONSENT_KEY, enabled);
  if (enabled) opts?.onEnable?.();
}

/** Register `amicode.setTelemetryKey`: the only populate path for the ingest key
 *  (SecretStorage, never a setting). Empty input clears it. `onChange` hands the
 *  new value back to the caller (which updates its cached key + bounces the
 *  server so headers pick it up). */
export function registerTelemetryKeyCommand(
  ctx: vscode.ExtensionContext,
  onChange: (key: string) => void,
): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("amicode.setTelemetryKey", async () => {
      const input = await vscode.window.showInputBox({
        title: "Amicode: run-corpus ingest key",
        prompt: "Paste the ingest key (stored in VS Code SecretStorage, never a setting). Leave blank to clear.",
        password: true,
        ignoreFocusOut: true,
      });
      if (input === undefined) return; // cancel → no-op
      const key = input.trim();
      if (key === "") {
        await ctx.secrets.delete(TELEMETRY_INGEST_KEY_SECRET);
        onChange("");
        void vscode.window.showInformationMessage("Amicode: run-corpus ingest key cleared.");
        return;
      }
      await ctx.secrets.store(TELEMETRY_INGEST_KEY_SECRET, key);
      onChange(key);
      void vscode.window.showInformationMessage("Amicode: run-corpus ingest key saved.");
    }),
  );
}
