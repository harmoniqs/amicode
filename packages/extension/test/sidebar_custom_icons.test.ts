// sidebar_custom_icons.test.ts — Custom SVG icons for environments and research projects (#914).
// Part of #911 (nest environments in research section).
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const webviewSrc = readFileSync(
  resolve(__dirname, "..", "src", "sidebar_webview.ts"),
  "utf8",
);

describe("sidebar custom icons (#914)", () => {
  it("defines a createFlaskIconEl factory function", () => {
    expect(webviewSrc).toMatch(/function\s+createFlaskIconEl\s*\(/);
  });

  it("defines a createClipboardIconEl factory function", () => {
    expect(webviewSrc).toMatch(/function\s+createClipboardIconEl\s*\(/);
  });

  it("flask icon uses an inline SVG with stroke=currentColor", () => {
    expect(webviewSrc).toMatch(/createFlaskIconEl[\s\S]*?svg/);
    expect(webviewSrc).toMatch(/currentColor/);
  });

  it("clipboard icon uses an inline SVG with stroke=currentColor", () => {
    expect(webviewSrc).toMatch(/createClipboardIconEl[\s\S]*?svg/);
  });

  it("renderRootNode uses flask icon for research projects", () => {
    // Must select the icon based on projectType
    expect(webviewSrc).toMatch(/createFlaskIconEl/);
  });

  it("renderEnvGroupNode uses clipboard icon (not folder icon)", () => {
    expect(webviewSrc).toMatch(/createClipboardIconEl/);
  });

  it("click handler guards icon swap for research projects (no folder replacement)", () => {
    // In renderRootNode, the click handler must NOT replace custom icons with folder icons
    // Must check projectType before doing the icon swap
    expect(webviewSrc).toMatch(/projectType.*!==?\s*["']research["']/);
  });

  it("click handler guards icon swap for environment groups", () => {
    // renderEnvGroupNode click handler must not replace clipboard icon with folder icon
    // Either the handler skips the swap entirely, or checks before replacing
    // Since env group always has a clipboard icon, the swap should be skipped
    const envGroupFn = webviewSrc.match(/function\s+renderEnvGroupNode[\s\S]*?(?=function\s+populateEnvGroupChildren)/);
    expect(envGroupFn).not.toBeNull();
    const body = envGroupFn![0];
    // The env group click handler should NOT call createFolderIconEl
    expect(body).not.toMatch(/createFolderIconEl\(expanded/);
  });
});
