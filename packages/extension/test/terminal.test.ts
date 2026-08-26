// terminal.test.ts — #564: verify OPENCODE_DB and OPENCODE_CONFIG_DIR are
// injected from VS Code settings into the Amicode Terminal environment.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import * as vscode from "vscode";
import { registerAmicodeTerminal, type AmicodeTerminalDeps } from "../src/terminal";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

const FAKE_HOME = "/home/testuser";

function makeDeps(overrides?: Partial<AmicodeTerminalDeps>): AmicodeTerminalDeps {
  return {
    extensionPath: "/fake/ext",
    getConfigContent: () => undefined,
    getSpawnEnv: () => ({}),
    channel: vscode.window.createOutputChannel("test") as any,
    ...overrides,
  };
}

/** Override the vscode mock's getConfiguration to return specific values. */
function mockSettings(settings: Record<string, string>) {
  vi.spyOn(vscode.workspace, "getConfiguration").mockImplementation((_section?: string) => ({
    get: (key: string, defaultValue?: unknown) => {
      return settings[key] ?? defaultValue ?? "";
    },
    update: () => Promise.resolve(),
  }) as any);
}

let terminalSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.spyOn(os, "homedir").mockReturnValue(FAKE_HOME);
  terminalSpy = vi.spyOn(vscode.window, "createTerminal");
  // By default, make fs.existsSync return false (no vendor binary, no fleet files)
  vi.mocked(existsSync).mockReturnValue(false);
  vi.mocked(readFileSync).mockReturnValue("{}");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("terminal env injection — OPENCODE_DB and OPENCODE_CONFIG_DIR", () => {
  it("injects OPENCODE_DB when amicode.sessionDatabase is non-empty", async () => {
    mockSettings({ sessionDatabase: "/custom/path/opencode.db", configDir: "" });

    const ctx = { subscriptions: [] as any[] } as unknown as vscode.ExtensionContext;
    registerAmicodeTerminal(ctx, makeDeps());
    await vscode.commands.executeCommand("amicode.openAmicodeTerminal");

    expect(terminalSpy).toHaveBeenCalledTimes(1);
    const opts = terminalSpy.mock.calls[0][0] as any;
    expect(opts.env.OPENCODE_DB).toBe("/custom/path/opencode.db");
    expect(opts.env.OPENCODE_CONFIG_DIR).toBeUndefined();
  });

  it("injects OPENCODE_CONFIG_DIR when amicode.configDir is non-empty", async () => {
    mockSettings({ sessionDatabase: "", configDir: "/custom/config" });

    const ctx = { subscriptions: [] as any[] } as unknown as vscode.ExtensionContext;
    registerAmicodeTerminal(ctx, makeDeps());
    await vscode.commands.executeCommand("amicode.openAmicodeTerminal");

    expect(terminalSpy).toHaveBeenCalledTimes(1);
    const opts = terminalSpy.mock.calls[0][0] as any;
    expect(opts.env.OPENCODE_CONFIG_DIR).toBe("/custom/config");
    expect(opts.env.OPENCODE_DB).toBeUndefined();
  });

  it("injects both vars when both settings are non-empty", async () => {
    mockSettings({ sessionDatabase: "/my/db.sqlite", configDir: "/my/config" });

    const ctx = { subscriptions: [] as any[] } as unknown as vscode.ExtensionContext;
    registerAmicodeTerminal(ctx, makeDeps());
    await vscode.commands.executeCommand("amicode.openAmicodeTerminal");

    expect(terminalSpy).toHaveBeenCalledTimes(1);
    const opts = terminalSpy.mock.calls[0][0] as any;
    expect(opts.env.OPENCODE_DB).toBe("/my/db.sqlite");
    expect(opts.env.OPENCODE_CONFIG_DIR).toBe("/my/config");
  });

  it("does not inject either var when both settings are empty", async () => {
    mockSettings({ sessionDatabase: "", configDir: "" });

    const ctx = { subscriptions: [] as any[] } as unknown as vscode.ExtensionContext;
    registerAmicodeTerminal(ctx, makeDeps());
    await vscode.commands.executeCommand("amicode.openAmicodeTerminal");

    expect(terminalSpy).toHaveBeenCalledTimes(1);
    const opts = terminalSpy.mock.calls[0][0] as any;
    expect(opts.env.OPENCODE_DB).toBeUndefined();
    expect(opts.env.OPENCODE_CONFIG_DIR).toBeUndefined();
  });
});
