// preview_relay.test.ts — TDD test for the webview relay allowlist (#725/#729).
//
// The VS Code webview relay in chat_panel.ts has explicit allowlists for which
// bridge message kinds are forwarded between the extension and the iframe.
// Our new messages must be in both relay renderers (renderHtml + renderTransitionHtml).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(__dirname, "../src/chat_panel.ts"), "utf-8");

describe("webview relay allowlists include preview file tree messages (#725)", () => {
  it("forwards preview-file-tree from extension to iframe (both renderers)", () => {
    const matches = src.match(/"preview-file-tree"/g) ?? [];
    // Must appear in BOTH relay renderers (renderHtml + renderTransitionHtml)
    // plus any bridge handler references — at minimum 2 for the relays
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("forwards preview-file-tree-request from iframe to extension (both renderers)", () => {
    const matches = src.match(/"preview-file-tree-request"/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});

describe("webview relay allowlists include TeX compile messages (#729)", () => {
  it("forwards tex-compile-status from extension to iframe (both renderers)", () => {
    const matches = src.match(/"tex-compile-status"/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("forwards tex-compile-request from iframe to extension (both renderers)", () => {
    const matches = src.match(/"tex-compile-request"/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});

describe("relay allowlist structural completeness", () => {
  // The extension→iframe relay (lane 2) is the long || chain containing
  // "workspace-projects". Our new kinds must be in that same chain.
  it("preview-file-tree is in the same relay block as workspace-projects", () => {
    // Find each lane-2 relay block (extension→iframe) by matching the
    // workspace-projects reference and its surrounding context
    const lane2Pattern = /d\.kind\s*===\s*"workspace-projects"[^}]+/g;
    const lane2Blocks = src.match(lane2Pattern) ?? [];
    expect(lane2Blocks.length).toBeGreaterThanOrEqual(2); // both renderers

    for (const block of lane2Blocks) {
      expect(block).toContain('"preview-file-tree"');
      expect(block).toContain('"tex-compile-status"');
    }
  });
});
