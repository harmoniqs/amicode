import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as vscode from "vscode";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handleAmicodeBridgeMessage, type BridgeIo } from "../src/chat_bridge";

// ============================================================================
// #1826 — posture-aware link resolution. Bridge-level fixtures over the
// open-file handler: on the hub-client posture a chat link click re-resolves
// through the hub's resolve-file route and opens in Preview via the hub SDK —
// the client stat routes (vault roots only) but never blocks the open.
// ============================================================================

const window_ = vscode.window as unknown as { messages: string[] };
const commands_ = vscode.commands as unknown as { executed: string[]; executedArgs: unknown[][] };

function io(linkResolution?: Record<string, unknown>): BridgeIo & { posted: unknown[] } {
  const posted: unknown[] = [];
  return {
    posted,
    visible: () => true,
    postToWebview: (m) => {
      posted.push(m);
    },
    ...(linkResolution ? { linkResolution } : {}),
  };
}

/** A hub resolve-file mock that always finds `hubPath`. Records every URL. */
function hubResolveFound(hubPath: string): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ ok: true, found: true, path: hubPath }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetch, urls };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

const hubClientContext = (fetch: typeof fetch) => ({
  posture: "hub-client" as const,
  hubUrl: "http://127.0.0.1:4097",
  fetchImpl: fetch,
});

beforeEach(() => {
  window_.messages.length = 0;
  commands_.executed.length = 0;
  commands_.executedArgs.length = 0;
});

describe("posture-aware link resolution — hub-client (#1826)", () => {
  it("a non-vault path absent locally re-resolves through the hub and posts preview-file (the client stat never blocks)", async () => {
    const { fetch, urls } = hubResolveFound("/home/aaron/.amico/vaults/armonissima/experiments/exp-20261021-x.md");
    const host = io(hubClientContext(fetch));
    // The hub path is NOT on this laptop's disk — the pre-#1826 existsSync
    // gate killed every such click silently.
    const url = "file:///home/aaron/.amico/vaults/armonissima/experiments/exp-20261021-x.md";
    expect(fs.existsSync("/home/aaron/.amico/vaults/armonissima/experiments/exp-20261021-x.md")).toBe(false);
    expect(handleAmicodeBridgeMessage({ source: "amicode", kind: "open-file", url }, host)).toBe(true);
    await flush();
    // Click-time re-resolution through the hub's resolve-file route happened.
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/amicode/resolve-file?");
    // The hub-resolved path opens in Preview via the hub SDK — no local stat.
    const previewMsg = host.posted.find((m) => (m as { kind?: string }).kind === "preview-file");
    expect(previewMsg).toBeDefined();
    expect((previewMsg as { path: string }).path).toBe(
      "/home/aaron/.amico/vaults/armonissima/experiments/exp-20261021-x.md",
    );
    expect(window_.messages).toHaveLength(0);
  });
});
