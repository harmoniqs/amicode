// #1036 — "Find in sidebar": the pure planning behind the sidebar webview's
// reveal (ancestor chain, top-down expansion steps, scroll offset), plus the
// host plumbing pins (message vocabulary, command, highlight style).
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  REVEAL_CONTEXT_ROWS,
  REVEAL_HIGHLIGHT_MS,
  nextRevealAction,
  revealChain,
  revealScrollTop,
} from "../src/sidebar_reveal";

const read = (name: string) => readFileSync(resolve(__dirname, "..", "src", name), "utf8");

describe("revealChain — which folders must open to show a file", () => {
  const roots = ["/w/proj", "/w/proj/nested-root", "/w/other"];

  it("lists the root then every intermediate directory, top-down, excluding the file", () => {
    expect(revealChain("/w/proj/src/lib/a.ts", roots)).toEqual({
      root: "/w/proj",
      dirs: ["/w/proj", "/w/proj/src", "/w/proj/src/lib"],
    });
  });

  it("picks the deepest owning root", () => {
    expect(revealChain("/w/proj/nested-root/x/y.md", roots)).toEqual({
      root: "/w/proj/nested-root",
      dirs: ["/w/proj/nested-root", "/w/proj/nested-root/x"],
    });
  });

  it("a file directly in a root needs only the root open", () => {
    expect(revealChain("/w/proj/README.md", roots)).toEqual({ root: "/w/proj", dirs: ["/w/proj"] });
  });

  it("does not confuse a sibling that merely shares a name prefix", () => {
    expect(revealChain("/w/proj-two/a.md", roots)).toBeUndefined();
  });

  it("files outside every root (or empty / relative paths) are a silent no-op", () => {
    expect(revealChain("/elsewhere/a.md", roots)).toBeUndefined();
    expect(revealChain("", roots)).toBeUndefined();
    expect(revealChain("a.md", roots)).toBeUndefined();
  });

  it("tolerates trailing slashes on roots", () => {
    expect(revealChain("/w/proj/a.md", ["/w/proj/"])).toEqual({ root: "/w/proj/", dirs: ["/w/proj/"] });
  });
});

describe("nextRevealAction — sequential top-down expansion", () => {
  const dirs = ["/r", "/r/a", "/r/a/b"];
  const state = (expanded: string[], loaded: string[], targetInDom = false) => ({
    dirs,
    expanded: (p: string) => expanded.includes(p),
    childrenLoaded: (p: string) => loaded.includes(p),
    targetInDom,
  });

  it("expands the first collapsed ancestor before touching deeper ones", () => {
    expect(nextRevealAction(state([], []))).toEqual({ kind: "expand", path: "/r" });
    expect(nextRevealAction(state(["/r"], ["/r"]))).toEqual({ kind: "expand", path: "/r/a" });
  });

  it("awaits children at each level (child DOM only exists after the parent's children render)", () => {
    expect(nextRevealAction(state(["/r"], []))).toEqual({ kind: "load", path: "/r" });
    expect(nextRevealAction(state(["/r", "/r/a"], ["/r"]))).toEqual({ kind: "load", path: "/r/a" });
  });

  it("scrolls once every ancestor is open and the target row exists", () => {
    expect(nextRevealAction(state(dirs, dirs, true))).toEqual({ kind: "scroll" });
  });

  it("a missing target after full expansion is a silent no-op (no error, no broken state)", () => {
    expect(nextRevealAction(state(dirs, dirs, false))).toEqual({ kind: "none" });
  });
});

describe("scroll + highlight constants", () => {
  it("the file sits about 3 rows below the visible top", () => {
    expect(REVEAL_CONTEXT_ROWS).toBe(3);
    expect(revealScrollTop(400, 22)).toBe(400 - 3 * 22);
    expect(revealScrollTop(30, 22)).toBe(0); // never negative
  });

  it("the highlight fades after about 2.5 seconds", () => {
    expect(REVEAL_HIGHLIGHT_MS).toBe(2500);
  });
});

describe("webview reveal wiring (static pins — the webview is a browser IIFE)", () => {
  const webview = read("sidebar_webview.ts");

  it("handles the host's reveal-file message and flashes a theme-adaptive highlight", () => {
    expect(webview).toContain('case "reveal-file"');
    expect(webview).toContain("reveal-highlight");
    expect(webview).toContain("--vscode-editor-findMatchHighlightBackground");
    // rapid successive reveals cancel the previous highlight timer
    expect(webview).toMatch(/clearTimeout\(revealHighlightTimer\)/);
  });

  it("defers the scroll past the section animation when the section was just opened", () => {
    expect(webview).toMatch(/SECTION_ANIM_MS \+ 50/);
    expect(webview).toContain("revealScrollTop(");
  });

  it("continues a pending reveal after the awaited children render, and gives up on a failed load", () => {
    expect(webview).toContain("advanceReveal()");
    expect(webview).toContain("pendingReveal");
  });
});

describe("host reveal plumbing (static pins)", () => {
  it("declares the down message and the provider method", () => {
    expect(read("sidebar_bridge.ts")).toContain('kind: "reveal-file"');
    expect(read("sidebar_view.ts")).toMatch(/revealFile\(/);
  });

  it("registers the amicode.revealInSidebar command and declares it in the manifest", () => {
    expect(read("extension.ts")).toContain('"amicode.revealInSidebar"');
    const manifest = JSON.parse(readFileSync(resolve(__dirname, "..", "package.json"), "utf8"));
    const ids = (manifest.contributes.commands as Array<{ command: string }>).map((c) => c.command);
    expect(ids).toContain("amicode.revealInSidebar");
  });

  it("relays reveal-in-sidebar up from the app iframe through both outer relays", () => {
    const panel = read("chat_panel.ts");
    expect(panel.match(/d\.kind === "reveal-in-sidebar"/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
