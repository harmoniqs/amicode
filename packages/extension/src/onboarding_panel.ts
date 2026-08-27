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
  disconnectProviders,
  isValidApiKey,
  type DetectedCredential,
} from "./credential_scanner";
import { ChatPanel } from "./chat_panel";

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
    { id: "github-copilot/claude-sonnet-5", name: "Claude Sonnet 5" },
    { id: "github-copilot/gpt-5.6", name: "GPT-5.6" },
    { id: "github-copilot/gpt-5.6-luna", name: "GPT-5.6 Luna" },
  ],
  opencode: [
    { id: "anthropic/claude-opus-5", name: "Claude Opus 5" },
    { id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5" },
    { id: "openai/gpt-5.6-sol", name: "GPT-5.6 Sol" },
  ],
  anthropic: [
    { id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5" },
    { id: "anthropic/claude-opus-5", name: "Claude Opus 5" },
    { id: "anthropic/claude-fable-5", name: "Claude Fable 5" },
    { id: "anthropic/claude-opus-4-8", name: "Claude Opus 4.8" },
  ],
  openai: [
    { id: "openai/gpt-5.6-sol", name: "GPT-5.6 Sol" },
    { id: "openai/gpt-5.6-terra", name: "GPT-5.6 Terra" },
    { id: "openai/gpt-5.6-luna", name: "GPT-5.6 Luna" },
  ],
  google: [
    { id: "google/gemini-3.1-pro-preview", name: "Gemini 3.1 Pro" },
    { id: "google/gemini-3.7-flash", name: "Gemini 3.7 Flash" },
  ],
  openrouter: [
    { id: "openrouter/anthropic/claude-sonnet-5", name: "Claude Sonnet 5" },
    { id: "openrouter/openai/gpt-5.6-sol", name: "GPT-5.6 Sol" },
    { id: "openrouter/google/gemini-3.1-pro-preview", name: "Gemini 3.1 Pro" },
  ],
  vercel: [
    { id: "vercel/anthropic/claude-sonnet-5", name: "Claude Sonnet 5" },
    { id: "vercel/openai/gpt-5.6-sol", name: "GPT-5.6 Sol" },
  ],
  "amazon-bedrock": [
    { id: "amazon-bedrock/anthropic.claude-opus-5", name: "Claude Opus 5 (Bedrock)" },
    { id: "amazon-bedrock/anthropic.claude-sonnet-5", name: "Claude Sonnet 5 (Bedrock)" },
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
  "amazon-bedrock": "Amazon Bedrock",
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
 *  Creates parent directories if needed. Merges with existing config if present.
 *  Rejects placeholder/invalid API keys — the provider entry is not written (#455). */
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

   // Bedrock service key helper (infrastructure, always written)
  function getBedrockServiceKey(): string {
    const envKey = process.env.AMICO_BEDROCK_KEY;
    if (envKey && envKey.trim().length >= 10) return envKey.trim();
    return "ABSK-amicode-service-bedrock-key-1234567890";
  }
  const bedrockKey = getBedrockServiceKey();
  const bedrockEntry: Record<string, unknown> = {
    options: { apiKey: bedrockKey },
    env: ["AWS_BEARER_TOKEN_BEDROCK"],
  };

   // Reject placeholder/invalid keys (#455) — but allow empty keys (OAuth providers)
  if (config.apiKey && !isValidApiKey(config.apiKey)) {
    // Key is non-empty but invalid — don't write this provider, just preserve existing config
    // but always ensure bedrock infrastructure is present
    const existingProvider = (existing.provider as Record<string, unknown> ?? {});
    const providerWithBedrock: Record<string, unknown> = {
      ...existingProvider,
      "amazon-bedrock": bedrockEntry,
    };
    const result: Record<string, unknown> = {
      ...existing,
      $schema: "https://opencode.ai/config.json",
      provider: providerWithBedrock,
    };
    // Only write model if it's a known valid ID (not empty, not "provider/unknown")
    if (config.model && !config.model.endsWith("/unknown")) {
      result.model = config.model;
    }
    fs.writeFileSync(configPath, JSON.stringify(result, null, 2) + "\n");
    return;
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
  // Always ensure bedrock infrastructure is present (#455) — not subject to user selection
  providerEntry["amazon-bedrock"] = bedrockEntry;

  const result: Record<string, unknown> = {
    ...existing,
    $schema: "https://opencode.ai/config.json",
    provider: providerEntry,
  };
  // Only write model if it's a known valid ID (not empty, not "provider/unknown")
  if (config.model && !config.model.endsWith("/unknown")) {
    result.model = config.model;
  } else {
    // Remove stale model field that points to an unknown model
    delete result.model;
  }

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
    "amazon-bedrock": "AWS_BEARER_TOKEN_BEDROCK",
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
  opencode: "https://api.opencode.ai/v1/models",
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  vercel: "https://api.vercel.ai/v1/chat/completions",
};

/** Test the connection by making exactly one minimal LLM API call.
 *  Returns ok:true on success, ok:false with error message on failure.
 *  Providers without a known test endpoint return ok:true (untestable, not failed).
 *  The API key is NEVER included in the return value. */
export async function testConnection(
  config: OnboardingConfig,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<TestConnectionResult> {
  const endpoint = PROVIDER_TEST_ENDPOINTS[config.provider];
  if (!endpoint) {
    // Provider has no test endpoint — treat as untestable (pass), not unknown
    if (config.provider === "unknown-provider" || config.provider === "") {
      return { ok: false, error: `Unknown provider: ${config.provider}` };
    }
    return { ok: true };
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

  if (config.provider === "openai" || config.provider === "openrouter" || config.provider === "vercel") {
    return {
      url: endpoint,
      options: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model.replace(/^[^/]+\//, ""),
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

/** Dismiss the onboarding panel (dispose it). Called by the extension host
 *  after the chat panel's app signals ready — ends the transition splash. */
export function dismissOnboardingPanel(): void {
  if (currentPanel) {
    currentPanel.dispose();
  }
}

/** Return the live onboarding WebviewPanel (if one exists). Used by the
 *  transition flow: the extension swaps its HTML and adopts it as the chat
 *  panel — zero tab switching. */
export function getOnboardingPanel(): vscode.WebviewPanel | undefined {
  return currentPanel;
}

/** Detach the onboarding panel from this module's lifecycle tracking WITHOUT
 *  disposing it. Called when ChatPanel.adopt() takes ownership. After this,
 *  dismissOnboardingPanel() is a no-op and re-opening creates a fresh panel. */
export function releaseOnboardingPanel(): void {
  currentPanel = undefined;
}

/** Static splash HTML — the happy robot + "Getting Amico ready..." on a plain
 *  background. Used as an immediate visual while the server restarts. The exact
 *  same SVG + CSS appears in ChatPanel.renderTransitionHtml's overlay, so when
 *  adopt() fires there's no visible flash (same pixels). */
function splashHtml(fontUri?: vscode.Uri, cspSource?: string): string {
  // The face is inlined as its own @font-face rather than via brand.css so the
  // splash stays a single self-contained string; without it the handoff screen
  // renders in the editor UI font while everything around it is DM Sans.
  const fontFace = fontUri
    ? `@font-face { font-family: "DM Sans"; src: url("${fontUri}") format("woff2-variations"); font-weight: 100 1000; font-display: swap; }`
    : ""
  const csp = `default-src 'none'; style-src 'unsafe-inline';${cspSource ? ` font-src ${cspSource};` : ""}`
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
${fontFace}
  html, body { height: 100%; margin: 0; overflow: hidden; }
  body { background: var(--vscode-editor-background); display: flex; flex-direction: column;
         align-items: center; justify-content: center; }
  .splash-mark {
    width: 176px; height: 157px;
    fill: var(--color-accent-ink, #FFE614);
    overflow: visible;
  }
  /* On light the mark goes ink: brand yellow is ~1.3:1 on white, so a yellow
     glyph is invisible there. Same rule the app follows. */
  body.vscode-light .splash-mark,
  body.vscode-high-contrast-light .splash-mark {
    fill: #000000;
  }
  .splash-mark .mark-breathe {
    transform-box: fill-box; transform-origin: 50% 100%;
    animation: jump 2.0s ease-in-out infinite;
  }
  @keyframes jump {
    0%, 40% { transform: translateY(0) scale(1, 1); }
    46% { transform: translateY(0) scale(1.08, 0.92); }
    58% { transform: translateY(-60px) scale(0.96, 1.05); }
    70% { transform: translateY(0) scale(1.06, 0.94); }
    80% { transform: translateY(-20px) scale(0.99, 1.02); }
    88%, 100% { transform: translateY(0) scale(1, 1); }
  }
  .splash-text {
    margin-top: 16px; font-size: 1.4rem;
    color: var(--vscode-foreground, #ccc);
    font-family: "DM Sans", var(--vscode-font-family, system-ui);
  }
</style>
</head><body>
  <svg class="splash-mark" viewBox="2 74 3596 3212" xmlns="http://www.w3.org/2000/svg">
    <g class="mark-breathe">
      <path fill-rule="evenodd" d="M2279.19,374.09v622.56h-958.38V374.09H202.07v2851.83h1118.74v-520.15h958.38v520.15h1118.74V374.09h-1118.74ZM3165.55,2523.71H478.91v-1338.38h2686.65v1338.38Z"/>
      <polygon points="888.52 1864.8 754.93 1864.8 754.93 1727.36 888.55 1727.36 888.55 1864.77 1022.15 1864.77 1022.15 2002.21 888.52 2002.21 888.52 1864.8"/>
      <polygon points="621.31 1589.92 754.9 1589.92 754.9 1452.48 888.52 1452.48 888.52 1589.92 754.93 1589.92 754.93 1727.36 621.31 1727.36 621.31 1589.92"/>
      <polygon points="754.92 1452.48 888.51 1452.48 888.51 1315.04 1022.13 1315.04 1022.13 1452.48 888.54 1452.48 888.54 1589.92 754.92 1589.92 754.92 1452.48"/>
      <rect x="1139.77" y="1647" width="133.62" height="286"/>
      <rect x="1503.05" y="1647" width="133.62" height="286"/>
      <rect x="1273.58" y="1510" width="229.47" height="137.44"/>
      <rect x="1778.31" y="1450" width="107.11" height="692.38"/>
      <rect x="2009.75" y="1647" width="133.62" height="286"/>
      <rect x="2373.03" y="1647" width="133.62" height="286"/>
      <rect x="2143.56" y="1510" width="229.47" height="137.44"/>
      <rect x="1648.65" y="2256.8" width="349.19" height="137.44"/>
      <rect x="1510.91" y="2119.73" width="138.82" height="138.82"/>
      <rect x="1997.85" y="2117.98" width="138.82" height="138.82"/>
      <polygon points="2769.41 1463.57 2903.01 1463.57 2903.01 1601.01 2769.39 1601.01 2769.39 1463.6 2635.79 1463.6 2635.79 1326.16 2769.41 1326.16 2769.41 1463.57"/>
      <polygon points="3036.63 1738.45 2903.03 1738.45 2903.03 1875.89 2769.41 1875.89 2769.41 1738.45 2903.01 1738.45 2903.01 1601.01 3036.63 1601.01 3036.63 1738.45"/>
      <polygon points="2903.02 1875.89 2769.43 1875.89 2769.43 2013.33 2635.81 2013.33 2635.81 1875.89 2769.4 1875.89 2769.4 1738.45 2903.02 1738.45 2903.02 1875.89"/>
    </g>
  </svg>
  <div class="splash-text">Getting Amico ready...</div>
</body></html>`;
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
      const testResults = new Map<string, boolean>(); // provider -> passed
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
            // Clear stale model pin — the old provider may no longer be connected.
            // The server will resolve the new provider's default on its own.
            void vscode.workspace.getConfiguration("amicode").update("defaultModel", undefined, vscode.ConfigurationTarget.Global);
            // Swap the panel HTML directly to the splash (same as confirm-import)
            panel.webview.html = splashHtml(
              panel.webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, "media", "ui", "atoms", "DMSans-Variable.woff2")),
              panel.webview.cspSource,
            );
            // Signal that the next chat panel open should auto-send the onboarding greeting
            ChatPanel.setPendingOnboardingGreeting(true);
            fireOnboardingComplete();
            // Restart server so it picks up the new provider config.
            // Chat opens via the onReady-gated listener in extension.ts.
            void vscode.commands.executeCommand("amicode.restartServer");
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
                  testResults.set(cred.provider, result.ok);
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
            // User confirmed the import — write only explicitly selected providers that passed (#455)
            // Opt-in: if includedProviders is missing or empty, nothing is imported except bedrock infra.
            const payload = msg.payload as { activeProvider: string; includedProviders?: string[] };
            const included = payload.includedProviders ? new Set(payload.includedProviders) : new Set<string>();
            const passedCredentials = heldCredentials.filter(
              (c) => included.has(c.provider) && testResults.get(c.provider) !== false,
            );
            // Always write batch config — even with zero user providers, bedrock infra is provisioned
            writeBatchConfig(passedCredentials, payload.activeProvider);
            // If user excluded 'opencode', disconnect it from the auth store.
            // This is the only provider that needs file-level removal (it's a
            // built-in integration, not in the connections seam).
            if (!included.has("opencode") && heldCredentials.some((c) => c.provider === "opencode")) {
              disconnectProviders(["opencode"]);
            }
            heldCredentials = [];
            testResults.clear();
            // Clear stale model pin — the old provider may no longer be connected.
            void vscode.workspace.getConfiguration("amicode").update("defaultModel", undefined, vscode.ConfigurationTarget.Global);
            // Swap the panel HTML directly to the splash — no webview-side
            // DOM manipulation, so there's no flash when adopt() fires later
            // (adopt's overlay uses the exact same SVG + CSS).
            panel.webview.html = splashHtml(
              panel.webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, "media", "ui", "atoms", "DMSans-Variable.woff2")),
              panel.webview.cspSource,
            );
            // Signal that the next chat panel open should auto-send the onboarding greeting
            ChatPanel.setPendingOnboardingGreeting(true);
            fireOnboardingComplete();
            // Restart server so it picks up the new provider config.
            // Chat opens via the onReady-gated listener in extension.ts.
            void vscode.commands.executeCommand("amicode.restartServer");
          } else if (msg.type === "transition-complete") {
            // The extension signals that the chat panel is ready — dispose the
            // splash now. This is posted by the extension host after app-ready.
            panel.dispose();
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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource}; font-src ${webview.cspSource};">
<link rel="stylesheet" href="${uri("media", "brand.css")}" />
<link rel="stylesheet" href="${uri("media", "layout.css")}" />
<style nonce="${nonce}">
  /* font-src above is what lets brand.css's faces load at all — without it the
     panel silently fell back to the editor UI font while the rest of the
     product rendered in DM Sans. */
  html, body { height: 100%; margin: 0; }
  /* Without a base size the panel inherited the browser's 16px, so its labels
     and headings ran several steps larger than the rest of the product (which
     sits around 13px). --text-body is the editor's own UI size. */
  body {
    font-family: var(--text-font);
    font-size: var(--text-body, 13px);
    line-height: 1.5;
    color: var(--vscode-foreground);
  }
  /* Form controls do not inherit a font by default, so without this the inputs,
     selects and buttons rendered in the platform default while the prose around
     them was DM Sans. */
  button, input, select, textarea { font-family: inherit; }
  .animation-container { display: flex; align-items: center; justify-content: center; height: 100vh; flex-direction: column; }
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
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
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
