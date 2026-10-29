// @vitest-environment happy-dom
// #1418 — a focused provider-connect must not leave the (100vh) #animation div
// in the document, or the form is pushed below the fold and the panel looks blank.

import { describe, it, expect, beforeEach, vi } from "vitest";

async function boot(focus: string | null) {
  vi.resetModules();
  document.body.innerHTML =
    '<div id="animation" class="animation-container"></div><div id="form" class="form-container"></div>';
  const w = window as unknown as Record<string, unknown>;
  w.acquireVsCodeApi = () => ({ postMessage: () => {} });
  (globalThis as Record<string, unknown>).acquireVsCodeApi = w.acquireVsCodeApi;
  w.__PROVIDERS__ = { anthropic: [{ id: "m", name: "M" }] };
  w.__PROVIDER_NAMES__ = { anthropic: "Anthropic" };
  w.__FOCUS_PROVIDER__ = focus;
  await import("../src/onboarding_webview");
}

describe("onboarding webview — focused connect (#1418)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("hides #animation and renders the form when a provider is focused", async () => {
    await boot("anthropic");
    const anim = document.getElementById("animation")!;
    expect(anim.style.display).toBe("none");
    expect(document.getElementById("form")!.innerHTML).toContain("Connect Anthropic");
  });

  it("does not hide #animation up front on the unfocused welcome path", async () => {
    await boot(null);
    expect(document.getElementById("animation")!.style.display).not.toBe("none");
  });
});
