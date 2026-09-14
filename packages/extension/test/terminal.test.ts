// terminal.test.ts — #564: verify OPENCODE_DB and OPENCODE_CONFIG_DIR are
// injected from VS Code settings into the Amicode Terminal environment.
// #1149: verify the server password is sourced from the handshake, not the
// stale spawn environment.
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

describe("terminal password from handshake (#1149)", () => {
  it("uses the handshake password, not the stale spawn env password", async () => {
    mockSettings({ sessionDatabase: "", configDir: "" });

    const HANDSHAKE_PW = "live-handshake-password";
    const STALE_PW = "stale-spawn-env-password";

    const ctx = { subscriptions: [] as any[] } as unknown as vscode.ExtensionContext;
    registerAmicodeTerminal(
      ctx,
      makeDeps({
        getSpawnEnv: () => ({
          OPENCODE_SERVER_PASSWORD: STALE_PW,
          OPENCODE_SERVER_USERNAME: "user",
        }),
        getHandshakePassword: () => HANDSHAKE_PW,
      }),
    );
    await vscode.commands.executeCommand("amicode.openAmicodeTerminal");

    expect(terminalSpy).toHaveBeenCalledTimes(1);
    const opts = terminalSpy.mock.calls[0][0] as any;
    // Password comes from the handshake, not the spawn env
    expect(opts.env.OPENCODE_SERVER_PASSWORD).toBe(HANDSHAKE_PW);
  });

  it("falls back to spawn env password when handshake returns undefined", async () => {
    mockSettings({ sessionDatabase: "", configDir: "" });

    const STALE_PW = "stale-spawn-env-password";

    const ctx = { subscriptions: [] as any[] } as unknown as vscode.ExtensionContext;
    registerAmicodeTerminal(
      ctx,
      makeDeps({
        getSpawnEnv: () => ({
          OPENCODE_SERVER_PASSWORD: STALE_PW,
          OPENCODE_SERVER_USERNAME: "user",
        }),
        getHandshakePassword: () => undefined,
      }),
    );
    await vscode.commands.executeCommand("amicode.openAmicodeTerminal");

    expect(terminalSpy).toHaveBeenCalledTimes(1);
    const opts = terminalSpy.mock.calls[0][0] as any;
    // Falls back to spawn env when no handshake
    expect(opts.env.OPENCODE_SERVER_PASSWORD).toBe(STALE_PW);
  });

  it("password is never logged in the channel output", async () => {
    mockSettings({ sessionDatabase: "", configDir: "" });

    const HANDSHAKE_PW = "secret-handshake-password";
    const logLines: string[] = [];
    const mockChannel = {
      appendLine: (line: string) => logLines.push(line),
      append: () => {},
      dispose: () => {},
    } as unknown as vscode.OutputChannel;

    const ctx = { subscriptions: [] as any[] } as unknown as vscode.ExtensionContext;
    registerAmicodeTerminal(
      ctx,
      makeDeps({
        channel: mockChannel,
        getHandshakePassword: () => HANDSHAKE_PW,
      }),
    );
    await vscode.commands.executeCommand("amicode.openAmicodeTerminal");

    // No log line should contain the password
    for (const line of logLines) {
      expect(line).not.toContain(HANDSHAKE_PW);
    }
  });
});
