// @vitest-environment happy-dom
// Focused provider-connect must not leave the 100vh #animation container in
// the document — it pushes the (correctly rendered) #form below the fold, so
// the panel looks blank (harmoniqs/amicode#1418).

import { describe, it, expect, beforeEach, vi } from "vitest";

describe("onboarding webview — focused connect (#1418)", () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = `<div id="animation" style="display:flex"></div><div id="form" style="display:none"></div>`;
    const w = window as unknown as Record<string, unknown>;
    w.acquireVsCodeApi = () => ({ postMessage: () => {}, getState: () => undefined, setState: () => {} });
    (globalThis as Record<string, unknown>).acquireVsCodeApi = w.acquireVsCodeApi;
    w.__PROVIDERS__ = { anthropic: [{ id: "m", name: "M" }] };
    w.__PROVIDER_NAMES__ = { anthropic: "Anthropic" };
  });

  it("hides #animation when a focus provider is set", async () => {
    (window as unknown as Record<string, unknown>).__FOCUS_PROVIDER__ = "anthropic";
    await import("../src/onboarding_webview");
    expect(document.getElementById("animation")!.style.display).toBe("none");
    expect(document.getElementById("form")!.innerHTML).not.toBe("");
  });
});
