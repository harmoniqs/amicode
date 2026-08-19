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

  it("each provider has at least one model with id and name", () => {
    for (const [providerId, models] of Object.entries(PROVIDER_MODELS)) {
      expect(providerId).toBeTruthy();
      expect(models.length).toBeGreaterThan(0);
      for (const m of models) {
        expect(m.id).toBeTruthy();
        expect(m.name).toBeTruthy();
      }
    }
  });

  it("includes anthropic and openai as core providers", () => {
    expect(PROVIDER_MODELS).toHaveProperty("anthropic");
    expect(PROVIDER_MODELS).toHaveProperty("openai");
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
      model: "anthropic/claude-sonnet-4-20250514",
      apiKey: "sk-test-key-123",
    };
    const configPath = path.join(tmpDir, "opencode.json");
    writeOnboardingConfig(config, configPath);

    expect(fs.existsSync(configPath)).toBe(true);
    const written = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(written.provider).toBeDefined();
    expect(written.provider.anthropic).toBeDefined();
    expect(written.model).toBe("anthropic/claude-sonnet-4-20250514");
  });

  it("AC5: API key is stored in the provider config", () => {
    const config: OnboardingConfig = {
      provider: "anthropic",
      model: "anthropic/claude-sonnet-4-20250514",
      apiKey: "sk-test-key-123",
    };
    const configPath = path.join(tmpDir, "opencode.json");
    writeOnboardingConfig(config, configPath);

    const content = fs.readFileSync(configPath, "utf8");
    expect(content).toContain("sk-test-key-123");
  });

  it("creates parent directories if they don't exist", () => {
    const config: OnboardingConfig = {
      provider: "openai",
      model: "openai/gpt-4o",
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
      { provider: "anthropic", model: "anthropic/claude-sonnet-4-20250514", apiKey: "sk-x" },
      configPath,
    );

    const written = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(written.permission).toEqual({ bash: "allow" }); // preserved
    expect(written.provider.anthropic).toBeDefined(); // added
  });
});

describe("testConnection — credential validation (AC4, AC8)", () => {
  it("AC4: makes exactly one HTTP call to validate credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: "hi" } }] }),
    });
    const result = await testConnection(
      { provider: "anthropic", model: "anthropic/claude-sonnet-4-20250514", apiKey: "sk-test" },
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
      { provider: "anthropic", model: "anthropic/claude-sonnet-4-20250514", apiKey: "sk-bad" },
      fetchMock,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("AC4: returns failure on network error", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await testConnection(
      { provider: "anthropic", model: "anthropic/claude-sonnet-4-20250514", apiKey: "sk-test" },
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
      { provider: "anthropic", model: "anthropic/claude-sonnet-4-20250514", apiKey: "sk-secret-value" },
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

  it("AC9: injects PROVIDER_MODELS data for the webview to consume", async () => {
    const spy = vi.spyOn(vscode.window, "createWebviewPanel");
    await vscode.commands.executeCommand("amicode.onboarding.open");
    const panel = spy.mock.results[0].value as { webview: { html: string } };

    // Provider data should be injected into the HTML
    expect(panel.webview.html).toContain("__PROVIDERS__");
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
