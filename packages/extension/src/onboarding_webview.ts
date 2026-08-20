// Onboarding Webview — browser-side entry point (#433)
//
// Runs inside the webview panel: plays the welcome animation, then reveals the
// model configuration form. Communicates with the host via postMessage.
//
// Contract:
//   window.__PROVIDERS__: Record<string, {id:string, name:string}[]>
//   window.__PROVIDER_NAMES__: Record<string, string>
//   host → webview: { type: "test-result", payload: { ok: boolean, error?: string } }
//   webview → host: { type: "test-connection", payload: OnboardingConfig }
//   webview → host: { type: "config-success", payload: OnboardingConfig }

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

export {};

declare global {
  interface Window {
    __PROVIDERS__: Record<string, { id: string; name: string }[]>;
    __PROVIDER_NAMES__: Record<string, string>;
  }
}

const vscodeApi = acquireVsCodeApi();
const providers = window.__PROVIDERS__;
const providerNames = window.__PROVIDER_NAMES__ ?? {};

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

  // Brand animation: Amico drops in whole, bounces onto his feet, then idles
  // — breathing, springing, blinking, and winking at you on a loop.
  //
  // Geometry is the DETAILED mark (amicode media/amico.svg, mirrored as
  // MarkDetailed in the fork's logo.tsx) — correct here because the brand rule
  // is "small -> reduced bracket, large -> detailed". The rotate(-180)
  // transforms in the source SVG are Illustrator no-ops and are dropped so each
  // glyph can be grouped and animated. viewBox is cropped to the glyph's own
  // bounds plus room for the tilt and bob.
  //
  // Colour follows media/brand.css, NOT the app design system — VS Code webviews
  // are their own stack. The mark takes the INK role (--color-accent-ink): lemon
  // on dark, neutral theme foreground on light. Yellow is never a foreground on
  // a light ground, and every mark the extension ships already resolves this way.
  //
  // Every animated property sits on its own nested group so nothing fights over
  // the transform property: breathe wraps jump wraps enter, and each eye owns
  // only its own lid. The lean sits on its own group too, synced to the winks.
  animationEl.innerHTML = `
    <style>
      /* The mark is a GLYPH, so it takes the ink role, not the fill role:
         --color-accent-ink is lemon on dark and the neutral theme foreground on
         light (brand_accent.ts resolves it; brand_accent.test.ts pins it). That
         matches every mark the extension already ships — amico-face/hero/tab and
         the wordmark are all #CCCCCC on dark, #424242 on light, never lemon on a
         light ground. The lemon FILL role stays where it belongs: the CTA below. */
      .amico-mark {
        fill: var(--color-accent-ink, #fff676);
        overflow: visible;
      }
      /* Fallback for when brand_accent.ts has not resolved the theme. #424242 is
         the value the shipped light-theme marks use. */
      body.vscode-light .amico-mark,
      body.vscode-high-contrast-light .amico-mark {
        fill: var(--color-accent-ink, var(--vscode-foreground, #424242));
      }

      /* Squash and stretch pivots on the feet, so Amico compresses onto the
         ground rather than shrinking through his own middle. Blink and smile
         are the exceptions — those pivot on themselves. */
      .amico-mark .mark-breathe,
      .amico-mark .mark-jump,
      .amico-mark .mark-tilt,
      .amico-mark .mark-enter {
        transform-box: fill-box;
        transform-origin: 50% 100%;
      }
      .amico-mark .eye-ring,
      .amico-mark .eye-lid {
        transform-box: fill-box;
        transform-origin: center;
      }
      /* The lid animation is delayed, and a delayed animation does not paint
         its first keyframe. Without this the eyes would be shut for the whole
         entrance and snap open at 0.90s. */
      .amico-mark .eye-lid { opacity: 0; }

      /* 0.00s — Amico fades in at constant size. No drop, no bounce,
         no scale — just appears. The button fades in after. */
      @keyframes amico-enter {
        0% { opacity: 0; }
        100% { opacity: 1; transform: translateY(0) scale(1, 1); }
      }

      /* 0.90s — the eye cycle, 7s long and choreographed rather than looped:
             3%  wink   (right eye, lands the instant he touches down)
            30%  blink  (both, doubled)
            55%  wink   (right eye)
            78%  blink  (both, single)
         The eyes need separate keyframes now — a wink is one eye shut while the
         other stays open, so they can't share one animation with an offset.

         Scaling the hollow eye only thins the ring; the two bars never meet,
         which is why a pure scale reads as a pulse. So the ring collapses onto
         its centre line and a solid lid bar — 137.44, the same weight as every
         other bar in the mark — covers it completely.

         Timing is what separates the two: a blink shuts in 91ms and opens over
         210ms; a wink shuts just as fast but HOLDS for 259ms before opening.
         The hold is the whole trick — it's what makes it read as deliberate
         rather than involuntary. Both are fast to close and slow to open;
         a symmetrical eye never looks alive. */
      @keyframes amico-eye-r {
        0%, 3%      { transform: scaleY(1); animation-timing-function: cubic-bezier(0.45, 0, 0.9, 0.5); }
        4.3%        { transform: scaleY(0.1); }
        8.0%        { transform: scaleY(0.1); animation-timing-function: cubic-bezier(0.1, 0.6, 0.4, 1); }
        10.7%, 30%  { transform: scaleY(1); animation-timing-function: cubic-bezier(0.45, 0, 0.9, 0.5); }
        31.3%       { transform: scaleY(0.1); }
        32.2%       { transform: scaleY(0.1); animation-timing-function: cubic-bezier(0.1, 0.6, 0.4, 1); }
        35.2%, 37%  { transform: scaleY(1); animation-timing-function: cubic-bezier(0.45, 0, 0.9, 0.5); }
        38.3%       { transform: scaleY(0.1); }
        39.2%       { transform: scaleY(0.1); animation-timing-function: cubic-bezier(0.1, 0.6, 0.4, 1); }
        42.2%, 55%  { transform: scaleY(1); animation-timing-function: cubic-bezier(0.45, 0, 0.9, 0.5); }
        56.3%       { transform: scaleY(0.1); }
        60.0%       { transform: scaleY(0.1); animation-timing-function: cubic-bezier(0.1, 0.6, 0.4, 1); }
        62.7%, 78%  { transform: scaleY(1); animation-timing-function: cubic-bezier(0.45, 0, 0.9, 0.5); }
        79.3%       { transform: scaleY(0.1); }
        80.2%       { transform: scaleY(0.1); animation-timing-function: cubic-bezier(0.1, 0.6, 0.4, 1); }
        83.2%, 100% { transform: scaleY(1); }
      }
      /* The left eye sits out both winks — that is the entire point. */
      @keyframes amico-eye-l {
        0%, 30%     { transform: scaleY(1); animation-timing-function: cubic-bezier(0.45, 0, 0.9, 0.5); }
        31.3%       { transform: scaleY(0.1); }
        32.2%       { transform: scaleY(0.1); animation-timing-function: cubic-bezier(0.1, 0.6, 0.4, 1); }
        35.2%, 37%  { transform: scaleY(1); animation-timing-function: cubic-bezier(0.45, 0, 0.9, 0.5); }
        38.3%       { transform: scaleY(0.1); }
        39.2%       { transform: scaleY(0.1); animation-timing-function: cubic-bezier(0.1, 0.6, 0.4, 1); }
        42.2%, 78%  { transform: scaleY(1); animation-timing-function: cubic-bezier(0.45, 0, 0.9, 0.5); }
        79.3%       { transform: scaleY(0.1); }
        80.2%       { transform: scaleY(0.1); animation-timing-function: cubic-bezier(0.1, 0.6, 0.4, 1); }
        83.2%, 100% { transform: scaleY(1); }
      }
      /* Lids run on steps(1, end) — they hold, then jump. A cross-fading lid
         reads as a smudge. Each lands as its ring finishes closing and clears
         about a third of the way back open. */
      @keyframes amico-lid-r {
        0%    { opacity: 0; }
        4.3%  { opacity: 1; }
        9.0%  { opacity: 0; }
        31.3% { opacity: 1; }
        33.3% { opacity: 0; }
        38.3% { opacity: 1; }
        40.3% { opacity: 0; }
        56.3% { opacity: 1; }
        61.0% { opacity: 0; }
        79.3% { opacity: 1; }
        81.3% { opacity: 0; }
        100%  { opacity: 0; }
      }
      @keyframes amico-lid-l {
        0%    { opacity: 0; }
        31.3% { opacity: 1; }
        33.3% { opacity: 0; }
        38.3% { opacity: 1; }
        40.3% { opacity: 0; }
        79.3% { opacity: 1; }
        81.3% { opacity: 0; }
        100%  { opacity: 0; }
      }
      /* He leans into each wink, toward the eye that closes. The lean is what
         turns a wink into a flirt — without it you just have a slow blink. */
      @keyframes amico-tilt {
        0%, 2%     { transform: rotate(0deg); }
        5%, 9.5%   { transform: rotate(3.5deg); }
        14%, 53%   { transform: rotate(0deg); }
        57%, 61.5% { transform: rotate(3.5deg); }
        66%, 100%  { transform: rotate(0deg); }
      }


      /* 1.50s — the idle loop: crouch, spring, land, small rebound, then rest.
         The rest is what keeps it charming instead of frantic — he is still
         for the first 40% of every cycle. */
      @keyframes amico-jump {
        0%,  40%  { transform: translateY(0) scale(1, 1);
                    animation-timing-function: cubic-bezier(0.4, 0, 1, 1); }
        46%       { transform: translateY(0) scale(1.10, 0.90);
                    animation-timing-function: cubic-bezier(0, 0, 0.3, 1); }
        58%       { transform: translateY(-170px) scale(0.95, 1.07);
                    animation-timing-function: cubic-bezier(0.4, 0, 1, 1); }
        70%       { transform: translateY(0) scale(1.09, 0.91);
                    animation-timing-function: cubic-bezier(0, 0, 0.3, 1); }
        80%       { transform: translateY(-45px) scale(0.99, 1.02);
                    animation-timing-function: cubic-bezier(0.4, 0, 1, 1); }
        88%, 100% { transform: translateY(0) scale(1, 1); }
      }

      /* 1.40s — breathing, on its own group and its own period so it drifts
         against the jump instead of beating with it. Deliberately almost
         invisible; you should feel it, not see it. */
      @keyframes amico-breathe {
        0%, 100% { transform: scale(1, 1); }
        50%      { transform: scale(0.992, 1.014); }
      }

      @keyframes amico-rise {
        from { opacity: 0; }
        to   { opacity: 1; }
      }
      @keyframes amico-fade-in {
        from { opacity: 0; }
        to   { opacity: 1; }
      }

      .amico-mark .mark-enter   { animation: amico-enter   1.10s both; }
      .amico-mark .left-eye  .eye-ring { animation: amico-eye-l 7s linear         0.90s infinite; }
      .amico-mark .right-eye .eye-ring { animation: amico-eye-r 7s linear         0.90s infinite; }
      .amico-mark .left-eye  .eye-lid  { animation: amico-lid-l 7s steps(1, end)  0.90s infinite; }
      .amico-mark .right-eye .eye-lid  { animation: amico-lid-r 7s steps(1, end)  0.90s infinite; }
      .amico-mark .mark-tilt           { animation: amico-tilt  7s ease-in-out    0.90s infinite; }
      .amico-mark .mark-breathe { animation: amico-breathe   4.5s ease-in-out 1.40s infinite; }
      .amico-mark .mark-jump    { animation: amico-jump      2.8s 1.50s infinite; }
      .welcome-text             { animation: amico-rise     0.55s ease-out 1.55s both; }

      /* Get Started — brand.css CTA: lemon fill, black ink, 1px black edge.
         States are colour-only; a transform here would move the target. */
      .welcome-cta:hover { filter: brightness(0.94); }
      .welcome-cta:active { filter: brightness(0.88); }
      .welcome-cta:focus-visible {
        outline: 2px solid var(--vscode-focusBorder, var(--color-on-accent, #000));
        outline-offset: 2px;
      }
      .welcome-cta:disabled { opacity: 0.5; cursor: default; }

      @media (prefers-reduced-motion: reduce) {
        .amico-mark .mark-enter,
        .welcome-text {
          animation: amico-fade-in 0.4s ease-out both;
        }
        .amico-mark .mark-breathe,
        .amico-mark .mark-jump,
        .amico-mark .mark-tilt,
        .amico-mark .eye-ring { animation: none; }
        .amico-mark .eye-lid { display: none; }
      }
    </style>
    <div class="welcome-logo" style="opacity:0; transition: opacity 0.8s ease-in; text-align: center;">
      <svg class="amico-mark" width="176" height="157" viewBox="2 74 3596 3212" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Amico">
        <g class="mark-breathe"><g class="mark-jump"><g class="mark-tilt"><g class="mark-enter">
          <!-- Outer bracket; evenodd knocks out the screen -->
          <path class="frame" fill-rule="evenodd" d="M2279.19,374.09v622.56h-958.38V374.09H202.07v2851.83h1118.74v-520.15h958.38v520.15h1118.74V374.09h-1118.74ZM3165.55,2523.71H478.91v-1338.38h2686.65v1338.38Z"/>
          <!-- Left angle bracket < -->
          <g class="caret caret-l">
            <polygon points="888.52 1864.8 754.93 1864.8 754.93 1727.36 888.55 1727.36 888.55 1864.77 1022.15 1864.77 1022.15 2002.21 888.52 2002.21 888.52 1864.8"/>
            <polygon points="621.31 1589.92 754.9 1589.92 754.9 1452.48 888.52 1452.48 888.52 1589.92 754.93 1589.92 754.93 1727.36 621.31 1727.36 621.31 1589.92"/>
            <polygon points="754.92 1452.48 888.51 1452.48 888.51 1315.04 1022.13 1315.04 1022.13 1452.48 888.54 1452.48 888.54 1589.92 754.92 1589.92 754.92 1452.48"/>
          </g>
          <!-- Left eye (hollow square) -->
          <g class="eye left-eye">
            <g class="eye-ring">
              <rect x="1503.05" y="1446.71" width="133.62" height="423.84"/>
              <rect x="1139.77" y="1446.71" width="133.62" height="423.84"/>
              <rect x="1273.58" y="1309.27" width="229.47" height="137.44"/>
              <rect x="1273.58" y="1870.54" width="229.47" height="137.44"/>
            </g>
            <rect class="eye-lid" x="1139.77" y="1589.91" width="496.90" height="137.44"/>
          </g>
          <!-- Centre divider | -->
          <rect class="divider" x="1778.31" y="1312.43" width="107.11" height="692.38"/>
          <!-- Right eye (hollow square) -->
          <g class="eye right-eye">
            <g class="eye-ring">
              <rect x="2373.03" y="1451.19" width="133.62" height="423.84"/>
              <rect x="2009.75" y="1451.19" width="133.62" height="423.84"/>
              <rect x="2143.56" y="1313.76" width="229.47" height="137.44"/>
              <rect x="2143.56" y="1875.03" width="229.47" height="137.44"/>
            </g>
            <rect class="eye-lid" x="2009.75" y="1594.40" width="496.90" height="137.44"/>
          </g>
          <!-- Right angle bracket > -->
          <g class="caret caret-r">
            <polygon points="2769.41 1463.57 2903.01 1463.57 2903.01 1601.01 2769.39 1601.01 2769.39 1463.6 2635.79 1463.6 2635.79 1326.16 2769.41 1326.16 2769.41 1463.57"/>
            <polygon points="3036.63 1738.45 2903.03 1738.45 2903.03 1875.89 2769.41 1875.89 2769.41 1738.45 2903.01 1738.45 2903.01 1601.01 3036.63 1601.01 3036.63 1738.45"/>
            <polygon points="2903.02 1875.89 2769.43 1875.89 2769.43 2013.33 2635.81 2013.33 2635.81 1875.89 2769.4 1875.89 2769.4 1738.45 2903.02 1738.45 2903.02 1875.89"/>
          </g>
          <!-- Smile -->
          <g class="smile">
            <rect x="1648.65" y="2256.8" width="349.19" height="137.44"/>
            <rect x="1510.91" y="2119.73" width="138.82" height="138.82"/>
            <rect x="1997.85" y="2117.98" width="138.82" height="138.82"/>
          </g>
        </g></g></g></g>
      </svg>
      <p class="welcome-text" style="margin-top: 16px; font-size: 1.4rem; color: var(--vscode-foreground, #ccc);">
        Welcome to Amicode
      </p>
      <button class="welcome-cta" style="margin-top: 40px; padding: 10px 32px;
        font-family: var(--text-font, inherit); font-size: 14px; font-weight: 500;
        background: var(--color-accent-fill, #fff676); color: var(--color-on-accent, #000);
        border: var(--border-width, 1px) solid var(--color-on-accent, #000);
        border-radius: var(--border-radius, 4px);
        cursor: pointer; opacity: 0; visibility: hidden; transition: opacity 2s ease-in, filter 0.16s ease;">
        Get Started
      </button>
    </div>
  `;

  const logo = animationEl.querySelector(".welcome-logo") as HTMLElement;

  // Reveal the stage; every beat inside it is driven by CSS.
  requestAnimationFrame(() => {
    logo.style.opacity = "1";
  });

  // Show "Get Started" button after text fades in, user clicks to proceed
  setTimeout(() => {
    const btn = logo.querySelector(".welcome-cta") as HTMLButtonElement;
    if (!btn) return;
    btn.style.visibility = "visible";
    requestAnimationFrame(() => { btn.style.opacity = "1"; });

    btn.addEventListener("click", () => {
      animationEl.style.transition = "opacity 0.4s ease-out";
      animationEl.style.opacity = "0";
      setTimeout(() => {
        animationEl.style.display = "none";
        revealForm();
      }, 400);
    });
  }, 3000);
}

// ─── Form ────────────────────────────────────────────────────────────────────

function revealForm(): void {
  formEl.classList.add("visible");
  buildForm();
}

function buildForm(): void {
  const providerOptions = Object.keys(providers)
    .map((p) => `<option value="${p}">${providerNames[p] ?? p}</option>`)
    .join("");

  const inputStyle = `width:100%; padding: 6px 8px; margin-bottom: 16px; box-sizing: border-box;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, #3c3c3c); border-radius: 4px;`;

  formEl.innerHTML = `
    <div class="onboarding-form" style="max-width: 480px; margin: 0 auto; padding: 24px;
      display: flex; flex-direction: column; justify-content: center; min-height: 100vh;">
      <h2 style="margin-bottom: 8px;">Configure your model</h2>
      <p style="color: var(--vscode-descriptionForeground); margin-bottom: 24px;">
        Choose a provider and enter your API key to get started.
      </p>

      <label for="provider-select" style="display:block; margin-bottom: 4px; font-weight: 500;">Provider</label>
      <select id="provider-select" style="${inputStyle}">
        <option value="">Select a provider…</option>
        ${providerOptions}
      </select>

      <div id="provider-hint" style="margin-top: -12px; margin-bottom: 12px; font-size: 12px;
        color: var(--vscode-descriptionForeground); display: none;"></div>

      <div id="api-key-row">
        <label for="api-key-input" style="display:block; margin-bottom: 4px; font-weight: 500;">API Key</label>
        <input id="api-key-input" type="password" placeholder="Enter your API key"
          style="${inputStyle}" />
      </div>

      <div id="base-url-row" style="display: none;">
        <label for="base-url-input" style="display:block; margin-bottom: 4px; font-weight: 500;">Base URL</label>
        <input id="base-url-input" type="text" placeholder="https://api.example.com/v1"
          style="${inputStyle}" />
      </div>

      <div id="model-select-row">
        <label for="model-select" style="display:block; margin-bottom: 4px; font-weight: 500;">Model</label>
        <select id="model-select" disabled style="${inputStyle} margin-bottom: 24px;">
          <option value="">Select a provider first…</option>
        </select>
      </div>

      <div id="model-input-row" style="display: none;">
        <label for="model-input" style="display:block; margin-bottom: 4px; font-weight: 500;">Model ID</label>
        <input id="model-input" type="text" placeholder="e.g. llama3.3, deepseek-chat, mistral-large-latest"
          style="${inputStyle} margin-bottom: 24px;" />
      </div>

      <button id="test-btn" disabled
        style="width:100%; padding: 10px 16px; cursor: pointer;
        background: #fff676; color: #111;
        border: none; border-radius: 6px; font-size: 14px; font-weight: 500;">
        Test Connection
      </button>

      <div id="status-msg" style="margin-top: 12px; min-height: 20px; font-size: 13px;"></div>

      <div id="import-section" style="margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--vscode-input-border, #3c3c3c); text-align: center;">
        <a id="import-link" href="#" style="font-size: 13px; color: var(--vscode-textLink-foreground, #3794ff); text-decoration: none;">
          Import existing credentials
        </a>
        <div id="import-status" style="display: none; margin-top: 12px;"></div>
        <div id="import-preview" style="display: none; margin-top: 16px; text-align: left;"></div>
      </div>
    </div>
  `;

  // Element refs
  const providerSelect = document.getElementById("provider-select") as HTMLSelectElement;
  const providerHint = document.getElementById("provider-hint") as HTMLDivElement;
  const apiKeyRow = document.getElementById("api-key-row") as HTMLDivElement;
  const apiKeyInput = document.getElementById("api-key-input") as HTMLInputElement;
  const baseUrlRow = document.getElementById("base-url-row") as HTMLDivElement;
  const baseUrlInput = document.getElementById("base-url-input") as HTMLInputElement;
  const modelSelectRow = document.getElementById("model-select-row") as HTMLDivElement;
  const modelSelect = document.getElementById("model-select") as HTMLSelectElement;
  const modelInputRow = document.getElementById("model-input-row") as HTMLDivElement;
  const modelInput = document.getElementById("model-input") as HTMLInputElement;
  const testBtn = document.getElementById("test-btn") as HTMLButtonElement;
  const statusMsg = document.getElementById("status-msg") as HTMLDivElement;

  // Per-provider hints
  const hints: Record<string, string> = {
    anthropic: "Requires API access from console.anthropic.com (not included in Claude Max)",
    openai: "Requires API key from platform.openai.com (not included in ChatGPT Plus)",
    google: "Requires API key from aistudio.google.com (free tier available)",
    opencode: "Sign up at opencode.ai/auth — one key for curated models",
    "github-copilot": "No API key needed — you'll sign in with GitHub when prompted",
    custom: "Any OpenAI-compatible endpoint (Ollama, Groq, DeepSeek, Mistral, Azure, etc.)",
  };

  // Providers that don't need an API key
  const noKeyProviders = new Set(["github-copilot"]);
  // Providers that use free-text model input instead of a dropdown
  const freeModelProviders = new Set(["custom"]);
  // Providers that need a base URL
  const baseUrlProviders = new Set(["custom"]);

  providerSelect.addEventListener("change", () => {
    const selected = providerSelect.value;
    const models = providers[selected] ?? [];

    // Hint
    if (selected && hints[selected]) {
      providerHint.textContent = hints[selected];
      providerHint.style.display = "block";
    } else {
      providerHint.style.display = "none";
    }

    // API key visibility
    if (noKeyProviders.has(selected)) {
      apiKeyRow.style.display = "none";
      apiKeyInput.value = "";
    } else {
      apiKeyRow.style.display = "block";
    }

    // Base URL visibility
    if (baseUrlProviders.has(selected)) {
      baseUrlRow.style.display = "block";
    } else {
      baseUrlRow.style.display = "none";
      baseUrlInput.value = "";
    }

    // Model: dropdown vs free text
    if (freeModelProviders.has(selected)) {
      modelSelectRow.style.display = "none";
      modelInputRow.style.display = "block";
      modelInput.value = "";
    } else {
      modelSelectRow.style.display = "block";
      modelInputRow.style.display = "none";
      modelSelect.innerHTML = models
        .map((m) => `<option value="${m.id}">${m.name}</option>`)
        .join("");
      modelSelect.disabled = models.length === 0;
    }

    updateTestButton();
  });

  apiKeyInput.addEventListener("input", updateTestButton);
  baseUrlInput.addEventListener("input", updateTestButton);
  modelSelect.addEventListener("change", updateTestButton);
  modelInput.addEventListener("input", updateTestButton);

  function updateTestButton(): void {
    const selected = providerSelect.value;
    if (!selected) { testBtn.disabled = true; return; }

    const needsKey = !noKeyProviders.has(selected);
    const needsBaseUrl = baseUrlProviders.has(selected);
    const usesFreeModel = freeModelProviders.has(selected);

    const hasKey = !needsKey || apiKeyInput.value.trim() !== "";
    const hasBaseUrl = !needsBaseUrl || baseUrlInput.value.trim() !== "";
    const hasModel = usesFreeModel
      ? modelInput.value.trim() !== ""
      : modelSelect.value !== "";

    testBtn.disabled = !(hasKey && hasBaseUrl && hasModel);
  }

  // Button label changes per provider
  function getButtonLabel(provider: string): string {
    if (noKeyProviders.has(provider)) return "Continue";
    return "Test Connection";
  }

  providerSelect.addEventListener("change", () => {
    testBtn.textContent = getButtonLabel(providerSelect.value);
  });

  testBtn.addEventListener("click", () => {
    if (testBtn.disabled) return;
    const selected = providerSelect.value;

    // For no-key providers (Copilot), skip test — just write config and close
    if (noKeyProviders.has(selected)) {
      const model = freeModelProviders.has(selected)
        ? `${selected}/${modelInput.value.trim()}`
        : modelSelect.value;
      vscodeApi.postMessage({
        type: "config-success",
        payload: { provider: selected, model, apiKey: "" },
      });
      return;
    }

    testBtn.disabled = true;
    testBtn.textContent = "Testing…";
    statusMsg.textContent = "";
    statusMsg.style.color = "";

    const model = freeModelProviders.has(selected)
      ? `custom/${modelInput.value.trim()}`
      : modelSelect.value;

    vscodeApi.postMessage({
      type: "test-connection",
      payload: {
        provider: selected,
        model,
        apiKey: apiKeyInput.value,
        ...(baseUrlProviders.has(selected) ? { baseUrl: baseUrlInput.value.trim() } : {}),
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
        const selected = providerSelect.value;
        const model = freeModelProviders.has(selected)
          ? `custom/${modelInput.value.trim()}`
          : modelSelect.value;
        // Notify host to write config and close
        setTimeout(() => {
          vscodeApi.postMessage({
            type: "config-success",
            payload: {
              provider: selected,
              model,
              apiKey: apiKeyInput.value,
              ...(baseUrlProviders.has(selected) ? { baseUrl: baseUrlInput.value.trim() } : {}),
            },
          });
        }, 600);
      } else {
        statusMsg.textContent = `Connection failed: ${result.error ?? "Unknown error"}`;
        statusMsg.style.color = "var(--vscode-testing-iconFailed, #f14c4c)";
        testBtn.disabled = false;
        testBtn.textContent = getButtonLabel(providerSelect.value);
      }
    }
  });

  // ─── Import existing credentials UI ──────────────────────────────────────

  const importLink = document.getElementById("import-link") as HTMLAnchorElement;
  const importStatus = document.getElementById("import-status") as HTMLDivElement;
  const importPreview = document.getElementById("import-preview") as HTMLDivElement;
  const importSection = document.getElementById("import-section") as HTMLDivElement;

  importLink.addEventListener("click", (e) => {
    e.preventDefault();
    importLink.style.display = "none";

    // Show searching status (pulsing orange dot)
    importStatus.style.display = "flex";
    importStatus.style.alignItems = "center";
    importStatus.style.gap = "8px";
    importStatus.style.justifyContent = "center";
    importStatus.innerHTML = `
      <span class="scan-dot scan-dot--searching"></span>
      <span style="font-size: 13px; color: var(--vscode-descriptionForeground);">Searching...</span>
    `;

    // Add scan animation CSS if not already present
    if (!document.getElementById("scan-styles")) {
      const style = document.createElement("style");
      style.id = "scan-styles";
      style.textContent = `
        @keyframes scan-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
        .scan-dot {
          display: inline-block; width: 8px; height: 8px; border-radius: 50%;
        }
        .scan-dot--searching {
          background: #f5a623;
          animation: scan-pulse 1.5s ease-in-out infinite;
        }
        .scan-dot--found { background: #73c991; }
        .scan-dot--failed { background: #f14c4c; }
        .import-provider-row {
          display: flex; align-items: center; gap: 10px; padding: 8px 12px;
          border: 1px solid var(--vscode-input-border, #3c3c3c); border-radius: 4px;
          margin-bottom: 8px; font-size: 13px;
        }
        .import-provider-row label { flex: 1; cursor: pointer; display: flex; align-items: center; gap: 8px; }
        .import-test-status { font-size: 12px; min-width: 16px; text-align: center; }
      `;
      document.head.appendChild(style);
    }

    // Trigger the scan
    vscodeApi.postMessage({ type: "scan-credentials" });
  });

  // Handle scan status & results from host
  window.addEventListener("message", (event) => {
    const msg = event.data;

    if (msg?.type === "scan-status") {
      const { state, count, error } = msg.payload as { state: string; count?: number; error?: string };

      if (state === "searching") {
        // Already showing searching state from the click handler
      } else if (state === "found") {
        importStatus.innerHTML = `
          <span class="scan-dot scan-dot--found"></span>
          <span style="font-size: 13px; color: var(--vscode-testing-iconPassed, #73c991);">Found ${count} provider${count === 1 ? "" : "s"}!</span>
        `;
      } else if (state === "empty") {
        importStatus.innerHTML = `
          <span style="font-size: 13px; color: var(--vscode-descriptionForeground);">No credentials found. Use the form above to configure manually.</span>
        `;
        // Show link again after a moment
        setTimeout(() => {
          importLink.style.display = "inline";
          importLink.textContent = "Try again";
        }, 2000);
      } else if (state === "failed") {
        importStatus.innerHTML = `
          <span class="scan-dot scan-dot--failed"></span>
          <span style="font-size: 13px; color: var(--vscode-testing-iconFailed, #f14c4c);">${error ?? "Scan failed"}</span>
        `;
        setTimeout(() => {
          importLink.style.display = "inline";
          importLink.textContent = "Try again";
        }, 2000);
      }
    }

    if (msg?.type === "scan-results") {
      const { providers } = msg.payload as {
        providers: Array<{ provider: string; source: string; model: string }>;
      };
      if (providers.length === 0) return;

      importPreview.style.display = "block";
      importPreview.innerHTML = `
        <div style="margin-bottom: 12px;">
          <p style="font-size: 13px; color: var(--vscode-descriptionForeground); margin: 0 0 12px;">
            Select which providers to import (tested credentials will be auto-selected):
          </p>
          ${providers
            .map(
              (p, i) => `
            <div class="import-provider-row" id="provider-row-${p.provider}">
              <label style="flex: 0 0 auto;">
                <input type="checkbox" name="import-include" value="${p.provider}" />
              </label>
              <label style="flex: 1; display: flex; align-items: center; gap: 8px; cursor: pointer;">
                <input type="radio" name="import-default" value="${p.provider}" ${i === 0 ? "checked" : ""} disabled />
                <span><strong>${providerNames[p.provider] ?? p.provider}</strong></span>
                <span style="color: var(--vscode-descriptionForeground); font-size: 12px;">from ${p.source}</span>
              </label>
              <span class="import-test-status" id="test-status-${p.provider}">⋯</span>
            </div>
          `,
            )
            .join("")}
          <p style="font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 8px; opacity: 0.8;">
            ☑ = import into config &nbsp; ◉ = use as default model
          </p>
        </div>
        <button id="confirm-import-btn" disabled
          style="width:100%; padding: 10px 16px; cursor: pointer;
          background: var(--color-accent-fill, #fff676); color: var(--color-on-accent, #111);
          border: var(--border-width, 1px) solid var(--color-on-accent, #000);
          border-radius: var(--border-radius, 4px); font-size: 14px; font-weight: 500;
          opacity: 0.5;">
          Confirm & Save
        </button>
        <a id="import-back-link" href="#" style="display: block; text-align: center; margin-top: 12px;
          font-size: 13px; color: var(--vscode-textLink-foreground, #3794ff); text-decoration: none;">
          Back to manual setup
        </a>
        <p style="font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 16px; text-align: center; opacity: 0.8;">
          Only providers with detectable credentials are shown. You can add others manually later in settings or by editing <code>~/.config/opencode/opencode.json</code>.
        </p>
      `;

      // Wire checkbox ↔ radio sync: unchecking a provider disables its radio;
      // checking enables it
      const allCheckboxes = document.querySelectorAll<HTMLInputElement>('input[name="import-include"]');
      allCheckboxes.forEach((cb) => {
        cb.addEventListener("change", () => {
          const row = document.getElementById(`provider-row-${cb.value}`);
          const radio = row?.querySelector('input[name="import-default"]') as HTMLInputElement | null;
          if (!cb.checked) {
            if (row) row.style.opacity = "0.5";
            if (radio) {
              radio.disabled = true;
              if (radio.checked) {
                radio.checked = false;
                // Move default to first still-checked provider
                const firstIncluded = document.querySelector<HTMLInputElement>(
                  'input[name="import-include"]:checked',
                );
                if (firstIncluded) {
                  const firstRow = document.getElementById(`provider-row-${firstIncluded.value}`);
                  const firstRadio = firstRow?.querySelector('input[name="import-default"]') as HTMLInputElement | null;
                  if (firstRadio) firstRadio.checked = true;
                }
              }
            }
          } else {
            if (row) row.style.opacity = "1";
            if (radio) radio.disabled = false;
            // If no default is selected, select this one
            const anyDefault = document.querySelector('input[name="import-default"]:checked:not(:disabled)') as HTMLInputElement | null;
            if (!anyDefault && radio) radio.checked = true;
          }
          updateConfirmState();
        });
      });

      function updateConfirmState(): void {
        const anyIncluded = document.querySelectorAll<HTMLInputElement>(
          'input[name="import-include"]:checked',
        ).length > 0;
        const anyPassed = Array.from(document.querySelectorAll(".import-test-status"))
          .some((el) => el.textContent === "✓");
        const confirmBtn = document.getElementById("confirm-import-btn") as HTMLButtonElement | null;
        if (confirmBtn) {
          const enabled = anyIncluded && anyPassed;
          confirmBtn.disabled = !enabled;
          confirmBtn.style.opacity = enabled ? "1" : "0.5";
        }
      }

      // Wire confirm button
      const confirmBtn = document.getElementById("confirm-import-btn") as HTMLButtonElement;
      confirmBtn.addEventListener("click", () => {
        if (confirmBtn.disabled) return;
        const selected = (
          document.querySelector('input[name="import-default"]:checked') as HTMLInputElement
        )?.value;
        if (!selected) return;
        // Collect which providers are checked for import
        const included = Array.from(
          document.querySelectorAll<HTMLInputElement>('input[name="import-include"]:checked'),
        ).map((cb) => cb.value);
        vscodeApi.postMessage({
          type: "confirm-import",
          payload: { activeProvider: selected, includedProviders: included },
        });
      });

      // Wire back link (AC13)
      const backLink = document.getElementById("import-back-link") as HTMLAnchorElement;
      backLink.addEventListener("click", (e) => {
        e.preventDefault();
        importPreview.style.display = "none";
        importStatus.style.display = "none";
        importLink.style.display = "inline";
        importLink.textContent = "Import existing credentials";
      });
    }

    if (msg?.type === "test-status-update") {
      const { provider, ok, error } = msg.payload as { provider: string; ok: boolean; error?: string };
      const statusEl = document.getElementById(`test-status-${provider}`);
      const rowEl = document.getElementById(`provider-row-${provider}`);
      if (statusEl) {
        if (ok) {
          statusEl.textContent = "✓";
          statusEl.style.color = "var(--vscode-testing-iconPassed, #73c991)";
          // Auto-check passing providers and enable their radio (#455: opt-in, but
          // passing the test is an explicit signal the credential works)
          if (rowEl) {
            rowEl.style.opacity = "1";
            const checkbox = rowEl.querySelector('input[name="import-include"]') as HTMLInputElement | null;
            const radio = rowEl.querySelector('input[name="import-default"]') as HTMLInputElement | null;
            if (checkbox && !checkbox.checked) checkbox.checked = true;
            if (radio) radio.disabled = false;
            // If no default is selected yet, select this one
            const anyDefault = document.querySelector('input[name="import-default"]:checked:not(:disabled)') as HTMLInputElement | null;
            if (!anyDefault && radio) radio.checked = true;
          }
        } else {
          statusEl.textContent = "✗";
          statusEl.style.color = "var(--vscode-testing-iconFailed, #f14c4c)";
          statusEl.title = error ?? "Connection failed";
          // Dim failed providers and ensure they stay unchecked
          if (rowEl) {
            rowEl.style.opacity = "0.5";
            const checkbox = rowEl.querySelector('input[name="import-include"]') as HTMLInputElement | null;
            const radio = rowEl.querySelector('input[name="import-default"]') as HTMLInputElement | null;
            if (checkbox) checkbox.checked = false;
            if (radio) {
              radio.disabled = true;
              if (radio.checked) {
                radio.checked = false;
                const firstIncluded = document.querySelector<HTMLInputElement>(
                  'input[name="import-include"]:checked',
                );
                if (firstIncluded) {
                  const firstRow = document.getElementById(`provider-row-${firstIncluded.value}`);
                  const firstRadio = firstRow?.querySelector('input[name="import-default"]') as HTMLInputElement | null;
                  if (firstRadio) firstRadio.checked = true;
                }
              }
            }
          }
        }
      }

      // Enable confirm button when at least one included provider passed
      const allStatuses = document.querySelectorAll(".import-test-status");
      const anyPassed = Array.from(allStatuses).some((el) => el.textContent === "✓");
      const anyIncluded = document.querySelectorAll<HTMLInputElement>(
        'input[name="import-include"]:checked',
      ).length > 0;
      const confirmBtn = document.getElementById("confirm-import-btn") as HTMLButtonElement | null;
      if (confirmBtn && anyPassed && anyIncluded) {
        confirmBtn.disabled = false;
        confirmBtn.style.opacity = "1";
      }
    }
  });
}

// ─── Boot ────────────────────────────────────────────────────────────────────

// Listen for the transition-state signal from the host (after confirm-import).
// Hides the form, keeps the animation (Amico idle), and shows "Getting Amico ready..."
window.addEventListener("message", (event) => {
  const msg = event.data;
  if (msg?.type === "show-transition") {
    // Hide the form
    formEl.classList.remove("visible");
    formEl.style.display = "none";
    // Hide the cancel button
    const cancelEl = document.getElementById("cancel-btn");
    if (cancelEl) cancelEl.style.display = "none";
    // Remove the "Get Started" button left over from the welcome animation
    const ctaBtn = animationEl.querySelector(".welcome-cta");
    if (ctaBtn) ctaBtn.remove();
    // Remove the welcome text ("Welcome" / subtitle)
    const welcomeText = animationEl.querySelector(".welcome-text");
    if (welcomeText) welcomeText.remove();
    // Show the animation container (restore from the post-animation hidden state)
    animationEl.style.display = "flex";
    animationEl.style.opacity = "1";
    animationEl.style.transition = "none";

    // Swap the face to happy expression: remove bottom eye bars + add pixelated open grin
    const svg = animationEl.querySelector(".amico-mark");
    if (svg) {
      // Remove the bottom bar from each eye (makes ∩ shape = happy closed eyes)
      const leftEye = svg.querySelector(".left-eye");
      const rightEye = svg.querySelector(".right-eye");
      if (leftEye) {
        // The 4th rect in eye-ring is the bottom bar (y ≈ 1870)
        const rects = leftEye.querySelectorAll(".eye-ring rect");
        if (rects.length >= 4) rects[3].remove();
        // Remove the lid too (not needed for happy eyes)
        const lid = leftEye.querySelector(".eye-lid");
        if (lid) lid.remove();
      }
      if (rightEye) {
        const rects = rightEye.querySelectorAll(".eye-ring rect");
        if (rects.length >= 4) rects[3].remove();
        const lid = rightEye.querySelector(".eye-lid");
        if (lid) lid.remove();
      }
      // Stop eye animations (happy eyes don't blink)
      if (leftEye) {
        const ring = leftEye.querySelector(".eye-ring") as HTMLElement;
        if (ring) ring.style.animation = "none";
      }
      if (rightEye) {
        const ring = rightEye.querySelector(".eye-ring") as HTMLElement;
        if (ring) ring.style.animation = "none";
      }

      // Find the inner-most animated group to switch animation
      const enterGroup = svg.querySelector(".mark-enter") || svg.querySelector(".mark-breathe");

      // Switch from idle animations to excited jump
      const breatheGroup = svg.querySelector(".mark-breathe") as HTMLElement;
      if (breatheGroup) {
        breatheGroup.style.animation = "amico-jump 2.0s ease-in-out infinite";
      }
    }

    // Add "Getting Amico ready..." text below the animation
    let transitionText = document.getElementById("transition-text");
    if (!transitionText) {
      transitionText = document.createElement("div");
      transitionText.id = "transition-text";
      transitionText.style.cssText = `
        text-align: center; margin-top: 24px; font-size: 14px;
        color: var(--vscode-descriptionForeground, #999);
      `;
      transitionText.textContent = "Getting Amico ready...";
      animationEl.parentElement!.insertBefore(transitionText, animationEl.nextSibling);
    }
  }
});

// Wire the cancel button
const cancelBtn = document.getElementById("cancel-btn");
if (cancelBtn) {
  cancelBtn.addEventListener("click", () => {
    vscodeApi.postMessage({ type: "cancel" });
  });
}

playWelcomeAnimation();
