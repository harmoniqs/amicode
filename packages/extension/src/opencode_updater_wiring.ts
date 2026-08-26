// AMICODE (#451, M4): extension wiring for the canonical-opencode runtime
// updater. Activation bootstraps a managed install if none exists yet (never
// blocking activation), re-checks daily (timestamp-gated), exposes a manual
// command, and keeps `opencode-amicode` shimmed to the vendored fork binary so
// fleet/guard surfaces stay reachable after the PATH flip.
import * as vscode from "vscode";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  adoptRelease,
  checkForUpdate,
  currentVersion,
  managedBinary,
  managedRoot,
} from "./opencode_updater";
import { stageOpencodeCliLink } from "./opencode_cli_link";
import { opencodeDataDir } from "./opencode_xdg";

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

function lastCheckFile(): string {
  return path.join(managedRoot(), ".last-check");
}

function dueForCheck(): boolean {
  try {
    const stamp = JSON.parse(fs.readFileSync(lastCheckFile(), "utf8")) as { at?: number };
    if (typeof stamp.at === "number" && Date.now() - stamp.at < CHECK_INTERVAL_MS) return false;
  } catch {
    /* never checked */
  }
  return true;
}

function markChecked(): void {
  try {
    fs.mkdirSync(managedRoot(), { recursive: true });
    fs.writeFileSync(lastCheckFile(), JSON.stringify({ at: Date.now() }) + "\n");
  } catch {
    /* read-only root → we just re-check next activation */
  }
}

/** The live chat DB the gate's compat probe boots a copy against: the user's
 *  Data & Storage override if set, else opencode's default data-dir DB. */
export function resolveLiveDb(): string | undefined {
  const cfg = vscode.workspace.getConfiguration("amicode").get<string>("sessionDatabase", "").trim();
  if (cfg) return fs.existsSync(cfg) ? cfg : undefined;
  const def = path.join(opencodeDataDir(), "opencode.db");
  return fs.existsSync(def) ? def : undefined;
}

/** One check+adopt cycle. Silent on no-update/failure by design (auto-adopt
 *  posture: the user sees outcomes in the output channel, never a popup). */
async function runCycle(channel: vscode.OutputChannel, opts: { manual: boolean; extensionPath: string }): Promise<string> {
  const check = await checkForUpdate();
  if (check.kind === "current") {
    channel.appendLine(`[updater] ${opts.manual ? "check: " : ""}canonical opencode ${check.current ?? "(none installed)"} is current`);
    return `canonical opencode ${check.current ?? "(none)"} is current`;
  }
  const candidate = check.candidate!;
  channel.appendLine(`[updater] candidate ${candidate.version} (from ${check.current ?? "no install"}) — gating…`);
  const result = await adoptRelease({ candidate, log: channel, liveDbPath: resolveLiveDb() });
  if (!result.ok) {
    channel.appendLine(`[updater] staying on ${currentVersion() ?? "last-known-good"}: ${result.error}`);
    return `update to ${candidate.version} refused: ${result.error}`;
  }
  // #561: refresh the CLI symlink after adoption so it points to the new binary
  stageOpencodeCliLink(opts.extensionPath);
  return `updated canonical opencode → ${result.version}`;
}

/** Idempotent `opencode-amicode` shim → the vendored fork binary (fleet,
 *  guard, fallback stay reachable after the PATH flip puts canonical first). */
export function ensureForkShim(extensionPath: string): string | undefined {
  try {
    const shimDir = path.join(managedRoot(), "shims");
    const fork = path.join(extensionPath, "vendor", "opencode", `${process.platform}-${process.arch}`, "opencode");
    if (!fs.existsSync(fork)) return undefined;
    fs.mkdirSync(shimDir, { recursive: true });
    const shim = path.join(shimDir, "opencode-amicode");
    const want = `#!/bin/sh\nexec "${fork}" "$@"\n`;
    let current = "";
    try {
      current = fs.readFileSync(shim, "utf8");
    } catch {
      /* absent */
    }
    if (current !== want) {
      fs.writeFileSync(shim, want);
      fs.chmodSync(shim, 0o755);
    }
    return shimDir;
  } catch {
    return undefined;
  }
}

/** The PATH entries that make the managed canonical win inside the Amicode
 *  terminal (D2: managed canonical first; the fork stays reachable via the
 *  shim). Empty when nothing is installed yet. */
export function managedPathEntries(extensionPath: string): string[] {
  const entries: string[] = [];
  if (managedBinary()) entries.push(path.join(managedRoot(), "current"));
  const shimDir = ensureForkShim(extensionPath);
  if (shimDir) entries.push(shimDir);
  return entries;
}

export function registerOpencodeUpdater(
  ctx: vscode.ExtensionContext,
  channel: vscode.OutputChannel,
): void {
  const extensionPath = ctx.extensionPath;
  // Bootstrap: a fresh machine gets its managed install at first activation.
  // Fire-and-forget — activation must never block on a download. A FAILED
  // bootstrap does not mark the check done: an offline machine retries on the
  // next activation (cheap — the check fails fast) and self-heals the moment
  // it comes online, instead of waiting out the 24h gate.
  if (!managedBinary()) {
    channel.appendLine("[updater] no managed canonical opencode — bootstrapping (background)");
    void runCycle(channel, { manual: false, extensionPath }).then((msg) => {
      channel.appendLine(`[updater] bootstrap: ${msg}`);
      if (managedBinary()) markChecked();
    });
  } else if (dueForCheck()) {
    void runCycle(channel, { manual: false, extensionPath });
    markChecked();
  }

  // Daily re-check while the window lives (activations usually beat the timer).
  const timer = setInterval(() => {
    if (dueForCheck()) {
      void runCycle(channel, { manual: false, extensionPath });
      markChecked();
    }
  }, 60 * 60 * 1000);
  ctx.subscriptions.push({ dispose: () => clearInterval(timer) });

  ctx.subscriptions.push(
    vscode.commands.registerCommand("amicode.updateOpencode", async () => {
      const msg = await runCycle(channel, { manual: true, extensionPath });
      void vscode.window.showInformationMessage(msg);
    }),
  );
}
