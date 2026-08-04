import { describe, it, expect, beforeEach } from "vitest";
import * as vscode from "vscode";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handleAmicodeBridgeMessage, type BridgeIo } from "../src/chat_bridge";

// ============================================================================
// The shared iframe⇄extension bridge: strict allowlists, https-only externals,
// visibility-gated clipboard, and the pane `tab` tag echoed on replies so the
// deck shell can route answers to the asking pane.
// ============================================================================

const env = vscode.env as unknown as { opened: unknown[]; clipboard: { text: string } };
const ws = vscode.workspace as unknown as { configUpdates: Array<[string, unknown]> };

function io(visible = true): BridgeIo & { posted: unknown[] } {
  const posted: unknown[] = [];
  return {
    posted,
    visible: () => visible,
    postToWebview: (m) => {
      posted.push(m);
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  env.opened.length = 0;
  env.clipboard.text = "";
  ws.configUpdates.length = 0;
});

describe("amicode bridge — open-external", () => {
  it("opens https URLs and nothing else", () => {
    const host = io();
    expect(handleAmicodeBridgeMessage({ source: "amicode", kind: "open-external", url: "https://example.com/x" }, host)).toBe(true);
    expect(env.opened).toHaveLength(1);
    for (const url of ["http://evil.test", "file:///etc/passwd", "javascript:alert(1)"]) {
      expect(handleAmicodeBridgeMessage({ source: "amicode", kind: "open-external", url }, host)).toBe(false);
    }
    expect(env.opened).toHaveLength(1);
  });
});

describe("amicode bridge — open-file", () => {
  it("opens existing local files in the editor and drops everything else", async () => {
    const host = io();
    const target = path.join(os.tmpdir(), `amicode open file ${Date.now()}.md`);
    fs.writeFileSync(target, "# note\n");
    const executed = (vscode.commands as unknown as { executed: string[] }).executed;
    const url = "file://" + target.split("/").map(encodeURIComponent).join("/");
    expect(handleAmicodeBridgeMessage({ source: "amicode", kind: "open-file", url }, host)).toBe(true);
    await flush();
    expect(executed).toContain("vscode.open");
    fs.rmSync(target, { force: true });
  });

  it("never opens non-file schemes, missing files, or non-absolute paths", async () => {
    const host = io();
    const executed = (vscode.commands as unknown as { executed: string[] }).executed;
    const before = executed.length;
    // Non-file schemes are not ours at all (consumed = false, like open-external).
    for (const url of ["https://example.com/x", "javascript:alert(1)"]) {
      expect(handleAmicodeBridgeMessage({ source: "amicode", kind: "open-file", url }, host)).toBe(false);
    }
    // file:// shape but unreachable: consumed silently, nothing opened.
    expect(
      handleAmicodeBridgeMessage({ source: "amicode", kind: "open-file", url: "file:///definitely/not/here-xyz.md" }, host),
    ).toBe(true);
    await flush();
    expect(executed).toHaveLength(before);
  });
});

describe("amicode bridge — clipboard", () => {
  it("clipboard-request answers with the OS clipboard text and echoes the pane tab", async () => {
    const host = io();
    env.clipboard.text = "ω = 4.9 GHz";
    expect(handleAmicodeBridgeMessage({ source: "amicode", kind: "clipboard-request", nonce: "n1", tab: "pane-7" }, host)).toBe(true);
    await flush();
    expect(host.posted).toEqual([
      { source: "amicode", kind: "clipboard", nonce: "n1", text: "ω = 4.9 GHz", tab: "pane-7" },
    ]);
  });

  it("a hidden panel never answers clipboard reads", async () => {
    const host = io(false);
    env.clipboard.text = "secret";
    expect(handleAmicodeBridgeMessage({ source: "amicode", kind: "clipboard-request", nonce: "n2" }, host)).toBe(true);
    await flush();
    expect(host.posted).toHaveLength(0);
  });

  it("clipboard-write stores bounded text, drops the unbounded", async () => {
    const host = io();
    expect(handleAmicodeBridgeMessage({ source: "amicode", kind: "clipboard-write", text: "pulse" }, host)).toBe(true);
    await flush();
    expect(env.clipboard.text).toBe("pulse");
    env.clipboard.text = "";
    expect(handleAmicodeBridgeMessage({ source: "amicode", kind: "clipboard-write", text: "x".repeat(5_000_001) }, host)).toBe(true);
    await flush();
    expect(env.clipboard.text).toBe("");
  });
});

describe("amicode bridge — commands & settings", () => {
  it("runs allowlisted commands only", async () => {
    const host = io();
    expect(handleAmicodeBridgeMessage({ source: "amicode", kind: "command", command: "amicode.stopRun" }, host)).toBe(true);
    await flush();
    const ran = (vscode.commands as unknown as { executed: string[] }).executed ?? [];
    expect(ran).toContain("amicode.stopRun");
    expect(handleAmicodeBridgeMessage({ source: "amicode", kind: "command", command: "workbench.action.terminal.kill" }, host)).toBe(false);
  });

  it("set-default-model accepts provider/model-id shapes and mirrors them to config", () => {
    const host = io();
    expect(handleAmicodeBridgeMessage({ source: "amicode", kind: "set-default-model", model: "anthropic/claude-sonnet-5" }, host)).toBe(true);
    expect(ws.configUpdates).toEqual([["defaultModel", "anthropic/claude-sonnet-5"]]);
    ws.configUpdates.length = 0;
    expect(handleAmicodeBridgeMessage({ source: "amicode", kind: "set-default-model", model: "not a model" }, host)).toBe(true);
    expect(ws.configUpdates).toEqual([]);
  });

  it("ignores foreign envelopes entirely", () => {
    const host = io();
    expect(handleAmicodeBridgeMessage({ source: "elsewhere", kind: "command", command: "amicode.stopRun" }, host)).toBe(false);
    expect(handleAmicodeBridgeMessage("a string", host)).toBe(false);
  });
});
