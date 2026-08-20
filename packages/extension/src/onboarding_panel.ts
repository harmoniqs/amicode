// OnboardingPanel — Stage 0: Model-setup webview (#433)
//
// A non-agentic webview that configures the user's LLM provider before chat can
// open. Plays a branded welcome animation, then presents a provider/key/model
// form with a "Test connection" button. On success: writes config, closes panel,
// fires an event for downstream wiring (Slice 2).
//
// Pattern: WebviewPanel host (catalog_card_shell.ts-style), singleton lifecycle.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as vscode from "vscode";

import {
  scanCredentials,
  defaultScanOptions,
  webviewSafeResults,
  writeBatchConfig,
  type DetectedCredential,
} from "./credential_scanner";

// ─── Provider → Model data (data-driven, not hard-coded conditionals) ────────

export interface ModelEntry {
  id: string;
  name: string;
}

/** Data-driven provider→model map. Each provider key is the opencode provider id;
 *  models are the provider/model-id pairs opencode expects in `config.model`.
 *  "github-copilot" uses OAuth (no key); "custom" uses a base URL + model text. */
export const PROVIDER_MODELS: Record<string, ModelEntry[]> = {
  "github-copilot": [
    { id: "github-copilot/claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
    { id: "github-copilot/gpt-4o", name: "GPT-4o" },
    { id: "github-copilot/o3-mini", name: "o3-mini" },
  ],
  opencode: [
    { id: "anthropic/claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
    { id: "anthropic/claude-opus-4-6", name: "Claude Opus 4.6" },
    { id: "openai/gpt-4.1", name: "GPT-4.1" },
  ],
  anthropic: [
    { id: "anthropic/claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
    { id: "anthropic/claude-opus-4-6", name: "Claude Opus 4.6" },
    { id: "anthropic/claude-haiku-4-5", name: "Claude Haiku 4.5" },
  ],
  openai: [
    { id: "openai/gpt-4.1", name: "GPT-4.1" },
    { id: "openai/gpt-4.1-mini", name: "GPT-4.1 Mini" },
    { id: "openai/o3-mini", name: "o3-mini" },
  ],
  google: [
    { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash" },
  ],
  openrouter: [
    { id: "openrouter/anthropic/claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
    { id: "openrouter/openai/gpt-4.1", name: "GPT-4.1" },
    { id: "openrouter/google/gemini-2.5-pro", name: "Gemini 2.5 Pro" },
  ],
  vercel: [
    { id: "vercel/anthropic/claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
    { id: "vercel/openai/gpt-4.1", name: "GPT-4.1" },
  ],
  custom: [],
};

/** Human-readable display names for the provider dropdown. */
export const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  "github-copilot": "GitHub Copilot (Free)",
  opencode: "OpenCode",
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  openrouter: "OpenRouter",
  vercel: "Vercel",
  custom: "Custom (OpenAI-compatible)",
};

// ─── Config types and writing ────────────────────────────────────────────────

export interface OnboardingConfig {
  provider: string;
  model: string;
  apiKey: string;
}

/** The default opencode config path — ~/.config/opencode/opencode.json */
function defaultConfigPath(): string {
  return path.join(os.homedir(), ".config", "opencode", "opencode.json");
}

/** Write the onboarding config to the opencode config file.
 *  Creates parent directories if needed. Merges with existing config if present. */
export function writeOnboardingConfig(
  config: OnboardingConfig,
  configPath: string = defaultConfigPath(),
): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });

  // Read existing config to merge (don't clobber user's other settings)
  let existing: Record<string, unknown> = {};
  try {
    if (fs.existsSync(configPath)) {
      existing = JSON.parse(fs.readFileSync(configPath, "utf8"));
    }
  } catch {
    // If parsing fails, start fresh
  }

  // Provider-specific key env var name
  const envVarName = providerKeyEnvVar(config.provider);

  // Build the provider entry per opencode schema:
  //   provider.<name>.options.apiKey  (NOT provider.<name>.apiKey)
  //   provider.<name>.env = string[]  (NOT a bare string)
  const providerConfig: Record<string, unknown> = {};
  if (config.apiKey) {
    providerConfig.options = { apiKey: config.apiKey };
  }
  if (envVarName) {
    providerConfig.env = [envVarName];
  }

  const providerEntry: Record<string, unknown> = {
    ...(existing.provider as Record<string, unknown> ?? {}),
    [config.provider]: providerConfig,
  };

  const result = {
    ...existing,
    $schema: "https://opencode.ai/config.json",
    provider: providerEntry,
    model: config.model,
  };

  fs.writeFileSync(configPath, JSON.stringify(result, null, 2) + "\n");
}

/** Map provider id to the conventional env var name for its API key. */
function providerKeyEnvVar(provider: string): string | undefined {
  const map: Record<string, string> = {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    google: "GOOGLE_API_KEY",
    opencode: "OPENCODE_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
  };
  return map[provider];
}

// ─── Test connection ─────────────────────────────────────────────────────────

export interface TestConnectionResult {
  ok: boolean;
  error?: string;
}

/** Provider-specific API endpoints for testing a connection. */
const PROVIDER_TEST_ENDPOINTS: Record<string, string> = {
  anthropic: "https://api.anthropic.com/v1/messages",
  openai: "https://api.openai.com/v1/chat/completions",
  google: "https://generativelanguage.googleapis.com/v1beta/models",
  opencode: "https://opencode.ai/api/v1/chat/completions",
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  vercel: "https://api.vercel.ai/v1/chat/completions",
};

/** Test the connection by making exactly one minimal LLM API call.
 *  Returns ok:true on success, ok:false with error message on failure.
 *  The API key is NEVER included in the return value. */
export async function testConnection(
  config: OnboardingConfig,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<TestConnectionResult> {
  const endpoint = PROVIDER_TEST_ENDPOINTS[config.provider];
  if (!endpoint) {
    return { ok: false, error: `Unknown provider: ${config.provider}` };
  }

  try {
    const { url, options } = buildTestRequest(config, endpoint);
    const response = await fetchImpl(url, options);

    if (!response.ok) {
      return {
        ok: false,
        error: `${response.status} ${response.statusText ?? "Error"}`,
      };
    }
    return { ok: true };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

/** Build provider-specific test request. Minimal payload — just enough to validate creds. */
function buildTestRequest(
  config: OnboardingConfig,
  endpoint: string,
): { url: string; options: RequestInit } {
  if (config.provider === "anthropic") {
    return {
      url: endpoint,
      options: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": config.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: config.model.replace("anthropic/", ""),
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
      },
    };
  }

  if (config.provider === "openai") {
    return {
      url: endpoint,
      options: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model.replace("openai/", ""),
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
      },
    };
  }

  // Generic fallback — just test auth with a GET or minimal POST
  return {
    url: endpoint,
    options: {
      method: "GET",
      headers: { Authorization: `Bearer ${config.apiKey}` },
    },
  };
}

// ─── Event emitter for onboarding completion ─────────────────────────────────

type OnCompleteListener = () => void;
const completionListeners: OnCompleteListener[] = [];
const cancelListeners: OnCompleteListener[] = [];

/** Register a listener for when onboarding completes successfully.
 *  Downstream wiring (Slice 2) observes this to auto-open chat. */
export function onOnboardingComplete(listener: OnCompleteListener): vscode.Disposable {
  completionListeners.push(listener);
  return new vscode.Disposable(() => {
    const idx = completionListeners.indexOf(listener);
    if (idx >= 0) completionListeners.splice(idx, 1);
  });
}

/** Register a listener for when onboarding is cancelled (X button).
 *  Downstream opens chat normally (skip onboarding). */
export function onOnboardingCancelled(listener: OnCompleteListener): vscode.Disposable {
  cancelListeners.push(listener);
  return new vscode.Disposable(() => {
    const idx = cancelListeners.indexOf(listener);
    if (idx >= 0) cancelListeners.splice(idx, 1);
  });
}

function fireOnboardingComplete(): void {
  for (const listener of completionListeners) {
    try {
      listener();
    } catch {
      // Don't let a listener failure crash the flow
    }
  }
}

function fireOnboardingCancelled(): void {
  for (const listener of cancelListeners) {
    try {
      listener();
    } catch {
      // Don't let a listener failure crash the flow
    }
  }
}

// ─── WebviewPanel host ───────────────────────────────────────────────────────

let currentPanel: vscode.WebviewPanel | undefined;

/** Reset the singleton state. Exported for tests only. */
export function _resetForTesting(): void {
  if (currentPanel) {
    currentPanel.dispose();
  }
  currentPanel = undefined;
}

/** Register the onboarding panel command. Call from extension.ts activate(). */
export function registerOnboardingPanel(ctx: vscode.ExtensionContext): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("amicode.onboarding.open", () => {
      if (currentPanel) {
        currentPanel.reveal(vscode.ViewColumn.One);
        return;
      }

      const panel = vscode.window.createWebviewPanel(
        "amicode.onboarding",
        "Welcome to Amicode",
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          localResourceRoots: [
            vscode.Uri.joinPath(ctx.extensionUri, "dist"),
            vscode.Uri.joinPath(ctx.extensionUri, "media"),
          ],
        },
      );
      currentPanel = panel;

      // Handle messages from the webview
      let heldCredentials: DetectedCredential[] = [];
      let scanAborted = false;

      panel.webview.onDidReceiveMessage(
        async (msg: { type: string; payload?: unknown }) => {
          if (msg.type === "test-connection") {
            const payload = msg.payload as OnboardingConfig;
            const result = await testConnection(payload);
            panel.webview.postMessage({ type: "test-result", payload: result });
          } else if (msg.type === "config-success") {
            const payload = msg.payload as OnboardingConfig;
            writeOnboardingConfig(payload);
            panel.dispose();
            fireOnboardingComplete();
          } else if (msg.type === "cancel") {
            // User cancelled onboarding — close panel, re-open chat
            panel.dispose();
            fireOnboardingCancelled();
            // Also directly open chat as fallback (in case no listener is wired)
            void vscode.commands.executeCommand("amicode.openChat");
          } else if (msg.type === "scan-credentials") {
            // Auto-import: scan for existing credentials
            scanAborted = false;
            heldCredentials = [];
            panel.webview.postMessage({
              type: "scan-status",
              payload: { state: "searching" },
            });

            try {
              const scanResult = await scanCredentials(defaultScanOptions());
              if (scanAborted) return; // Panel was closed mid-scan
              heldCredentials = scanResult.credentials;

              if (heldCredentials.length === 0) {
                panel.webview.postMessage({
                  type: "scan-status",
                  payload: { state: "empty" },
                });
              } else {
                panel.webview.postMessage({
                  type: "scan-status",
                  payload: { state: "found", count: heldCredentials.length },
                });
                // Send webview-safe results (no key material)
                panel.webview.postMessage({
                  type: "scan-results",
                  payload: { providers: webviewSafeResults(heldCredentials) },
                });

                // Run connection tests in parallel (AC12)
                const testPromises = heldCredentials.map(async (cred) => {
                  const models = PROVIDER_MODELS[cred.provider];
                  const model = models?.[0]?.id ?? `${cred.provider}/unknown`;
                  const result = await testConnection({
                    provider: cred.provider,
                    model,
                    apiKey: cred.key,
                  });
                  if (!scanAborted) {
                    panel.webview.postMessage({
                      type: "test-status-update",
                      payload: { provider: cred.provider, ok: result.ok, error: result.error },
                    });
                  }
                });
                // Fire all tests in parallel, don't await sequentially
                void Promise.allSettled(testPromises);
              }
            } catch {
              if (!scanAborted) {
                panel.webview.postMessage({
                  type: "scan-status",
                  payload: { state: "failed", error: "Scan failed unexpectedly" },
                });
              }
            }
          } else if (msg.type === "confirm-import") {
            // User confirmed the import — write batch config
            const payload = msg.payload as { activeProvider: string };
            if (heldCredentials.length > 0) {
              writeBatchConfig(heldCredentials, payload.activeProvider);
            }
            heldCredentials = [];
            panel.dispose();
            fireOnboardingComplete();
          }
        },
        null,
        ctx.subscriptions,
      );

      // On panel close, abort scan and drop credentials (AC13, AC14)
      panel.onDidDispose(
        () => {
          scanAborted = true;
          heldCredentials = [];
          currentPanel = undefined;
        },
        null,
        ctx.subscriptions,
      );

      // Render the webview HTML
      const uri = (...p: string[]) =>
        panel.webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, ...p));
      const nonce = Math.random().toString(36).slice(2);

      panel.webview.html = buildWebviewHtml(panel.webview, uri, nonce);
    }),
  );
}

/** Build the webview HTML with CSP, brand CSS, animation container, and injected data. */
function buildWebviewHtml(
  webview: vscode.Webview,
  uri: (...p: string[]) => vscode.Uri,
  nonce: string,
): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource};">
<link rel="stylesheet" href="${uri("media", "brand.css")}" />
<link rel="stylesheet" href="${uri("media", "layout.css")}" />
<style nonce="${nonce}">
  html, body { height: 100%; margin: 0; }
  .animation-container { display: flex; align-items: center; justify-content: center; height: 100vh; }
  .form-container { display: none; }
  .form-container.visible { display: block; height: 100vh; }
  .cancel-btn {
    position: fixed; top: 12px; right: 12px; z-index: 100;
    width: 28px; height: 28px; border: none; border-radius: 4px;
    background: transparent; color: var(--vscode-foreground, #ccc);
    font-size: 18px; cursor: pointer; display: flex; align-items: center; justify-content: center;
    opacity: 0.6; transition: opacity 0.15s;
  }
  .cancel-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.1)); }
</style>
</head><body>
<button id="cancel-btn" class="cancel-btn" title="Skip onboarding">&times;</button>
<div id="animation" class="animation-container"></div>
<div id="form" class="form-container"></div>
<script nonce="${nonce}">
window.__PROVIDERS__ = ${JSON.stringify(PROVIDER_MODELS)};
window.__PROVIDER_NAMES__ = ${JSON.stringify(PROVIDER_DISPLAY_NAMES)};
</script>
<script nonce="${nonce}" src="${uri("dist", "onboarding_webview.js")}"></script>
</body></html>`;
}
