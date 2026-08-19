// Onboarding Webview — browser-side entry point (#433)
//
// Runs inside the webview panel: plays the welcome animation, then reveals the
// model configuration form. Communicates with the host via postMessage.
//
// Contract:
//   window.__PROVIDERS__: Record<string, {id:string, name:string}[]>
//   host → webview: { type: "test-result", payload: { ok: boolean, error?: string } }
//   webview → host: { type: "test-connection", payload: OnboardingConfig }
//   webview → host: { type: "config-success", payload: OnboardingConfig }

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
declare global {
  interface Window {
    __PROVIDERS__: Record<string, { id: string; name: string }[]>;
  }
}

const vscodeApi = acquireVsCodeApi();
const providers = window.__PROVIDERS__;

// ─── Animation ───────────────────────────────────────────────────────────────

const animationEl = document.getElementById("animation")!;
const formEl = document.getElementById("form")!;

let animationPlayed = false;

function playWelcomeAnimation(): void {
  if (animationPlayed) {
    revealForm();
    return;
  }
  animationPlayed = true;

  // Brand animation: logo fade-in → hold → dissolve (~2.5s total)
  animationEl.innerHTML = `
    <div class="welcome-logo" style="opacity:0; transition: opacity 0.8s ease-in;">
      <svg width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="64" height="64" rx="12" fill="var(--vscode-button-background, #007acc)"/>
        <text x="32" y="42" font-size="28" font-weight="bold" text-anchor="middle" fill="white">A</text>
      </svg>
      <h1 style="margin-top: 16px; font-size: 1.5rem; opacity: 0; transition: opacity 0.6s ease-in 0.4s;">
        Welcome to Amicode
      </h1>
    </div>
  `;

  const logo = animationEl.querySelector(".welcome-logo") as HTMLElement;
  const heading = animationEl.querySelector("h1") as HTMLElement;

  // Fade in
  requestAnimationFrame(() => {
    logo.style.opacity = "1";
    heading.style.opacity = "1";
  });

  // After ~2.5s, dissolve and reveal form
  setTimeout(() => {
    animationEl.style.transition = "opacity 0.4s ease-out";
    animationEl.style.opacity = "0";
    setTimeout(() => {
      animationEl.style.display = "none";
      revealForm();
    }, 400);
  }, 2100);
}

// ─── Form ────────────────────────────────────────────────────────────────────

function revealForm(): void {
  formEl.classList.add("visible");
  buildForm();
}

function buildForm(): void {
  const providerOptions = Object.keys(providers)
    .map((p) => `<option value="${p}">${p}</option>`)
    .join("");

  formEl.innerHTML = `
    <div class="onboarding-form" style="max-width: 480px; margin: 0 auto; padding: 24px;">
      <h2 style="margin-bottom: 8px;">Configure your model</h2>
      <p style="color: var(--vscode-descriptionForeground); margin-bottom: 24px;">
        Choose a provider and enter your API key to get started.
      </p>

      <label for="provider-select" style="display:block; margin-bottom: 4px; font-weight: 500;">Provider</label>
      <select id="provider-select" style="width:100%; padding: 6px 8px; margin-bottom: 16px;
        background: var(--vscode-input-background); color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, #3c3c3c); border-radius: 4px;">
        <option value="">Select a provider…</option>
        ${providerOptions}
      </select>

      <label for="api-key-input" style="display:block; margin-bottom: 4px; font-weight: 500;">API Key</label>
      <input id="api-key-input" type="password" placeholder="Enter your API key"
        style="width:100%; padding: 6px 8px; margin-bottom: 16px; box-sizing: border-box;
        background: var(--vscode-input-background); color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, #3c3c3c); border-radius: 4px;" />

      <label for="model-select" style="display:block; margin-bottom: 4px; font-weight: 500;">Model</label>
      <select id="model-select" disabled
        style="width:100%; padding: 6px 8px; margin-bottom: 24px;
        background: var(--vscode-input-background); color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, #3c3c3c); border-radius: 4px;">
        <option value="">Select a provider first…</option>
      </select>

      <button id="test-btn" disabled
        style="width:100%; padding: 8px 16px; cursor: pointer;
        background: var(--vscode-button-background); color: var(--vscode-button-foreground);
        border: none; border-radius: 4px; font-size: 14px; font-weight: 500;">
        Test Connection
      </button>

      <div id="status-msg" style="margin-top: 12px; min-height: 20px; font-size: 13px;"></div>
    </div>
  `;

  // Wire up interactions
  const providerSelect = document.getElementById("provider-select") as HTMLSelectElement;
  const apiKeyInput = document.getElementById("api-key-input") as HTMLInputElement;
  const modelSelect = document.getElementById("model-select") as HTMLSelectElement;
  const testBtn = document.getElementById("test-btn") as HTMLButtonElement;
  const statusMsg = document.getElementById("status-msg") as HTMLDivElement;

  providerSelect.addEventListener("change", () => {
    const selected = providerSelect.value;
    const models = providers[selected] ?? [];
    modelSelect.innerHTML = models
      .map((m) => `<option value="${m.id}">${m.name}</option>`)
      .join("");
    modelSelect.disabled = models.length === 0;
    updateTestButton();
  });

  apiKeyInput.addEventListener("input", updateTestButton);
  modelSelect.addEventListener("change", updateTestButton);

  function updateTestButton(): void {
    const hasProvider = providerSelect.value !== "";
    const hasKey = apiKeyInput.value.trim() !== "";
    const hasModel = modelSelect.value !== "";
    testBtn.disabled = !(hasProvider && hasKey && hasModel);
  }

  testBtn.addEventListener("click", () => {
    if (testBtn.disabled) return;
    testBtn.disabled = true;
    testBtn.textContent = "Testing…";
    statusMsg.textContent = "";
    statusMsg.style.color = "";

    vscodeApi.postMessage({
      type: "test-connection",
      payload: {
        provider: providerSelect.value,
        model: modelSelect.value,
        apiKey: apiKeyInput.value,
      },
    });
  });

  // Listen for test results from host
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg?.type === "test-result") {
      const result = msg.payload as { ok: boolean; error?: string };
      if (result.ok) {
        statusMsg.textContent = "Connected successfully!";
        statusMsg.style.color = "var(--vscode-testing-iconPassed, #73c991)";
        // Notify host to write config and close
        setTimeout(() => {
          vscodeApi.postMessage({
            type: "config-success",
            payload: {
              provider: providerSelect.value,
              model: modelSelect.value,
              apiKey: apiKeyInput.value,
            },
          });
        }, 600); // Brief pause so user sees the success
      } else {
        statusMsg.textContent = `Connection failed: ${result.error ?? "Unknown error"}`;
        statusMsg.style.color = "var(--vscode-testing-iconFailed, #f14c4c)";
        testBtn.disabled = false;
        testBtn.textContent = "Test Connection";
      }
    }
  });
}

// ─── Boot ────────────────────────────────────────────────────────────────────

playWelcomeAnimation();
