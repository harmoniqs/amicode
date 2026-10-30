// @vitest-environment happy-dom
// Onboarding webview — focused-connect boot path (harmoniqs/amicode#1418).
//
// Regression: the focused connect entry point ("Connect Harmoniqs AI Provider")
// calls revealForm() directly and never runs playWelcomeAnimation(), so the
// #animation container (visible by default, 100vh) was never hidden. The
// connect form was rendered below the fold behind an empty full-viewport div.
//
// Contract pinned here: when the webview boots with window.__FOCUS_PROVIDER__
// set, the animation container is hidden and the form is visible — the form is
// the first thing the user sees, with no welcome beat in front of it.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const PROVIDERS = { harmoniqs: [{ id: "harmoniqs-model", name: "Harmoniqs Model" }] };

function mountShell(): void {
  // Same element ids/order the host panel emits (src/onboarding_panel.ts).
  document.body.innerHTML = `
    <button id="cancel-btn" class="cancel-btn">&times;</button>
    <div id="animation" class="animation-container"></div>
    <div id="form" class="form-container"></div>`;
}

async function bootWebview(focusProvider: string | null): Promise<void> {
  mountShell();
  (window as unknown as Record<string, unknown>).__PROVIDERS__ = PROVIDERS;
  (window as unknown as Record<string, unknown>).__PROVIDER_NAMES__ = { harmoniqs: "Harmoniqs" };
  (window as unknown as Record<string, unknown>).__FOCUS_PROVIDER__ = focusProvider;
  vi.resetModules();
  await import("../src/onboarding_webview");
}

describe("onboarding webview — focused connect boot path (#1418)", () => {
  beforeEach(() => {
    (globalThis as unknown as Record<string, unknown>).acquireVsCodeApi = () => ({
      postMessage: vi.fn(),
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("focused connect hides the welcome animation container so the form is not pushed below the fold", async () => {
    await bootWebview("harmoniqs");

    const animationEl = document.getElementById("animation")!;
    const formEl = document.getElementById("form")!;

    expect(formEl.classList.contains("visible")).toBe(true);
    expect(animationEl.style.display).toBe("none");
  });

  it("stage-0 (no focus) still plays the welcome animation and does not hide it at boot", async () => {
    await bootWebview(null);

    const animationEl = document.getElementById("animation")!;
    const formEl = document.getElementById("form")!;

    // Welcome beat is playing: the animation is not hidden yet and the form is not revealed.
    expect(animationEl.style.display).not.toBe("none");
    expect(formEl.classList.contains("visible")).toBe(false);
  });
});
