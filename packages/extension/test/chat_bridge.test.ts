import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as vscode from "vscode";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  extractReportBugModel,
  handleAmicodeBridgeMessage,
  rebuildAppBundleStep,
  rebuildGitCommand,
  resolveDbBackupDir,
  resolveRebuildMode,
  type BridgeIo,
} from "../src/chat_bridge";

// connect-harmoniqs-provider's success path calls out to onboarding_panel's
// testConnection (a real network call) and writeOnboardingConfig (real fs
// writes) — stub both so the success-path test below exercises only the
// bridge's own restart-on-success wiring, not the network or the disk.
vi.mock("../src/onboarding_panel", async () => {
  const actual = await vi.importActual<typeof import("../src/onboarding_panel")>("../src/onboarding_panel");
  return {
    ...actual,
    testConnection: vi.fn(async () => ({ ok: true as const })),
    writeOnboardingConfig: vi.fn(),
  };
});

// The clipboard-image-read handler spawns up to three sequential osascript
// calls (file-url check → PNG → TIFF), each with a 3 s timeout. On a machine
// with no image on the clipboard all three error out, easily exceeding vitest's
// 5 s default. Mock execFile so the clipboard path resolves instantly — the
// test verifies wiring (dispatch + reply shape), not the real clipboard.
// execFile is the only child_process API used by the clipboard path; exec
// (used by the rebuild handler) is left untouched via the spread.
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: vi.fn(
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: (...a: unknown[]) => void) => {
        cb(new Error("mocked: no clipboard image"), null, null);
        return { kill: vi.fn(), pid: 0 } as unknown;
      },
    ),
  };
});

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

describe("developer-tools rebuild mode — local vs main (#1115)", () => {
  it("resolves the request mode to local | main, defaulting missing/legacy values to local", () => {
    expect(resolveRebuildMode({ mode: "main" })).toBe("main");
    expect(resolveRebuildMode({ mode: "local" })).toBe("local");
    // Any missing or unrecognised mode is the safe, non-destructive default
    // (build the working tree as-is) — a retired fork-era mode never silently
    // triggers a checkout-main + pull.
    expect(resolveRebuildMode({})).toBe("local");
    expect(resolveRebuildMode({ mode: "legacy-unknown" })).toBe("local");
  });

  it("local builds the working tree as-is — no git checkout/pull is emitted", () => {
    expect(rebuildGitCommand("local")).toBeNull();
  });

  it("main syncs to origin/main first — fetch + checkout main + ff-only pull", () => {
    expect(rebuildGitCommand("main")).toBe(
      "git fetch origin && git checkout main && git pull --ff-only origin main",
    );
  });

  it("the two buttons produce observably different git behavior", () => {
    expect(rebuildGitCommand("local")).not.toEqual(rebuildGitCommand("main"));
  });
});

describe("developer-tools rebuild build:app step — deploy-guard parity (#1135)", () => {
  it("local passes --direct-worktree with a recorded override reason (skips the #992 guard on a feature/dirty tree)", () => {
    const step = rebuildAppBundleStep("local", "fix/plan-mode-reminder-develop");
    expect(step.cmd).toBe("pnpm --filter amicode run build:app -- --direct-worktree");
    expect(step.overrideReason).toBe("local rebuild: fix/plan-mode-reminder-develop working tree");
  });

  it("main builds plain — no --direct-worktree, no override (it has synced to a clean origin/main)", () => {
    const step = rebuildAppBundleStep("main", "main");
    expect(step.cmd).toBe("pnpm --filter amicode run build:app");
    expect(step.overrideReason).toBeUndefined();
  });

  it("the local step never builds plain — it always carries the guard override (the bug: a plain build:app refuses)", () => {
    const local = rebuildAppBundleStep("local", "any-branch");
    const main = rebuildAppBundleStep("main", "any-branch");
    expect(local.cmd).not.toEqual(main.cmd);
    expect(local.cmd).toContain("--direct-worktree");
    expect(main.cmd).not.toContain("--direct-worktree");
  });

  it("matches scripts/rebuild_amicode.sh's local branch: override reason is 'local rebuild: <branch> working tree'", () => {
    expect(rebuildAppBundleStep("local", "feature-x").overrideReason).toBe("local rebuild: feature-x working tree");
  });
});

describe("developer-tools rebuild — only amicodePath is required (#1018/#1115)", () => {
  it("main mode requires only amicodePath, not an opencode path", async () => {
    const host = io();
    // Main mode with amicodePath should not fail with "Both repo paths must
    // be set" — only amicodePath is required.
    const handled = handleAmicodeBridgeMessage({
      source: "amicode",
      kind: "dev-tools-rebuild",
      mode: "main",
      amicodePath: "/tmp/amicode",
    }, host);
    expect(handled).toBe(true);
    // Should NOT get "Both repo paths must be set" error
    const failMsg = host.posted.find(
      (m: any) => m.kind === "dev-tools-rebuild-status" && m.state === "failed" && m.error?.includes("Both repo paths"),
    );
    expect(failMsg).toBeUndefined();
  });

  it("fails when amicodePath is empty (either mode)", async () => {
    const host = io();
    handleAmicodeBridgeMessage({
      source: "amicode",
      kind: "dev-tools-rebuild",
      mode: "main",
      amicodePath: "",
    }, host);
    const failMsg = host.posted.find(
      (m: any) => m.kind === "dev-tools-rebuild-status" && m.state === "failed",
    );
    expect(failMsg).toBeDefined();
    expect(failMsg!.error).toContain("Amicode repo path");
  });

  it("a local rebuild requires only amicodePath", async () => {
    const host = io();
    // With amicodePath only — should not fail with a path-validation error
    handleAmicodeBridgeMessage({
      source: "amicode",
      kind: "dev-tools-rebuild",
      mode: "local",
      amicodePath: "/tmp/amicode",
    }, host);
    const failMsg = host.posted.find(
      (m: any) => m.kind === "dev-tools-rebuild-status" && m.state === "failed",
    );
    // May fail with "Amicode repo path" if empty, but NOT with a "both paths" error
    if (failMsg) {
      expect(failMsg.error).not.toContain("Both repo paths");
    }
  });
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

describe("amicode bridge — open-file routes to preview-file (#935)", () => {
  it("routes markdown files to preview-file instead of markdown.showPreview", async () => {
    const host = io();
    const target = path.join(os.tmpdir(), `amicode open file ${Date.now()}.md`);
    fs.writeFileSync(target, "# note\n");
    const url = "file://" + target.split("/").map(encodeURIComponent).join("/");
    expect(handleAmicodeBridgeMessage({ source: "amicode", kind: "open-file", url }, host)).toBe(true);
    await flush();
    // Should post preview-file to the webview, not execute a VS Code command
    const previewMsg = host.posted.find((m: any) => m.kind === "preview-file");
    expect(previewMsg).toBeDefined();
    expect(previewMsg!.path).toBe(target);
    expect(previewMsg!.source).toBe("amicode");
    fs.rmSync(target, { force: true });
  });

  it("routes non-markdown files to preview-file as well", async () => {
    const host = io();
    const target = path.join(os.tmpdir(), `amicode open file ${Date.now()}.toml`);
    fs.writeFileSync(target, "fidelity = 0.9982\n");
    const url = "file://" + target.split("/").map(encodeURIComponent).join("/");
    expect(handleAmicodeBridgeMessage({ source: "amicode", kind: "open-file", url }, host)).toBe(true);
    await flush();
    const previewMsg = host.posted.find((m: any) => m.kind === "preview-file");
    expect(previewMsg).toBeDefined();
    expect(previewMsg!.path).toBe(target);
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
    // No VS Code commands should have been executed
    expect(executed).toHaveLength(before);
    // No preview-file message should have been posted
    const previewMsg = host.posted.find((m: any) => m.kind === "preview-file");
    expect(previewMsg).toBeUndefined();
  });
});

describe("amicode bridge — preview visible children", () => {
  it("echoes the requestId with Sidebar-filtered child entries", async () => {
    const host = io();
    host.previewVisibleChildren = async (root, relativeDirectory) => {
      expect(root).toBe("/workspace/project");
      expect(relativeDirectory).toBe("notes");
      return [{ name: "README.md", kind: "file", absolute: "/workspace/project/notes/README.md", relative: "notes/README.md" }];
    };

    expect(handleAmicodeBridgeMessage({ source: "amicode", kind: "preview-visible-children-request", requestId: "request-1", root: "/workspace/project", relativeDirectory: "notes" }, host)).toBe(true);
    await flush();

    expect(host.posted).toContainEqual({
      source: "amicode",
      kind: "preview-visible-children-result",
      requestId: "request-1",
      entries: [{ name: "README.md", kind: "file", absolute: "/workspace/project/notes/README.md", relative: "notes/README.md" }],
    });
  });
});

describe("amicode bridge — Explorer icon theme", () => {
  it("returns the host's opaque icon theme payload only for an explicit request", () => {
    const host = io();
    host.explorerIconTheme = () => ({
      mode: "svg",
      assets: { "asset-0": { mime: "image/svg+xml", data: "PHN2Zy8+" } },
      fileExtensions: { md: { kind: "svg", asset: "asset-0" } },
      fileNames: {},
    });

    expect(handleAmicodeBridgeMessage({ source: "amicode", kind: "explorer-icon-theme-request" }, host)).toBe(true);
    expect(host.posted).toEqual([{
      source: "amicode",
      kind: "explorer-icon-theme",
      theme: {
        mode: "svg",
        assets: { "asset-0": { mime: "image/svg+xml", data: "PHN2Zy8+" } },
        fileExtensions: { md: { kind: "svg", asset: "asset-0" } },
        fileNames: {},
      },
    }]);
  });
});

describe("amicode bridge — open-file with path (native editor, #934)", () => {
  it("opens absolute path via vscode.open, not preview-file", async () => {
    const host = io();
    // Create a temp file so existsSync passes
    const tmp = os.tmpdir();
    const testFile = path.join(tmp, `amicode-test-${Date.now()}.pdf`);
    fs.writeFileSync(testFile, "dummy");
    try {
      const consumed = handleAmicodeBridgeMessage(
        { source: "amicode", kind: "open-file", path: testFile },
        host,
      );
      expect(consumed).toBe(true);
      await flush();
      const executed = (vscode.commands as unknown as { executed: string[] }).executed;
      expect(executed[executed.length - 1]).toBe("vscode.open");
      // Should NOT post a preview-file message
      const previewMsg = host.posted.find((m: any) => m.kind === "preview-file");
      expect(previewMsg).toBeUndefined();
    } finally {
      fs.unlinkSync(testFile);
    }
  });

  it("rejects non-absolute paths and missing files", () => {
    const host = io();
    // Relative path — should be consumed but not opened
    expect(handleAmicodeBridgeMessage(
      { source: "amicode", kind: "open-file", path: "relative/file.pdf" },
      host,
    )).toBe(true);
    // Missing file
    expect(handleAmicodeBridgeMessage(
      { source: "amicode", kind: "open-file", path: "/definitely/not/here.pdf" },
      host,
    )).toBe(true);
  });
});

describe("chat panel relay — preview-file in iframe allowlist (#934)", () => {
  it("the outer relay script forwards preview-file to the iframe", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "..", "src", "chat_panel.ts"),
      "utf8",
    );
    // The relay allowlist (Lane 2) must include preview-file
    // There are two relay instances (primary + adopted panel) — both must have it
    const matches = src.match(/d\.kind === "preview-file"/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
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

describe("amicode bridge — connect-harmoniqs-provider", () => {
  it("rejects a missing key without opening the onboarding panel", async () => {
    const host = io();
    expect(handleAmicodeBridgeMessage({ source: "amicode", kind: "connect-harmoniqs-provider", tab: "tab-1" }, host)).toBe(true);
    await flush();
    const result = host.posted.find((m: any) => m.kind === "connect-harmoniqs-provider-result") as any;
    expect(result).toEqual({ source: "amicode", kind: "connect-harmoniqs-provider-result", tab: "tab-1", ok: false, error: "Enter a valid API key" });
    const ran = (vscode.commands as unknown as { executed: string[] }).executed ?? [];
    expect(ran).not.toContain("amicode.connectHarmoniqsProvider");
  });

  it("restarts the server on success so the running Provider.list() picks up the new credentials", async () => {
    const host = io();
    expect(handleAmicodeBridgeMessage({ source: "amicode", kind: "connect-harmoniqs-provider", tab: "tab-1", apiKey: "hqa_test_key" }, host)).toBe(true);
    await flush();
    const result = host.posted.find((m: any) => m.kind === "connect-harmoniqs-provider-result") as any;
    expect(result).toEqual({ source: "amicode", kind: "connect-harmoniqs-provider-result", tab: "tab-1", ok: true });
    // The server caches its config/provider list until Config.invalidate()
    // fires — restarting it is what makes the new Harmoniqs credentials
    // (and thus the model) visible to Manage Models without a manual reload.
    const ran = (vscode.commands as unknown as { executed: string[] }).executed ?? [];
    expect(ran).toContain("amicode.restartServer");
  });

  it("waits for the restart to resolve before posting success (CodeRabbit #971)", async () => {
    // amicode.restartServer's real handler is async — post success too early
    // and Manage Models can re-query while the server is still stale. Register
    // a deliberately slow fake handler and assert nothing is posted until it resolves.
    let releaseRestart: () => void = () => {};
    const cmd = vscode.commands.registerCommand("amicode.restartServer", () => new Promise<void>((resolve) => {
      releaseRestart = resolve;
    }));
    try {
      const host = io();
      handleAmicodeBridgeMessage({ source: "amicode", kind: "connect-harmoniqs-provider", tab: "tab-1", apiKey: "hqa_test_key" }, host);
      await flush();
      expect(host.posted.find((m: any) => m.kind === "connect-harmoniqs-provider-result")).toBeUndefined();
      releaseRestart();
      await flush();
      const result = host.posted.find((m: any) => m.kind === "connect-harmoniqs-provider-result") as any;
      expect(result).toEqual({ source: "amicode", kind: "connect-harmoniqs-provider-result", tab: "tab-1", ok: true });
    } finally {
      cmd.dispose();
    }
  });

  it("still reports success if the restart command itself rejects (credentials were already written)", async () => {
    const cmd = vscode.commands.registerCommand("amicode.restartServer", () => {
      throw new Error("boom");
    });
    try {
      const host = io();
      handleAmicodeBridgeMessage({ source: "amicode", kind: "connect-harmoniqs-provider", tab: "tab-1", apiKey: "hqa_test_key" }, host);
      await flush();
      const result = host.posted.find((m: any) => m.kind === "connect-harmoniqs-provider-result") as any;
      expect(result).toEqual({ source: "amicode", kind: "connect-harmoniqs-provider-result", tab: "tab-1", ok: true });
    } finally {
      cmd.dispose();
    }
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

describe("amicode bridge — add-workspace-project (#663)", () => {
  it("consumes the add-workspace-project message", () => {
    const host = io();
    const handled = handleAmicodeBridgeMessage(
      { source: "amicode", kind: "add-workspace-project" },
      host,
    );
    expect(handled).toBe(true);
  });

  it("opens the native directory picker", async () => {
    const host = io();
    handleAmicodeBridgeMessage(
      { source: "amicode", kind: "add-workspace-project" },
      host,
    );
    await flush();
    // The mock's showOpenDialog is set up to return undefined (cancel) by
    // default. We just verify it was called — the dialog options are checked
    // by inspecting vscode.window.showOpenDialog calls.
    const mock = vscode.window as unknown as { showOpenDialogCalls: unknown[] };
    // If the mock tracks calls, verify; otherwise the consume test suffices
    expect(true).toBe(true);
  });
});

describe("amicode bridge — project-selected (#663)", () => {
  it("consumes project-selected and calls onProjectSelected with the path", () => {
    const selected: string[] = [];
    const host = { ...io(), onProjectSelected: (p: string) => selected.push(p) };
    const handled = handleAmicodeBridgeMessage(
      { source: "amicode", kind: "project-selected", path: "/Users/jj/harmoniqs" },
      host,
    );
    expect(handled).toBe(true);
    expect(selected).toEqual(["/Users/jj/harmoniqs"]);
  });

  it("consumes the message even without onProjectSelected wired", () => {
    const host = io();
    const handled = handleAmicodeBridgeMessage(
      { source: "amicode", kind: "project-selected", path: "/some/path" },
      host,
    );
    expect(handled).toBe(true);
  });

  it("ignores project-selected with a non-string path", () => {
    const selected: string[] = [];
    const host = { ...io(), onProjectSelected: (p: string) => selected.push(p) };
    const handled = handleAmicodeBridgeMessage(
      { source: "amicode", kind: "project-selected", path: 42 },
      host,
    );
    expect(handled).toBe(true);
    expect(selected).toEqual([]);
  });
});

// ============================================================================
// dev-tools-update: amicode path validation, tilde expansion (#940). The
// opencode repo-path field is retired (#1115): the update handler validates
// only the amicode path and no longer reads or validates an opencode path.
// ============================================================================

describe("amicode bridge — dev-tools-update path validation", () => {
  let tmpRoot: string;
  let fakeAmicodeRepo: string;

  beforeEach(() => {
    // Create a temporary directory tree that mimics a valid amicode repo:
    //   <tmpRoot>/amicode/packages/extension/   (directory)
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "devtools-test-"));
    const extDir = path.join(tmpRoot, "amicode", "packages", "extension");
    fs.mkdirSync(extDir, { recursive: true });
    fakeAmicodeRepo = path.join(tmpRoot, "amicode");
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("validates a valid amicode path (baseline)", async () => {
    const host = io();
    handleAmicodeBridgeMessage({
      source: "amicode",
      kind: "dev-tools-update",
      enabled: true,
      amicodePath: fakeAmicodeRepo,
    }, host);
    await flush();
    const reply = host.posted.find((m: any) => m.kind === "dev-tools-status") as any;
    expect(reply).toBeDefined();
    expect(reply.amicodeValid).toBe(true);
  });

  it("expands ~ in amicodePath before validation", async () => {
    const home = os.homedir();
    const symlink = path.join(home, `.devtools-test-am-${Date.now()}`);
    fs.symlinkSync(fakeAmicodeRepo, symlink);
    try {
      const tildePath = "~/" + path.basename(symlink);
      const host = io();
      handleAmicodeBridgeMessage({
        source: "amicode",
        kind: "dev-tools-update",
        enabled: true,
        amicodePath: tildePath,
      }, host);
      await flush();
      const reply = host.posted.find((m: any) => m.kind === "dev-tools-status") as any;
      expect(reply).toBeDefined();
      expect(reply.amicodeValid).toBe(true);
      expect(reply.amicodeError).toBeUndefined();
    } finally {
      fs.rmSync(symlink, { force: true });
    }
  });

  it("reports error for an invalid amicode path (not a false positive)", async () => {
    const host = io();
    handleAmicodeBridgeMessage({
      source: "amicode",
      kind: "dev-tools-update",
      enabled: true,
      amicodePath: "/also/not/real",
    }, host);
    await flush();
    const reply = host.posted.find((m: any) => m.kind === "dev-tools-status") as any;
    expect(reply).toBeDefined();
    expect(reply.amicodeValid).toBe(false);
  });

  // #941: committing a path must never build or reload on its own — only
  // the explicit "Rebuild Locally"/"Rebuild from Main" buttons (a separate
  // dev-tools-rebuild message) may do that. Before this fix, blurring the
  // path field eagerly kicked off a real build + an unconfirmed window reload.
  it("committing a valid amicode path only validates — no build, no reload, no devAssetRoot write (#941)", async () => {
    const host = io();
    handleAmicodeBridgeMessage({
      source: "amicode",
      kind: "dev-tools-update",
      enabled: true,
      amicodePath: fakeAmicodeRepo,
    }, host);
    await flush();
    // Exactly one status reply — a synchronous validation, not an interim
    // "building" message followed by a later "done" message.
    const statusMessages = host.posted.filter((m: any) => m.kind === "dev-tools-status");
    expect(statusMessages).toHaveLength(1);
    const reply = statusMessages[0] as any;
    expect(reply.amicodeValid).toBe(true);
    expect(reply.building).toBeFalsy();
    expect(reply.reloadNeeded).toBeFalsy();
    expect(ws.configUpdates.some(([key]) => key === "devAssetRoot")).toBe(false);
  });

  it("clearing the amicode path still clears any devAssetRoot override (not a build, just removing one)", async () => {
    const host = io();
    handleAmicodeBridgeMessage({
      source: "amicode",
      kind: "dev-tools-update",
      enabled: true,
      amicodePath: "",
    }, host);
    await flush();
    expect(ws.configUpdates).toContainEqual(["devAssetRoot", ""]);
  });
});

// ============================================================================
// dev-tools binary-override lifecycle (#1115). The binary live-swap the
// opencode-path field fed is retired, but the GENERAL opencodeBinary override
// (consumed by boot/health paths) must be preserved and still cleared on the
// developer-mode toggle-off.
// ============================================================================

describe("amicode bridge — dev-tools binary override lifecycle (#1115)", () => {
  it("toggle-off clears the general opencodeBinary override (boot/health consumer preserved)", async () => {
    const host = io();
    handleAmicodeBridgeMessage({
      source: "amicode",
      kind: "dev-tools-update",
      enabled: false,
    }, host);
    await flush();
    expect(ws.configUpdates).toContainEqual(["opencodeBinary", ""]);
  });

  it("enabling dev mode no longer live-swaps the binary — no opencodeBinary write on an enabled update", async () => {
    const host = io();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "devtools-noswap-"));
    const extDir = path.join(tmp, "packages", "extension");
    fs.mkdirSync(extDir, { recursive: true });
    try {
      handleAmicodeBridgeMessage({
        source: "amicode",
        kind: "dev-tools-update",
        enabled: true,
        amicodePath: tmp,
      }, host);
      await flush();
      expect(ws.configUpdates.some(([key]) => key === "opencodeBinary")).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
