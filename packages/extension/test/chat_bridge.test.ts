import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as vscode from "vscode";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handleAmicodeBridgeMessage, extractReportBugModel, resolveDbBackupDir, type BridgeIo } from "../src/chat_bridge";

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

describe("amicode bridge — reportBug model handoff (amicode#277)", () => {
  it("carries the composer's live model selection onto the command (AC1)", async () => {
    const host = io();
    let received: unknown;
    const cmd = vscode.commands.registerCommand("amicode.reportBug", (model: unknown) => {
      received = model;
    });
    handleAmicodeBridgeMessage(
      { source: "amicode", kind: "command", command: "amicode.reportBug", model: { providerID: "openai", modelID: "gpt-4o" } },
      host,
    );
    await flush();
    expect(received).toEqual({ providerID: "openai", modelID: "gpt-4o" });
    cmd.dispose();
  });

  it("variant travels with the selection (AC2)", async () => {
    const host = io();
    let received: unknown;
    const cmd = vscode.commands.registerCommand("amicode.reportBug", (model: unknown) => {
      received = model;
    });
    handleAmicodeBridgeMessage(
      {
        source: "amicode",
        kind: "command",
        command: "amicode.reportBug",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4", variant: "thinking" },
      },
      host,
    );
    await flush();
    expect(received).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-4", variant: "thinking" });
    cmd.dispose();
  });

  it("malformed, oversized, or absent payload never blocks — falls back to no model (AC4)", async () => {
    const host = io();
    let received: unknown = "sentinel";
    const cmd = vscode.commands.registerCommand("amicode.reportBug", (model: unknown) => {
      received = model;
    });
    // malformed: missing modelID
    handleAmicodeBridgeMessage({ source: "amicode", kind: "command", command: "amicode.reportBug", model: { providerID: "openai" } }, host);
    await flush();
    expect(received).toBeUndefined();
    // oversized
    received = "sentinel";
    handleAmicodeBridgeMessage(
      { source: "amicode", kind: "command", command: "amicode.reportBug", model: { providerID: "x".repeat(201), modelID: "gpt-4o" } },
      host,
    );
    await flush();
    expect(received).toBeUndefined();
    // absent
    received = "sentinel";
    handleAmicodeBridgeMessage({ source: "amicode", kind: "command", command: "amicode.reportBug" }, host);
    await flush();
    expect(received).toBeUndefined();
    cmd.dispose();
  });

  it("payload is shape-validated and length-bounded at the bridge (AC5)", async () => {
    expect(extractReportBugModel({ model: { providerID: "a".repeat(201), modelID: "b" } })).toBeUndefined();
    expect(extractReportBugModel({ model: { providerID: "", modelID: "b" } })).toBeUndefined();
    expect(extractReportBugModel({ model: { providerID: "a", modelID: "b", variant: "x".repeat(201) } })).toEqual({
      providerID: "a",
      modelID: "b",
    });
  });

  it("no additional command gains a payload channel and the allowlist is unchanged in size (AC7)", async () => {
    const { BRIDGE_ALLOWED_COMMANDS } = await import("../src/chat_bridge");
    // amicode#653 added amicode.restartHub (payload-free, like restartServer).
    expect(BRIDGE_ALLOWED_COMMANDS.size).toBe(11);
    expect(BRIDGE_ALLOWED_COMMANDS.has("amicode.reportBug")).toBe(true);
    expect(BRIDGE_ALLOWED_COMMANDS.has("amicode.restartHub")).toBe(true);
    // other allowlisted commands ignore model payload
    const host = io();
    let received: unknown = "sentinel";
    const cmd = vscode.commands.registerCommand("amicode.restartServer", (model: unknown) => {
      received = model;
    });
    handleAmicodeBridgeMessage(
      { source: "amicode", kind: "command", command: "amicode.restartServer", model: { providerID: "openai", modelID: "gpt-4o" } },
      host,
    );
    await flush();
    expect(received).toBeUndefined();
    cmd.dispose();
  });
});

describe("amicode bridge — clipboard-image-read", () => {
  it("reads a clipboard image via native tools and replies with a data URL", async () => {
    const host = io();
    const handled = handleAmicodeBridgeMessage(
      { source: "amicode", kind: "clipboard-image-read", nonce: "img-1", tab: "pane-2" },
      host,
    );
    expect(handled).toBe(true);
    // The handler is async (spawns a native process); wait for it to complete.
    // Multiple ticks needed: dynamic import + process spawn + result processing.
    for (let i = 0; i < 60 && host.posted.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(host.posted).toHaveLength(1);
    const reply = host.posted[0] as Record<string, unknown>;
    expect(reply.source).toBe("amicode");
    expect(reply.kind).toBe("clipboard-image");
    expect(reply.nonce).toBe("img-1");
    expect(reply.tab).toBe("pane-2");
    // dataUrl is either null (no image) or a valid data URL with image content
    if (reply.dataUrl !== null) {
      expect(typeof reply.dataUrl).toBe("string");
      expect((reply.dataUrl as string).startsWith("data:image/")).toBe(true);
      expect(typeof reply.mime).toBe("string");
      expect((reply.mime as string).startsWith("image/")).toBe(true);
      expect(typeof reply.filename).toBe("string");
    }
  });

  it("a hidden panel never answers clipboard-image-read", async () => {
    const host = io(false);
    const handled = handleAmicodeBridgeMessage(
      { source: "amicode", kind: "clipboard-image-read", nonce: "img-2" },
      host,
    );
    expect(handled).toBe(true);
    await flush();
    expect(host.posted).toHaveLength(0);
  });
});

describe("amicode bridge — data-storage-query uses XDG helpers (#563)", () => {
  let origXdgData: string | undefined;
  let origXdgConfig: string | undefined;

  beforeEach(() => {
    origXdgData = process.env.XDG_DATA_HOME;
    origXdgConfig = process.env.XDG_CONFIG_HOME;
  });
  afterEach(() => {
    if (origXdgData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = origXdgData;
    if (origXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = origXdgConfig;
  });

  it("returns paths based on XDG_DATA_HOME and XDG_CONFIG_HOME when set", () => {
    process.env.XDG_DATA_HOME = "/custom/data";
    process.env.XDG_CONFIG_HOME = "/custom/config";
    const host = io();
    const handled = handleAmicodeBridgeMessage(
      { source: "amicode", kind: "data-storage-query", tab: "t1" },
      host,
    );
    expect(handled).toBe(true);
    expect(host.posted).toHaveLength(1);
    const reply = host.posted[0] as Record<string, unknown>;
    expect(reply.kind).toBe("data-storage-defaults");
    expect(reply.databasePath).toBe("/custom/data/opencode/opencode.db");
    expect(reply.configDir).toBe("/custom/config/opencode");
    expect(reply.tab).toBe("t1");
  });
});

describe("amicode bridge — backup dir resolution (#563)", () => {
  it("resolveDbBackupDir uses path.dirname of sessionDatabase when set", () => {
    const dir = resolveDbBackupDir("/custom/path/to/mydb.db");
    expect(dir).toBe("/custom/path/to");
  });

  it("resolveDbBackupDir falls back to opencodeDataDir() when sessionDatabase is empty", () => {
    const origXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = "/xdg/data";
    try {
      const dir = resolveDbBackupDir("");
      expect(dir).toBe("/xdg/data/opencode");
    } finally {
      if (origXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = origXdg;
    }
  });
});
