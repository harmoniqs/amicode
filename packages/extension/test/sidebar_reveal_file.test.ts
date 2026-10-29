// sidebar_reveal_file.test.ts — "Find in sidebar" tree reveal (#1036).
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const webviewSrc = readFileSync(resolve(__dirname, "..", "src", "sidebar_webview.ts"), "utf8");
const viewSrc = readFileSync(resolve(__dirname, "..", "src", "sidebar_view.ts"), "utf8");
const bridgeSrc = readFileSync(resolve(__dirname, "..", "src", "sidebar_bridge.ts"), "utf8");
const extSrc = readFileSync(resolve(__dirname, "..", "src", "extension.ts"), "utf8");
const pkg = JSON.parse(readFileSync(resolve(__dirname, "..", "package.json"), "utf8"));

describe("Find in sidebar — host wiring (#1036)", () => {
  it("declares and registers the amicode.revealInSidebar command", () => {
    const cmds = pkg.contributes.commands.map((c: { command: string }) => c.command);
    expect(cmds).toContain("amicode.revealInSidebar");
    expect(extSrc).toContain('registerCommand("amicode.revealInSidebar"');
  });

  it("the down-message union carries reveal-file", () => {
    expect(bridgeSrc).toMatch(/kind: "reveal-file"; path: string/);
    expect(bridgeSrc).toMatch(/\| RevealFileMessage/);
  });

  it("revealFile focuses the sidebar view before posting", () => {
    const fn = viewSrc.slice(viewSrc.indexOf("async revealFile"));
    expect(fn.indexOf("amicode.workspace.focus")).toBeGreaterThan(-1);
    expect(fn.indexOf("amicode.workspace.focus")).toBeLessThan(fn.indexOf('kind: "reveal-file"'));
  });
});

describe("Find in sidebar — webview reveal logic (#1036)", () => {
  it("handles reveal-file and queues it until roots are rendered", () => {
    expect(webviewSrc).toMatch(/case "reveal-file"/);
    expect(webviewSrc).toMatch(/pendingReveal/);
  });

  it("expands ancestors sequentially, awaiting children at each level", () => {
    const fn = webviewSrc.slice(webviewSrc.indexOf("async function revealFileInTree"));
    expect(fn).toContain("await waitForChildren(");
    expect(fn).toContain("row.click()");
  });

  it("the children handler releases reveal waiters", () => {
    expect(webviewSrc).toContain("notifyChildrenWaiters(msg.path)");
  });

  it("scrolls with a 3-row offset and clamps at zero", () => {
    expect(webviewSrc).toMatch(/REVEAL_ROW_OFFSET\s*=\s*3/);
    expect(webviewSrc).toMatch(/Math\.max\(0,\s*targetTop - REVEAL_ROW_OFFSET \* rowHeight\)/);
  });

  it("defers the scroll past the section animation", () => {
    expect(webviewSrc).toMatch(/setTimeout\(doReveal, SECTION_ANIM_MS \+ 50\)/);
  });

  it("highlight lasts ~2.5s and a new reveal clears the pending timers", () => {
    expect(webviewSrc).toMatch(/REVEAL_HIGHLIGHT_MS\s*=\s*2500/);
    const flash = webviewSrc.slice(webviewSrc.indexOf("function flashRevealHighlight"));
    expect(flash.slice(0, flash.indexOf("clearRevealHighlight()") + 30)).toContain("clearRevealHighlight()");
    const clear = webviewSrc.slice(webviewSrc.indexOf("function clearRevealHighlight"));
    expect(clear.slice(0, 400)).toContain("clearTimeout(revealHighlightTimer)");
  });

  it("files outside every root are a silent no-op", () => {
    const fn = webviewSrc.slice(webviewSrc.indexOf("async function revealFileInTree"));
    expect(fn).toMatch(/if \(!root\) return;/);
  });

  it("styles the highlight with the theme find-match colour", () => {
    expect(viewSrc).toMatch(/\.tree-node\.reveal-highlight\s*\{[^}]*--vscode-editor-findMatchHighlightBackground/);
  });
});
