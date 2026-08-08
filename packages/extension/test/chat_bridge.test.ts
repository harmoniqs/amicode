import { describe, it, expect, beforeEach } from "vitest";
import * as vscode from "vscode";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handleAmicodeBridgeMessage, extractReportBugModel, type BridgeIo } from "../src/chat_bridge";

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
  it("opens markdown files as a rendered preview tab", async () => {
    const host = io();
    const target = path.join(os.tmpdir(), `amicode open file ${Date.now()}.md`);
    fs.writeFileSync(target, "# note\n");
    const executed = (vscode.commands as unknown as { executed: string[] }).executed;
    const before = executed.length;
    const url = "file://" + target.split("/").map(encodeURIComponent).join("/");
    expect(handleAmicodeBridgeMessage({ source: "amicode", kind: "open-file", url }, host)).toBe(true);
    await flush();
    expect(executed.slice(before)).toEqual(["markdown.showPreview"]);
    fs.rmSync(target, { force: true });
  });

  it("opens non-markdown files in the default editor", async () => {
    const host = io();
    const target = path.join(os.tmpdir(), `amicode open file ${Date.now()}.toml`);
    fs.writeFileSync(target, "fidelity = 0.9982\n");
    const executed = (vscode.commands as unknown as { executed: string[] }).executed;
    const before = executed.length;
    const url = "file://" + target.split("/").map(encodeURIComponent).join("/");
    expect(handleAmicodeBridgeMessage({ source: "amicode", kind: "open-file", url }, host)).toBe(true);
    await flush();
    expect(executed.slice(before)).toEqual(["vscode.open"]);
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

  it("allowlists amicode.reportBug — the composer bug button's command lane (amicode#250)", async () => {
    const host = io();
    expect(handleAmicodeBridgeMessage({ source: "amicode", kind: "command", command: "amicode.reportBug" }, host)).toBe(true);
    await flush();
    const ran = (vscode.commands as unknown as { executed: string[] }).executed ?? [];
    expect(ran).toContain("amicode.reportBug");
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

describe("amicode bridge — bug-report lifecycle kinds (amicode#250)", () => {
  /** BridgeIo with the bug-report sink wired (the panels pass the manager's). */
  function ioWithSink(visible = true) {
    const host = io(visible);
    const filed: Array<{ sessionID: string; url: string }> = [];
    const closed: string[] = [];
    let pokes = 0;
    host.bugReport = {
      filed: (sessionID, url) => filed.push({ sessionID, url }),
      closed: (sessionID) => closed.push(sessionID),
      poke: () => {
        pokes += 1;
      },
    };
    return { host, filed, closed, pokes: () => pokes };
  }

  it("bug-filed routes sessionID + url to the sink (the browser-fallback token included)", () => {
    const { host, filed } = ioWithSink();
    expect(
      handleAmicodeBridgeMessage({ source: "amicode", kind: "bug-filed", sessionID: "ses_1", url: "https://github.com/x/issues/1" }, host),
    ).toBe(true);
    expect(
      handleAmicodeBridgeMessage({ source: "amicode", kind: "bug-filed", sessionID: "ses_2", url: "filed-via-browser" }, host),
    ).toBe(true);
    expect(filed).toEqual([
      { sessionID: "ses_1", url: "https://github.com/x/issues/1" },
      { sessionID: "ses_2", url: "filed-via-browser" },
    ]);
  });

  it("bug-report-closed routes the sessionID to the sink", () => {
    const { host, closed } = ioWithSink();
    expect(handleAmicodeBridgeMessage({ source: "amicode", kind: "bug-report-closed", sessionID: "ses_9" }, host)).toBe(true);
    expect(closed).toEqual(["ses_9"]);
  });

  it("bug-report-poke routes to the sink's catch-up (consumed, payload-free)", () => {
    const { host, pokes } = ioWithSink();
    expect(handleAmicodeBridgeMessage({ source: "amicode", kind: "bug-report-poke" }, host)).toBe(true);
    expect(pokes()).toBe(1);
    // Without a sink: still consumed, never foreign-noise.
    expect(handleAmicodeBridgeMessage({ source: "amicode", kind: "bug-report-poke" }, io())).toBe(true);
  });

  it("malformed lifecycle envelopes are consumed and dropped — the sink never fires", () => {
    const { host, filed, closed } = ioWithSink();
    expect(handleAmicodeBridgeMessage({ source: "amicode", kind: "bug-filed", url: "https://x.test/1" }, host)).toBe(true);
    expect(handleAmicodeBridgeMessage({ source: "amicode", kind: "bug-filed", sessionID: 7, url: "u" }, host)).toBe(true);
    expect(handleAmicodeBridgeMessage({ source: "amicode", kind: "bug-report-closed" }, host)).toBe(true);
    expect(filed).toEqual([]);
    expect(closed).toEqual([]);
  });

  it("without a sink the kinds are still consumed (never fall through to foreign-envelope logging)", () => {
    const host = io();
    expect(handleAmicodeBridgeMessage({ source: "amicode", kind: "bug-filed", sessionID: "ses_1", url: "u" }, host)).toBe(true);
    expect(handleAmicodeBridgeMessage({ source: "amicode", kind: "bug-report-closed", sessionID: "ses_1" }, host)).toBe(true);
  });
});

describe("extractReportBugModel — the command's optional model payload (amicode#249)", () => {
  it("passes a well-formed selection; strips malformed ones; tolerates absence", () => {
    expect(extractReportBugModel({ model: { providerID: "opencode-go", modelID: "kimi-k3", variant: "default" } })).toEqual({
      providerID: "opencode-go",
      modelID: "kimi-k3",
      variant: "default",
    });
    expect(extractReportBugModel({ model: { providerID: "opencode-go", modelID: "kimi-k3" } })).toEqual({
      providerID: "opencode-go",
      modelID: "kimi-k3",
    });
    expect(extractReportBugModel({})).toBeUndefined();
    expect(extractReportBugModel({ model: "kimi-k3" })).toBeUndefined();
    expect(extractReportBugModel({ model: { providerID: 7, modelID: "x" } })).toBeUndefined();
    expect(extractReportBugModel({ model: { providerID: "p" } })).toBeUndefined();
  });
});
