// eula.ts — the install-time End User License Agreement gate.
//
// VS Code has no declarative, manifest-level "must accept the EULA to install"
// hook for extensions (verified against microsoft/vscode — the only shipping
// mechanism is the `license` manifest field, packaged by vsce as the
// `Microsoft.VisualStudio.Services.Content.License` gallery asset, shown under
// Resources on the Marketplace/Open VSX listing). The SUPPORTED way to make an
// end user actually agree is the pattern Microsoft uses for C/C++ (cpptools) and
// the IntelliJ extensions: a modal Accept/Decline prompt on first activation,
// persisted per machine, with the extension inert until acceptance.
//
// This module owns:
//   - EULA_VERSION: bump it whenever the EULA text changes materially — recorded
//     acceptance is keyed on it, so everyone is re-prompted on the new text.
//   - isEulaAccepted(memento): the pure gate predicate (unit-tested).
//   - eulaText(): the text shown when the user asks to read (EULA.txt from the
//     extension root — the same file vsce packages as the License asset).
//   - ensureEulaAccepted(): the activation-time gate. Runs the modal loop.
//   - registerEulaCommand(): the `amicode.reviewEula` palette command, available
//     in EVERY mode (full and gate) so a declining user can always come back.
//   - registerEulaGateSurface(): the inert-mode UX — status bar item + a stub
//     sidebar view (the contributed `amicode.workspace` view would otherwise
//     render VS Code's generic "no provider registered" error pane).
//
// Acceptance lives in globalState (per machine), like the telemetry consent and
// the What's-New last-seen version. An install that accepted v<old> is NOT
// accepted for a bumped EULA_VERSION.
import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";

export const EULA_ACCEPTED_KEY = "amicode.eula.acceptedVersion";
/** The EULA text version acceptance is keyed on. Bump on any material change
 *  to EULA.txt (the final legal text lands as a bump, re-prompting all users). */
export const EULA_VERSION = "0.1.0-placeholder";
export const EULA_FILE = "EULA.txt";

/** User-facing EULA version for UI chrome (sidebar footer, modal). The
 *  acceptance key stays EULA_VERSION ("0.1.0-placeholder") until the final
 *  legal text lands; the UI shows the clean version. */
export const EULA_DISPLAY_VERSION = "0.1.0";

const ACCEPT = "Accept EULA";
const READ = "Read EULA";
const DECLINE = "Decline";

/** Embedded fallback so the read-path never dead-ends if EULA.txt is missing
 *  from the install (packaging regression). Deliberately short; the real text
 *  lives in EULA.txt. */
export const PLACEHOLDER_EULA = `AMICODE — END USER LICENSE AGREEMENT
Version ${EULA_VERSION} (PLACEHOLDER)

The bundled EULA.txt could not be read from this installation. This is a
placeholder, not legal text — Harmoniqs has not supplied the final agreement.
By accepting you agree to be bound by the EULA shipped in this extension
(EULA.txt). Replace this file with counsel-approved wording before external
release. Copyright (c) 2026 Harmoniqs, Inc.`;

/** Minimal memento shape (matches the WhatsNewMemento convention). */
export interface EulaMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

/** The gate predicate: accepted IFF the recorded version matches the current
 *  EULA_VERSION. Unset, an older version, or junk → not accepted. */
export function isEulaAccepted(memento: EulaMemento | undefined): boolean {
  if (!memento) return false;
  return memento.get<unknown>(EULA_ACCEPTED_KEY) === EULA_VERSION;
}

/** The EULA text for the read-path: EULA.txt from the extension root, falling
 *  back to the embedded placeholder. Never throws. */
export function eulaText(extensionPath: string, readFile: (p: string) => string = (p) => fs.readFileSync(p, "utf8")): string {
  try {
    const text = readFile(path.join(extensionPath, EULA_FILE));
    return text.trim() !== "" ? text : PLACEHOLDER_EULA;
  } catch {
    return PLACEHOLDER_EULA;
  }
}

/** Open the EULA for reading: the real EULA.txt when present, else an untitled
 *  document carrying the embedded placeholder. */
async function openEulaDocument(ctx: vscode.ExtensionContext): Promise<void> {
  try {
    const uri = vscode.Uri.file(path.join(ctx.extensionPath, EULA_FILE));
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });
    return;
  } catch {
    // fall through to the embedded placeholder
  }
  try {
    const doc = await vscode.workspace.openTextDocument({ content: PLACEHOLDER_EULA, language: "plaintext" });
    await vscode.window.showTextDocument(doc, { preview: false });
  } catch {
    /* no editor available — the modal keeps looping; the user can still accept or decline */
  }
}

const MODAL_DETAIL =
  `Amicode is provided by Harmoniqs, Inc. under the End User License Agreement bundled with this extension ` +
  `(EULA.txt, version ${EULA_DISPLAY_VERSION}).\n\n` +
  `Accept to activate Amicode. Decline and Amicode stays inert — no server, no views, no commands — until you ` +
  `accept (Command Palette → "Amicode: Review EULA").`;

/** The modal accept/read/decline loop. Resolves true iff the user accepted
 *  (and acceptance was recorded). Declining or dismissing the modal → false. */
export async function promptForEula(ctx: vscode.ExtensionContext, log?: (line: string) => void): Promise<boolean> {
  for (;;) {
    const choice = await vscode.window.showInformationMessage(
      "Amicode End User License Agreement",
      { modal: true, detail: MODAL_DETAIL },
      ACCEPT,
      READ,
      DECLINE,
    );
    if (choice === ACCEPT) {
      await ctx.globalState.update(EULA_ACCEPTED_KEY, EULA_VERSION);
      log?.(`[eula] EULA ${EULA_VERSION} accepted`);
      return true;
    }
    if (choice === READ) {
      await openEulaDocument(ctx);
      continue;
    }
    log?.(`[eula] EULA ${EULA_VERSION} not accepted (choice: ${choice ?? "dismissed"})`);
    return false;
  }
}

/** Activation-time gate. true = accepted (now or previously) → proceed with a
 *  full activation. false = declined/dismissed → caller registers the inert
 *  gate surface and returns. */
export async function ensureEulaAccepted(
  ctx: vscode.ExtensionContext,
  log?: (line: string) => void,
): Promise<boolean> {
  if (isEulaAccepted(ctx.globalState)) return true;
  return promptForEula(ctx, log);
}

async function reviewEula(ctx: vscode.ExtensionContext, log?: (line: string) => void): Promise<void> {
  if (isEulaAccepted(ctx.globalState)) {
    await openEulaDocument(ctx);
    return;
  }
  const accepted = await promptForEula(ctx, log);
  if (!accepted) return;
  const reload = await vscode.window.showInformationMessage(
    "Thank you — the Amicode EULA is accepted. Reload the window to finish activating Amicode?",
    "Reload Window",
    "Later",
  );
  if (reload === "Reload Window") {
    await vscode.commands.executeCommand("workbench.action.reloadWindow");
  }
}

/** Register `amicode.reviewEula`. Called in BOTH modes — in the full mode it
 *  re-opens the EULA for review; in the gate mode it is the only way back in. */
export function registerEulaCommand(ctx: vscode.ExtensionContext, log?: (line: string) => void): void {
  ctx.subscriptions.push(vscode.commands.registerCommand("amicode.reviewEula", () => void reviewEula(ctx, log)));
}

/** The inert surface for a declined/unaccepted install: the review command, a
 *  persistent status bar item, and a stub for the contributed `amicode.workspace`
 *  webview view so it renders a notice instead of VS Code's generic
 *  "no provider registered" error. */
export function registerEulaGateSurface(ctx: vscode.ExtensionContext, log?: (line: string) => void): void {
  registerEulaCommand(ctx, log);

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.text = "$(law) Amicode EULA";
  status.tooltip = "Amicode is disabled until you accept the End User License Agreement. Click to review.";
  status.command = "amicode.reviewEula";
  status.show();
  ctx.subscriptions.push(status);

  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "amicode.workspace",
      {
        resolveWebviewView(webviewView) {
          webviewView.webview.options = {
            enableCommandUris: true,
            // retain-exempt: static EULA notice — no SSE stream or session state to suspend when hidden
          };
          webviewView.webview.html = eulaGateHtml();
        },
      },
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );
}

/** The inert sidebar body. Command URI → amicode.reviewEula (requires the
 *  webview's enableCommandUris, set above). */
export function eulaGateHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Amicode — EULA required</title>
<style>
  body { font-family: var(--vscode-font-family, sans-serif); color: var(--vscode-foreground, #cccccc);
         background: var(--vscode-sideBar-background, transparent); padding: 1.25em 1.1em; line-height: 1.5; }
  h1 { font-size: 1.05em; margin: 0 0 .5em; font-weight: 600; }
  p { margin: .4em 0; }
  ul { margin: .6em 0 .8em; padding-left: 1.2em; }
  li { margin: .2em 0; }
  a.button { display: inline-block; margin: .6em 0 .8em; padding: .55em 1.15em; border-radius: 4px;
             background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #ffffff);
             text-decoration: none; font-weight: 500; }
  a.button:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
  footer { margin-top: 1em; padding-top: .6em; border-top: 1px solid var(--vscode-panel-border, #2b2b2b);
           font-size: .8em; opacity: .75; }
</style>
</head>
<body>
  <h1>Accept the EULA to activate Amicode</h1>
  <p>Amicode is inert until you read and accept the End User License Agreement bundled with the extension
     (<code>EULA.txt</code>, version ${EULA_DISPLAY_VERSION}).</p>
  <ul>
    <li>No server is spawned</li>
    <li>No chat, views, or commands are active</li>
  </ul>
  <p>Accepting takes one click and is remembered on this machine.</p>
  <a class="button" href="command:amicode.reviewEula">Review &amp; Accept EULA…</a>
  <footer>Amicode 0.4.0 · EULA ${EULA_DISPLAY_VERSION}</footer>
</body>
</html>`;
}
