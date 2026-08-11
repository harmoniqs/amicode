// Amicode terminal — bundles the canonical opencode with amicode.
// When the user installs amicode in VS Code, `opencode` in a plain
// integrated terminal is the user's global `~/.opencode/bin/opencode` (or
// whatever is on PATH) — it knows nothing about amicode's fleet, guard,
// fallback, or the per-workspace OPENCODE_CONFIG_CONTENT that makes the
// chat's opencode amicode-aware. This module makes the terminal opencode
// canonical: the same vendored binary + the same config the chat server
// was spawned with, so `opencode` in the terminal can diagnose fleet,
// run `pnpm sync`, and see the same sessions.
//
// Two surfaces:
//   - Command `Amicode: Open Amicode Terminal` — opens a shell whose
//     PATH is prepended with the vendored opencode dir + amico-run
//     launcher, and whose env carries OPENCODE_CONFIG_CONTENT (and
//     OPENCODE_SERVER_PASSWORD when relevant). `opencode` there is the
//     amicode-aware one; plain `bash` still works and `amico` resolves.
//   - The shell is a normal login shell (zsh/bash), not an opencode TUI
//     — so `pnpm sync`, `bash tools/fleet/install.sh --check`, `amico`
//     etc. all work, and `opencode` can be run on demand. An `opencode`
//     arg can be passed to directly open the TUI.

import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

export interface AmicodeTerminalDeps {
  extensionPath: string;
  getConfigContent: () => string | undefined;
  getSpawnEnv: () => Record<string, string> | undefined;
  channel: vscode.OutputChannel;
}

export function registerAmicodeTerminal(ctx: vscode.ExtensionContext, deps: AmicodeTerminalDeps): void {
  const disposable = vscode.commands.registerCommand("amicode.openAmicodeTerminal", async (arg?: string) => {
    const vendorDir = path.join(deps.extensionPath, "vendor", "opencode", `${process.platform}-${process.arch}`);
    const vendorBin = path.join(vendorDir, "opencode");
    const hasVendor = fs.existsSync(vendorBin);

    // Resolve amico-run launcher for PATH
    const amicoRunCandidates = [
      path.join(deps.extensionPath, "bin", "launcher"),
      path.join(deps.extensionPath, "..", "amico-run", "launcher"),
    ];
    let amicoRunDir: string | undefined;
    for (const c of amicoRunCandidates) {
      if (fs.existsSync(path.join(c, "amico-run"))) {
        amicoRunDir = c;
        break;
      }
    }

    // Build env for the terminal: same OPENCODE_CONFIG_CONTENT the chat server
    // was spawned with, plus PATH prepended so `opencode` and `amico` resolve
    // to the vendored/amico-run bins. Also carry OPENCODE_SERVER_PASSWORD so
    // a terminal `opencode attach` can auth to the fleet tunnel when needed.
    const spawnEnv = deps.getSpawnEnv?.() ?? {};
    const configContent = deps.getConfigContent?.();
    const env: Record<string, string> = { ...process.env } as Record<string, string>;

    // PATH: vendor dir (for `opencode`) + amico-run launcher (for `amico`)
    const pathParts: string[] = [];
    if (hasVendor) pathParts.push(vendorDir);
    if (amicoRunDir) pathParts.push(amicoRunDir);
    if (process.env.PATH) pathParts.push(process.env.PATH);
    if (pathParts.length) env.PATH = pathParts.join(path.delimiter);

    if (configContent) env.OPENCODE_CONFIG_CONTENT = configContent;
    if (spawnEnv.OPENCODE_SERVER_PASSWORD) env.OPENCODE_SERVER_PASSWORD = spawnEnv.OPENCODE_SERVER_PASSWORD;
    if (spawnEnv.OPENCODE_SERVER_USERNAME) env.OPENCODE_SERVER_USERNAME = spawnEnv.OPENCODE_SERVER_USERNAME;
    // Carry fleet standalone hint as env for shell scripts that check it
    try {
      const fleetJson = path.join(os.homedir(), ".amico", "ops", "fleet", "fleet.json");
      if (fs.existsSync(fleetJson)) {
        const cfg = JSON.parse(fs.readFileSync(fleetJson, "utf8"));
        if (cfg?.role === "standalone") env.AMICO_FLEET_STANDALONE = "1";
      }
      // Legacy fallback.json — also treat as standalone hint
      const fallback = path.join(os.homedir(), ".amico", "ops", "fleet", "fallback.json");
      if (fs.existsSync(fallback)) env.AMICO_FLEET_STANDALONE = "1";
    } catch {}

    // Also expose the repo root so `pnpm sync` works from any cwd
    const repoRoot = path.resolve(deps.extensionPath, "..", "..");
    if (fs.existsSync(path.join(repoRoot, "scripts", "repo-sync.sh"))) {
      env.AMICO_REPO_ROOT = repoRoot;
    }

    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();

    // If an arg like "opencode" or "opencode attach ..." is passed, run that
    // directly as the terminal's shell; otherwise open a normal shell with the
    // amicode env. This lets the command palette do both:
    //   Amicode: Open Amicode Terminal         → shell with amicode env
    //   Amicode: Open Amicode Terminal (opencode) → opencode TUI
    let shellPath: string | undefined;
    let shellArgs: string[] | undefined;
    if (typeof arg === "string" && arg.trim().startsWith("opencode")) {
      if (hasVendor) {
        // Run the vendored opencode directly as the shell — the terminal *is* the TUI
        shellPath = vendorBin;
        const rest = arg.trim().slice("opencode".length).trim();
        shellArgs = rest ? rest.split(/\s+/) : [];
      } else {
        shellPath = undefined; // fall back to shell, `opencode` will be whatever is on PATH
        shellArgs = undefined;
      }
    }

    const term = vscode.window.createTerminal({
      name: hasVendor ? "Amicode" : "Amicode (no vendor — run pnpm sync)",
      shellPath,
      shellArgs,
      cwd,
      env,
      message: hasVendor
        ? "Amicode terminal — `opencode` is the vendored amicode-aware binary (fleet, guard, fallback). `amico`, `pnpm sync`, `bash tools/fleet/install.sh --check` all work here."
        : "Amicode terminal — vendored opencode not found (run pnpm sync --fix). `amico` may still work via PATH.",
    });
    term.show();
    deps.channel.appendLine(`[terminal] opened Amicode terminal cwd=${cwd} vendor=${hasVendor ? vendorBin : "(missing)"} amicoRunDir=${amicoRunDir ?? "(missing)"}`);
  });

  ctx.subscriptions.push(disposable);
}
