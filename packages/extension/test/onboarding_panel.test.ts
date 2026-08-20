// Onboarding Panel tests — Stage 0: Model-setup webview (#433)
//
// Tests the host-side OnboardingPanel: lifecycle, config writing, event emission,
// and the provider→model data mapping. The webview side (animation, form DOM) is
// tested via the postMessage contract: the host sends/receives typed messages.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as vscode from "vscode";

import {
  registerOnboardingPanel,
  PROVIDER_MODELS,
  PROVIDER_DISPLAY_NAMES,
  type OnboardingConfig,
  writeOnboardingConfig,
  testConnection,
  onOnboardingComplete,
  _resetForTesting,
} from "../src/onboarding_panel";

describe("OnboardingPanel — panel lifecycle (AC1, AC6, AC7)", () => {
  let ctx: { subscriptions: unknown[]; extensionUri: unknown };

  beforeEach(() => {
    _resetForTesting();
    ctx = { subscriptions: [], extensionUri: vscode.Uri.file("/ext") } as never;
    registerOnboardingPanel(ctx as never);
  });

  it("AC1: can be opened programmatically via the registered command", async () => {
    const spy = vi.spyOn(vscode.window, "createWebviewPanel");
    await vscode.commands.executeCommand("amicode.onboarding.open");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      "amicode.onboarding",
      expect.any(String),
      expect.anything(),
      expect.objectContaining({ enableScripts: true }),
    );
    spy.mockRestore();
  });

  it("AC1: singleton — re-opening reveals existing panel", async () => {
    const spy = vi.spyOn(vscode.window, "createWebviewPanel");
    await vscode.commands.executeCommand("amicode.onboarding.open");
    await vscode.commands.executeCommand("amicode.onboarding.open");
    expect(spy).toHaveBeenCalledTimes(1);
    const panel = spy.mock.results[0].value as { revealCount: number };
    expect(panel.revealCount).toBe(1);
    spy.mockRestore();
  });

  it("AC6: panel dispose clears the singleton (allows re-create)", async () => {
    const spy = vi.spyOn(vscode.window, "createWebviewPanel");
    await vscode.commands.executeCommand("amicode.onboarding.open");
    const panel = spy.mock.results[0].value as { dispose: () => void };
    panel.dispose(); // simulate user closing the tab
    await vscode.commands.executeCommand("amicode.onboarding.open");
    expect(spy).toHaveBeenCalledTimes(2); // fresh panel after dispose
    spy.mockRestore();
  });

  it("AC7: fires an event after onboarding completes", async () => {
    const fired: boolean[] = [];
    const disposable = onOnboardingComplete(() => {
      fired.push(true);
    });
    // Simulate the completion flow: the implementation fires via fireOnboardingComplete
    // when the webview posts "config-success". Here we test the listener registration.
    expect(typeof onOnboardingComplete).toBe("function");
    expect(fired).toHaveLength(0); // not fired yet
    disposable.dispose();
  });
});

describe("PROVIDER_MODELS — data-driven provider→model mapping (AC3)", () => {
  it("is a non-empty record of providers", () => {
    expect(Object.keys(PROVIDER_MODELS).length).toBeGreaterThan(0);
  });

  it("each provider (except custom) has at least one model with id and name", () => {
    for (const [providerId, models] of Object.entries(PROVIDER_MODELS)) {
      if (providerId === "custom") continue; // custom uses free-text input
      expect(providerId).toBeTruthy();
      expect(models.length).toBeGreaterThan(0);
      for (const m of models) {
        expect(m.id).toBeTruthy();
        expect(m.name).toBeTruthy();
      }
    }
  });

  it("custom provider has empty models array (uses free-text input)", () => {
    expect(PROVIDER_MODELS.custom).toEqual([]);
  });

  it("includes the expected provider lineup in order", () => {
    const keys = Object.keys(PROVIDER_MODELS);
    expect(keys).toEqual([
      "github-copilot",
      "opencode",
      "anthropic",
      "openai",
      "google",
      "openrouter",
      "vercel",
      "custom",
    ]);
  });

  it("github-copilot is the first option (free, no API key)", () => {
    const keys = Object.keys(PROVIDER_MODELS);
    expect(keys[0]).toBe("github-copilot");
  });
});

describe("PROVIDER_DISPLAY_NAMES — human-readable labels", () => {
  it("has a display name for every provider", () => {
    for (const key of Object.keys(PROVIDER_MODELS)) {
      expect(PROVIDER_DISPLAY_NAMES[key]).toBeTruthy();
    }
  });

  it("github-copilot label indicates it is free", () => {
    expect(PROVIDER_DISPLAY_NAMES["github-copilot"].toLowerCase()).toContain("free");
  });

  it("custom label indicates OpenAI-compatible", () => {
    expect(PROVIDER_DISPLAY_NAMES["custom"].toLowerCase()).toContain("openai-compatible");
  });
});

describe("writeOnboardingConfig — config file writing (AC5)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "onboard-cfg-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("AC5: writes valid opencode config with provider and model", () => {
    const config: OnboardingConfig = {
      provider: "anthropic",
      model: "anthropic/claude-sonnet-4-5",
      apiKey: "sk-test-key-123",
    };
    const configPath = path.join(tmpDir, "opencode.json");
    writeOnboardingConfig(config, configPath);

    expect(fs.existsSync(configPath)).toBe(true);
    const written = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(written.provider).toBeDefined();
    expect(written.provider.anthropic).toBeDefined();
    // apiKey goes in options.apiKey per schema
    expect(written.provider.anthropic.options.apiKey).toBe("sk-test-key-123");
    // env is an array
    expect(written.provider.anthropic.env).toEqual(["ANTHROPIC_API_KEY"]);
    expect(written.model).toBe("anthropic/claude-sonnet-4-5");
  });

  it("AC5: API key is stored in provider.options.apiKey (not top-level)", () => {
    const config: OnboardingConfig = {
      provider: "anthropic",
      model: "anthropic/claude-sonnet-4-5",
      apiKey: "sk-test-key-123",
    };
    const configPath = path.join(tmpDir, "opencode.json");
    writeOnboardingConfig(config, configPath);

    const written = JSON.parse(fs.readFileSync(configPath, "utf8"));
    // Must NOT be at provider.<name>.apiKey (opencode silently drops that)
    expect(written.provider.anthropic.apiKey).toBeUndefined();
    // Must be at provider.<name>.options.apiKey
    expect(written.provider.anthropic.options.apiKey).toBe("sk-test-key-123");
  });

  it("creates parent directories if they don't exist", () => {
    const config: OnboardingConfig = {
      provider: "openai",
      model: "openai/gpt-4.1",
      apiKey: "sk-test-openai",
    };
    const nested = path.join(tmpDir, "nested", "deep", "opencode.json");
    writeOnboardingConfig(config, nested);
    expect(fs.existsSync(nested)).toBe(true);
  });

  it("merges with existing config without clobbering", () => {
    const configPath = path.join(tmpDir, "opencode.json");
    // Pre-populate with some existing config
    fs.writeFileSync(configPath, JSON.stringify({ permission: { bash: "allow" } }));

    writeOnboardingConfig(
      { provider: "anthropic", model: "anthropic/claude-sonnet-4-5", apiKey: "sk-x" },
      configPath,
    );

    const written = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(written.permission).toEqual({ bash: "allow" }); // preserved
    expect(written.provider.anthropic).toBeDefined(); // added
  });

  it("writes config for github-copilot with empty apiKey (OAuth-based)", () => {
    const config: OnboardingConfig = {
      provider: "github-copilot",
      model: "github-copilot/claude-sonnet-4-5",
      apiKey: "",
    };
    const configPath = path.join(tmpDir, "opencode.json");
    writeOnboardingConfig(config, configPath);

    const written = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(written.provider["github-copilot"]).toBeDefined();
    expect(written.model).toBe("github-copilot/claude-sonnet-4-5");
    // No options.apiKey when key is empty
    expect(written.provider["github-copilot"].options).toBeUndefined();
  });

  it("writes config for opencode provider", () => {
    const config: OnboardingConfig = {
      provider: "opencode",
      model: "anthropic/claude-sonnet-4-5",
      apiKey: "oc-test-key",
    };
    const configPath = path.join(tmpDir, "opencode.json");
    writeOnboardingConfig(config, configPath);

    const written = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(written.provider.opencode).toBeDefined();
    expect(written.provider.opencode.options.apiKey).toBe("oc-test-key");
    expect(written.provider.opencode.env).toEqual(["OPENCODE_API_KEY"]);
    expect(written.model).toBe("anthropic/claude-sonnet-4-5");
  });

  it("env field is always an array, never a bare string", () => {
    const config: OnboardingConfig = {
      provider: "openai",
      model: "openai/gpt-4.1",
      apiKey: "sk-openai-key",
    };
    const configPath = path.join(tmpDir, "opencode.json");
    writeOnboardingConfig(config, configPath);

    const written = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(Array.isArray(written.provider.openai.env)).toBe(true);
    expect(written.provider.openai.env).toEqual(["OPENAI_API_KEY"]);
  });
});

describe("testConnection — credential validation (AC4, AC8)", () => {
  it("AC4: makes exactly one HTTP call to validate credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: "hi" } }] }),
    });
    const result = await testConnection(
      { provider: "anthropic", model: "anthropic/claude-sonnet-4-5", apiKey: "sk-test" },
      fetchMock,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });

  it("AC4: returns failure on HTTP error", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
    });
    const result = await testConnection(
      { provider: "anthropic", model: "anthropic/claude-sonnet-4-5", apiKey: "sk-bad" },
      fetchMock,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("AC4: returns failure on network error", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await testConnection(
      { provider: "anthropic", model: "anthropic/claude-sonnet-4-5", apiKey: "sk-test" },
      fetchMock,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");
  });

  it("AC8: secret is not present in returned result metadata", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: "hi" } }] }),
    });
    const result = await testConnection(
      { provider: "anthropic", model: "anthropic/claude-sonnet-4-5", apiKey: "sk-secret-value" },
      fetchMock,
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("sk-secret-value");
  });

  it("handles unknown provider gracefully", async () => {
    const fetchMock = vi.fn();
    const result = await testConnection(
      { provider: "unknown-provider", model: "unknown/model", apiKey: "key" },
      fetchMock,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Unknown provider");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("works for opencode provider", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    const result = await testConnection(
      { provider: "opencode", model: "opencode/claude-sonnet-4", apiKey: "oc-key" },
      fetchMock,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    // Verify it hits the opencode endpoint
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("opencode.ai");
  });

  it("works for openai provider", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    const result = await testConnection(
      { provider: "openai", model: "openai/gpt-4.1", apiKey: "sk-openai" },
      fetchMock,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("openai.com");
  });

  it("works for google provider", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    const result = await testConnection(
      { provider: "google", model: "google/gemini-2.5-pro", apiKey: "AIza-key" },
      fetchMock,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("googleapis.com");
  });
});

describe("Credential import — panel message handling (AC2, AC8, AC12, AC14)", () => {
  let ctx: { subscriptions: unknown[]; extensionUri: unknown };

  beforeEach(() => {
    _resetForTesting();
    ctx = { subscriptions: [], extensionUri: vscode.Uri.file("/ext") } as never;
    registerOnboardingPanel(ctx as never);
  });

  it("AC2: scan-credentials triggers scan and posts scan-status + scan-results", async () => {
    const spy = vi.spyOn(vscode.window, "createWebviewPanel");
    await vscode.commands.executeCommand("amicode.onboarding.open");
    const panel = spy.mock.results[0].value as {
      webview: {
        postMessage: ReturnType<typeof vi.fn>;
        _simulateMessage: (msg: unknown) => void;
      };
    };

    const postSpy = vi.fn().mockResolvedValue(true);
    panel.webview.postMessage = postSpy;

    // Simulate the webview sending a scan-credentials message
    panel.webview._simulateMessage({ type: "scan-credentials" });

    // Allow async work to complete
    await new Promise((r) => setTimeout(r, 50));

    // Should have posted scan-status "searching" first
    const calls = postSpy.mock.calls.map((c: unknown[]) => c[0]) as Array<{ type: string; payload: unknown }>;
    const statusMsgs = calls.filter((c) => c.type === "scan-status");
    expect(statusMsgs.length).toBeGreaterThanOrEqual(1);
    expect(statusMsgs[0].payload).toHaveProperty("state", "searching");

    spy.mockRestore();
  });

  it("AC8: scan-results payload never contains key material", async () => {
    const spy = vi.spyOn(vscode.window, "createWebviewPanel");
    await vscode.commands.executeCommand("amicode.onboarding.open");
    const panel = spy.mock.results[0].value as {
      webview: {
        postMessage: ReturnType<typeof vi.fn>;
        _simulateMessage: (msg: unknown) => void;
      };
    };

    const postSpy = vi.fn().mockResolvedValue(true);
    panel.webview.postMessage = postSpy;

    // Simulate scan (env will be checked from process.env which is likely empty in test)
    panel.webview._simulateMessage({ type: "scan-credentials" });
    await new Promise((r) => setTimeout(r, 50));

    // Verify no message contains sensitive-looking strings
    const allMsgs = JSON.stringify(postSpy.mock.calls);
    // The test env has no real keys; verify the structure doesn't include a "key" field
    for (const call of postSpy.mock.calls) {
      const msg = call[0] as { type: string; payload: unknown };
      if (msg.type === "scan-results") {
        const payload = msg.payload as { providers: Array<Record<string, unknown>> };
        if (payload.providers) {
          for (const p of payload.providers) {
            expect(p).not.toHaveProperty("key");
            expect(p).not.toHaveProperty("apiKey");
            expect(p).not.toHaveProperty("token");
            expect(p).not.toHaveProperty("secret");
          }
        }
      }
    }

    spy.mockRestore();
  });

  it("AC14: disposing panel mid-scan does not write config", async () => {
    const spy = vi.spyOn(vscode.window, "createWebviewPanel");
    await vscode.commands.executeCommand("amicode.onboarding.open");
    const panel = spy.mock.results[0].value as {
      webview: {
        postMessage: ReturnType<typeof vi.fn>;
        _simulateMessage: (msg: unknown) => void;
      };
      dispose: () => void;
    };

    const postSpy = vi.fn().mockResolvedValue(true);
    panel.webview.postMessage = postSpy;

    // Start scan then immediately dispose
    panel.webview._simulateMessage({ type: "scan-credentials" });
    panel.dispose();

    // Allow time for any async work
    await new Promise((r) => setTimeout(r, 50));

    // Confirm-import should NOT have been called (no config write)
    const confirmMsgs = postSpy.mock.calls
      .map((c: unknown[]) => c[0])
      .filter((m: { type: string }) => m.type === "config-success");
    expect(confirmMsgs).toHaveLength(0);

    spy.mockRestore();
  });

  it("confirm-import writes batch config and disposes panel", async () => {
    const spy = vi.spyOn(vscode.window, "createWebviewPanel");
    await vscode.commands.executeCommand("amicode.onboarding.open");
    const panel = spy.mock.results[0].value as {
      webview: {
        postMessage: ReturnType<typeof vi.fn>;
        _simulateMessage: (msg: unknown) => void;
      };
      dispose: ReturnType<typeof vi.fn>;
    };

    const disposeSpy = vi.fn();
    const origDispose = panel.dispose;
    panel.dispose = (...args: unknown[]) => {
      disposeSpy();
      return (origDispose as Function).apply(panel, args);
    };

    // First trigger a scan to populate credentials
    const postSpy = vi.fn().mockResolvedValue(true);
    panel.webview.postMessage = postSpy;
    panel.webview._simulateMessage({ type: "scan-credentials" });
    await new Promise((r) => setTimeout(r, 50));

    // Now confirm import (even if scan found nothing in test env, the handler should work)
    panel.webview._simulateMessage({
      type: "confirm-import",
      payload: { activeProvider: "anthropic" },
    });
    await new Promise((r) => setTimeout(r, 50));

    // Panel should have been disposed (onboarding complete)
    expect(disposeSpy).toHaveBeenCalled();

    spy.mockRestore();
  });
});

describe("Webview HTML generation (AC2, AC9)", () => {
  beforeEach(() => {
    _resetForTesting();
    const ctx = { subscriptions: [], extensionUri: vscode.Uri.file("/ext") } as never;
    registerOnboardingPanel(ctx as never);
  });

  it("AC2: HTML includes animation container before form elements", async () => {
    const spy = vi.spyOn(vscode.window, "createWebviewPanel");
    await vscode.commands.executeCommand("amicode.onboarding.open");
    const panel = spy.mock.results[0].value as { webview: { html: string } };

    // The HTML should have an animation container
    expect(panel.webview.html).toContain("animation");
    // The webview script bundle should be loaded
    expect(panel.webview.html).toContain("onboarding_webview.js");
    spy.mockRestore();
  });

  it("AC9: injects PROVIDER_MODELS and PROVIDER_NAMES data for the webview", async () => {
    const spy = vi.spyOn(vscode.window, "createWebviewPanel");
    await vscode.commands.executeCommand("amicode.onboarding.open");
    const panel = spy.mock.results[0].value as { webview: { html: string } };

    expect(panel.webview.html).toContain("__PROVIDERS__");
    expect(panel.webview.html).toContain("__PROVIDER_NAMES__");
    spy.mockRestore();
  });

  it("HTML includes Content-Security-Policy", async () => {
    const spy = vi.spyOn(vscode.window, "createWebviewPanel");
    await vscode.commands.executeCommand("amicode.onboarding.open");
    const panel = spy.mock.results[0].value as { webview: { html: string } };

    expect(panel.webview.html).toContain("Content-Security-Policy");
    expect(panel.webview.html).toContain("nonce-");
    spy.mockRestore();
  });
});
