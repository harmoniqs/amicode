// sidebar_reveal.test.ts — "Find in sidebar" (#1036): ancestor-chain resolution
// plus source contracts for the webview reveal flow and the command wiring.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { resolveRevealChain } from "../src/sidebar_bridge";
import type { TreeRoot } from "../src/sidebar_bridge";

const read = (...p: string[]) => readFileSync(resolve(__dirname, "..", ...p), "utf8");

const root = (path: string, projectType: TreeRoot["projectType"] = "dev"): TreeRoot =>
  ({ path, name: path.split("/").pop()!, projectType }) as TreeRoot;

describe("resolveRevealChain (#1036)", () => {
  const roots = [root("/w/alpha"), root("/w/beta", "research"), root("/w/beta/envs", "environment")];

  it("returns the root plus every intermediate directory, top-down", () => {
    const chain = resolveRevealChain("/w/alpha/src/deep/file.jl", roots);
    expect(chain?.root.path).toBe("/w/alpha");
    expect(chain?.dirs).toEqual(["/w/alpha", "/w/alpha/src", "/w/alpha/src/deep"]);
  });

  it("a file directly under the root expands only the root", () => {
    expect(resolveRevealChain("/w/alpha/README.md", roots)?.dirs).toEqual(["/w/alpha"]);
  });

  it("the root itself needs no expansion", () => {
    expect(resolveRevealChain("/w/alpha", roots)).toEqual({ root: roots[0], dirs: [] });
  });

  it("picks the deepest containing root for nested roots", () => {
    const chain = resolveRevealChain("/w/beta/envs/x/y.toml", roots);
    expect(chain?.root.path).toBe("/w/beta/envs");
    expect(chain?.dirs).toEqual(["/w/beta/envs", "/w/beta/envs/x"]);
  });

  it("does not match a sibling that merely shares a name prefix", () => {
    expect(resolveRevealChain("/w/alphabet/file.jl", roots)).toBeNull();
  });

  it("returns null for files outside every root and for empty input", () => {
    expect(resolveRevealChain("/elsewhere/file.jl", roots)).toBeNull();
    expect(resolveRevealChain("", roots)).toBeNull();
    expect(resolveRevealChain("/w/alpha/a.jl", [])).toBeNull();
  });

  it("tolerates a trailing slash on the root path", () => {
    const chain = resolveRevealChain("/w/gamma/src/a.jl", [root("/w/gamma/")]);
    expect(chain?.dirs).toEqual(["/w/gamma/", "/w/gamma/src"]);
  });

  it("handles Windows-style separators", () => {
    const chain = resolveRevealChain("C:\\w\\alpha\\src\\a.jl", [root("C:\\w\\alpha")]);
    expect(chain?.dirs).toEqual(["C:\\w\\alpha", "C:\\w\\alpha\\src"]);
  });
});

describe("sidebar webview reveal flow (#1036) — source contract", () => {
  const web = read("src", "sidebar_webview.ts");
  const view = read("src", "sidebar_view.ts");

  it("handles the reveal-file message and queues it until roots render", () => {
    expect(web).toMatch(/case "reveal-file"/);
    expect(web).toMatch(/pendingReveal/);
  });

  it("expands ancestors sequentially, awaiting the children round-trip", () => {
    expect(web).toMatch(/for \(const dir of chain\.dirs\)[\s\S]*await ensureDirectoryExpanded/);
    expect(web).toMatch(/kind: "get-children"/);
    expect(web).toMatch(/resolveChildrenWaiters\(msg\.path\)/);
  });

  it("scrolls with a 3-row offset and defers past the section animation", () => {
    expect(web).toMatch(/REVEAL_ROW_OFFSET\s*=\s*3/);
    expect(web).toMatch(/Math\.max\(0, rowTop - REVEAL_ROW_OFFSET \* rowHeight\)/);
    expect(web).toMatch(/SECTION_ANIM_MS \+ 50/);
  });

  it("flashes for ~2.5s and cancels the previous highlight timers on a new reveal", () => {
    expect(web).toMatch(/REVEAL_HIGHLIGHT_MS\s*=\s*2500/);
    expect(web).toMatch(/clearTimeout\(revealFadeTimer\)/);
    expect(web).toMatch(/clearRevealHighlight\(\);\s*\n\s*revealHighlightEl = row/);
  });

  it("a newer reveal supersedes an in-flight one via a token", () => {
    expect(web).toMatch(/token !== revealToken/);
  });

  it("highlight uses the theme find-match colour", () => {
    expect(view).toContain("var(--vscode-editor-findMatchHighlightBackground)");
    expect(view).toMatch(/\.tree-node\.reveal-highlight/);
  });
});

describe("amicode.revealInSidebar command wiring (#1036)", () => {
  it("is declared in package.json contributes.commands", () => {
    const pkg = JSON.parse(read("package.json"));
    const cmd = pkg.contributes.commands.find((c: { command: string }) => c.command === "amicode.revealInSidebar");
    expect(cmd).toBeTruthy();
    expect(cmd.title).toMatch(/sidebar/i);
  });

  it("is registered in extension.ts and focuses the sidebar before revealing", () => {
    const ext = read("src", "extension.ts");
    expect(ext).toContain('registerCommand("amicode.revealInSidebar"');
    expect(ext).toMatch(/executeCommand\("amicode\.workspace\.focus"\)[\s\S]*sidebarProvider\.revealFile\(/);
    expect(ext).toMatch(/ChatPanel\.onRevealInSidebar\(/);
  });
});
