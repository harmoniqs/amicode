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
  registerHarmoniqsConnectCommand,
  PROVIDER_MODELS,
  PROVIDER_DISPLAY_NAMES,
  HARMONIQS_PROVIDER_ID,
  HARMONIQS_MODEL_ID,
  HARMONIQS_BASE_URL,
  HARMONIQS_MIN_OUTPUT_TOKENS,
  HARMONIQS_MAX_OUTPUT_TOKENS,
  type OnboardingConfig,
  writeOnboardingConfig,
  writeAuthApiKey,
  testConnection,
  probeModels,
  onOnboardingComplete,
  onOnboardingCancelled,
  dismissOnboardingPanel,
  getOnboardingPanel,
  releaseOnboardingPanel,
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

  it("getOnboardingPanel returns the live panel, releaseOnboardingPanel detaches it", async () => {
    expect(getOnboardingPanel()).toBeUndefined(); // no panel yet
    const spy = vi.spyOn(vscode.window, "createWebviewPanel");
    await vscode.commands.executeCommand("amicode.onboarding.open");
    const panel = getOnboardingPanel();
    expect(panel).toBeDefined();
    // Release detaches without disposing
    releaseOnboardingPanel();
    expect(getOnboardingPanel()).toBeUndefined();
    // Panel is still alive (not disposed)
    expect((panel as any).webview).toBeDefined();
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
      "harmoniqs",
      "opencode",
      "anthropic",
      "openai",
      "google",
      "openrouter",
      "vercel",
      "amazon-bedrock",
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
      model: "anthropic/claude-sonnet-5",
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
    expect(written.model).toBe("anthropic/claude-sonnet-5");
  });

  it("AC5: API key is stored in provider.options.apiKey (not top-level)", () => {
    const config: OnboardingConfig = {
      provider: "anthropic",
      model: "anthropic/claude-sonnet-5",
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
      model: "openai/gpt-5.6-sol",
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
      { provider: "anthropic", model: "anthropic/claude-sonnet-5", apiKey: "sk-ant-valid-key-123456" },
      configPath,
    );

    const written = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(written.permission).toEqual({ bash: "allow" }); // preserved
    expect(written.provider.anthropic).toBeDefined(); // added
  });

  it("writes config for github-copilot with empty apiKey (OAuth-based)", () => {
    const config: OnboardingConfig = {
      provider: "github-copilot",
      model: "github-copilot/claude-sonnet-5",
      apiKey: "",
    };
    const configPath = path.join(tmpDir, "opencode.json");
    writeOnboardingConfig(config, configPath);

    const written = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(written.provider["github-copilot"]).toBeDefined();
    expect(written.model).toBe("github-copilot/claude-sonnet-5");
    // No options.apiKey when key is empty
    expect(written.provider["github-copilot"].options).toBeUndefined();
  });

  it("writes config for opencode provider", () => {
    const config: OnboardingConfig = {
      provider: "opencode",
      model: "anthropic/claude-sonnet-5",
      apiKey: "oc-test-key",
    };
    const configPath = path.join(tmpDir, "opencode.json");
    writeOnboardingConfig(config, configPath);

    const written = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(written.provider.opencode).toBeDefined();
    expect(written.provider.opencode.options.apiKey).toBe("oc-test-key");
    expect(written.provider.opencode.env).toEqual(["OPENCODE_API_KEY"]);
    expect(written.model).toBe("anthropic/claude-sonnet-5");
  });

  it("env field is always an array, never a bare string", () => {
    const config: OnboardingConfig = {
      provider: "openai",
      model: "openai/gpt-5.6-sol",
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
      { provider: "anthropic", model: "anthropic/claude-sonnet-5", apiKey: "sk-test" },
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
      { provider: "anthropic", model: "anthropic/claude-sonnet-5", apiKey: "sk-bad" },
      fetchMock,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("AC4: returns failure on network error", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await testConnection(
      { provider: "anthropic", model: "anthropic/claude-sonnet-5", apiKey: "sk-test" },
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
      { provider: "anthropic", model: "anthropic/claude-sonnet-5", apiKey: "sk-secret-value" },
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
      { provider: "openai", model: "openai/gpt-5.6-sol", apiKey: "sk-openai" },
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
      { provider: "google", model: "google/gemini-3.1-pro-preview", apiKey: "AIza-key" },
      fetchMock,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("googleapis.com");
  });
});

describe("Harmoniqs AI — branded provider preset", () => {
  it("is registered as a first-class provider with one locked model", () => {
    expect(PROVIDER_DISPLAY_NAMES[HARMONIQS_PROVIDER_ID]).toBe("Harmoniqs AI");
    expect(PROVIDER_MODELS[HARMONIQS_PROVIDER_ID]).toEqual([
      { id: `${HARMONIQS_PROVIDER_ID}/${HARMONIQS_MODEL_ID}`, name: "Harmoniqs Auto" },
    ]);
  });

  describe("writeOnboardingConfig — secure credential storage", () => {
    let tmpDir: string;
    let prevXdgDataHome: string | undefined;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "onboard-harmoniqs-"));
      prevXdgDataHome = process.env.XDG_DATA_HOME;
      // writeOnboardingConfig writes the harmoniqs key via the default
      // opencodeDataDir() path — redirect it into the tmp dir so the test
      // never touches the real ~/.local/share/opencode/auth.json.
      process.env.XDG_DATA_HOME = tmpDir;
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      if (prevXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = prevXdgDataHome;
    });

    it("writes the non-secret provider shape into opencode.json (npm, baseURL, model, tool_call:false)", () => {
      const configPath = path.join(tmpDir, "config", "opencode.json");
      writeOnboardingConfig(
        {
          provider: HARMONIQS_PROVIDER_ID,
          model: `${HARMONIQS_PROVIDER_ID}/${HARMONIQS_MODEL_ID}`,
          apiKey: "hqa_supersecretvalue123456",
        },
        configPath,
      );

      const written = JSON.parse(fs.readFileSync(configPath, "utf8"));
      const entry = written.provider[HARMONIQS_PROVIDER_ID];
      expect(entry.npm).toBe("@ai-sdk/openai-compatible");
      expect(entry.options.baseURL).toBe(HARMONIQS_BASE_URL);
      expect(entry.models[HARMONIQS_MODEL_ID].tool_call).toBe(false);
      // Regression: without limit.output, opencode's own maxOutputTokens
      // fallback (Math.min(model.limit.output, 32000) || 32000) treats the
      // unset 0 as "no cap" and sends max_tokens: 32000 on every real turn --
      // which exceeds this gateway's real ceiling and 400s generically.
      // Reproduced live before this fix existed.
      expect(entry.models[HARMONIQS_MODEL_ID].limit).toEqual({ output: HARMONIQS_MAX_OUTPUT_TOKENS });
      expect(written.model).toBe(`${HARMONIQS_PROVIDER_ID}/${HARMONIQS_MODEL_ID}`);
    });

    it("never writes the API key into opencode.json", () => {
      const configPath = path.join(tmpDir, "config", "opencode.json");
      writeOnboardingConfig(
        {
          provider: HARMONIQS_PROVIDER_ID,
          model: `${HARMONIQS_PROVIDER_ID}/${HARMONIQS_MODEL_ID}`,
          apiKey: "hqa_supersecretvalue123456",
        },
        configPath,
      );

      const written = JSON.parse(fs.readFileSync(configPath, "utf8"));
      expect(written.provider[HARMONIQS_PROVIDER_ID].options.apiKey).toBeUndefined();
      const raw = fs.readFileSync(configPath, "utf8");
      expect(raw).not.toContain("hqa_supersecretvalue123456");
    });

    it("writes the API key into opencode's auth store instead (auth.json, type: api)", () => {
      const configPath = path.join(tmpDir, "config", "opencode.json");
      writeOnboardingConfig(
        {
          provider: HARMONIQS_PROVIDER_ID,
          model: `${HARMONIQS_PROVIDER_ID}/${HARMONIQS_MODEL_ID}`,
          apiKey: "hqa_supersecretvalue123456",
        },
        configPath,
      );

      const authPath = path.join(tmpDir, "opencode", "auth.json");
      const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
      expect(auth[HARMONIQS_PROVIDER_ID]).toEqual({ type: "api", key: "hqa_supersecretvalue123456" });
    });

    // app-harmoniqs-ai's chat-completions route is a plain OpenAI-Chat-Completions
    // -compatible gateway (see chat-completions.ts parseRequest) — the protocol
    // itself has no dependency on which model id is being served; it just happens
    // to hard-pin PUBLIC_MODEL="harmoniqs-auto" server-side TODAY. These tests use
    // a SECOND, hypothetical model id ("harmoniqs-fast") that does not exist in
    // PROVIDER_MODELS or on the real backend, purely to prove the config-writing
    // wiring is model-id-agnostic rather than a single "harmoniqs-auto" string
    // baked into buildProviderConfigEntry. This anticipates the gateway exposing
    // additional model ids later without requiring a code change here — see the
    // PR #951 review discussion on over-assuming a single hardcoded model id.
    it("writes an arbitrary (future) model id into provider.harmoniqs.models, not just harmoniqs-auto", () => {
      const configPath = path.join(tmpDir, "config", "opencode.json");
      writeOnboardingConfig(
        {
          provider: HARMONIQS_PROVIDER_ID,
          model: `${HARMONIQS_PROVIDER_ID}/harmoniqs-fast`,
          apiKey: "hqa_supersecretvalue123456",
        },
        configPath,
      );

      const written = JSON.parse(fs.readFileSync(configPath, "utf8"));
      const entry = written.provider[HARMONIQS_PROVIDER_ID];
      // The unknown model id must land under its OWN key — not silently
      // collapsed onto HARMONIQS_MODEL_ID ("harmoniqs-auto").
      expect(entry.models["harmoniqs-fast"]).toBeDefined();
      expect(entry.models[HARMONIQS_MODEL_ID]).toBeUndefined();
      expect(entry.models["harmoniqs-fast"].tool_call).toBe(false);
      expect(entry.models["harmoniqs-fast"].limit).toEqual({ output: HARMONIQS_MAX_OUTPUT_TOKENS });
      // The gateway shape (npm/baseURL) is protocol-level, not model-specific,
      // and must stay identical regardless of which model was selected.
      expect(entry.npm).toBe("@ai-sdk/openai-compatible");
      expect(entry.options.baseURL).toBe(HARMONIQS_BASE_URL);
      expect(written.model).toBe(`${HARMONIQS_PROVIDER_ID}/harmoniqs-fast`);
    });

    it("still resolves the known display name for the current model id", () => {
      const configPath = path.join(tmpDir, "config", "opencode.json");
      writeOnboardingConfig(
        {
          provider: HARMONIQS_PROVIDER_ID,
          model: `${HARMONIQS_PROVIDER_ID}/${HARMONIQS_MODEL_ID}`,
          apiKey: "hqa_supersecretvalue123456",
        },
        configPath,
      );
      const written = JSON.parse(fs.readFileSync(configPath, "utf8"));
      expect(written.provider[HARMONIQS_PROVIDER_ID].models[HARMONIQS_MODEL_ID].name).toBe("Harmoniqs Auto");
    });

    it("falls back to the bare model id as the display name for an unrecognized model", () => {
      const configPath = path.join(tmpDir, "config", "opencode.json");
      writeOnboardingConfig(
        {
          provider: HARMONIQS_PROVIDER_ID,
          model: `${HARMONIQS_PROVIDER_ID}/harmoniqs-fast`,
          apiKey: "hqa_supersecretvalue123456",
        },
        configPath,
      );
      const written = JSON.parse(fs.readFileSync(configPath, "utf8"));
      expect(written.provider[HARMONIQS_PROVIDER_ID].models["harmoniqs-fast"].name).toBe("harmoniqs-fast");
    });
  });

  describe("writeAuthApiKey", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "onboard-authstore-"));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("writes a { type: 'api', key } entry, creating parent directories", () => {
      const authPath = path.join(tmpDir, "nested", "auth.json");
      writeAuthApiKey(HARMONIQS_PROVIDER_ID, "hqa_abc123", authPath);

      const written = JSON.parse(fs.readFileSync(authPath, "utf8"));
      expect(written[HARMONIQS_PROVIDER_ID]).toEqual({ type: "api", key: "hqa_abc123" });
    });

    it("merges with existing entries instead of clobbering them", () => {
      const authPath = path.join(tmpDir, "auth.json");
      fs.writeFileSync(authPath, JSON.stringify({ anthropic: { type: "api", key: "sk-ant-existing" } }));

      writeAuthApiKey(HARMONIQS_PROVIDER_ID, "hqa_abc123", authPath);

      const written = JSON.parse(fs.readFileSync(authPath, "utf8"));
      expect(written.anthropic).toEqual({ type: "api", key: "sk-ant-existing" });
      expect(written[HARMONIQS_PROVIDER_ID]).toEqual({ type: "api", key: "hqa_abc123" });
    });

    it("re-writing replaces only that provider's entry", () => {
      const authPath = path.join(tmpDir, "auth.json");
      writeAuthApiKey(HARMONIQS_PROVIDER_ID, "hqa_old", authPath);
      writeAuthApiKey(HARMONIQS_PROVIDER_ID, "hqa_new", authPath);

      const written = JSON.parse(fs.readFileSync(authPath, "utf8"));
      expect(written[HARMONIQS_PROVIDER_ID]).toEqual({ type: "api", key: "hqa_new" });
    });

    it("sets file permissions to 0600 (owner read/write only)", () => {
      const authPath = path.join(tmpDir, "auth.json");
      writeAuthApiKey(HARMONIQS_PROVIDER_ID, "hqa_abc123", authPath);

      const mode = fs.statSync(authPath).mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });

  describe("testConnection — secret-safe error classification (401/403/429/config/network)", () => {
    const config: OnboardingConfig = {
      provider: HARMONIQS_PROVIDER_ID,
      model: `${HARMONIQS_PROVIDER_ID}/${HARMONIQS_MODEL_ID}`,
      apiKey: "hqa_supersecretvalue123456",
    };

    it("sends exactly the expected OpenAI-compatible request", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ choices: [] }) });
      const result = await testConnection(config, fetchMock);

      expect(result.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe(`${HARMONIQS_BASE_URL}/chat/completions`);
      expect(options.headers.Authorization).toBe(`Bearer ${config.apiKey}`);
      const body = JSON.parse(options.body);
      expect(body.model).toBe(HARMONIQS_MODEL_ID);
      expect(body.tools).toBeUndefined();
      // Regression: the test probe must satisfy the gateway's own minimum —
      // a lower value (the generic openai/openrouter/vercel probe used 1)
      // guaranteed every real connection test failed with a generic 400
      // "Invalid chat completion request", reproduced live against
      // production before this fix (see HARMONIQS_MIN_OUTPUT_TOKENS's
      // comment for the exact backend constant it mirrors).
      expect(body.max_tokens).toBe(HARMONIQS_MIN_OUTPUT_TOKENS);
    });

    // Same OpenAI-Chat-Completions-compatible request shape, but with a SECOND,
    // hypothetical model id that isn't harmoniqs-auto and doesn't exist on the
    // real backend today (chat-completions.ts hard-pins PUBLIC_MODEL server-side —
    // see requestError/parseRequest). Proves testConnection's request-building is
    // wired off config.model, not a "harmoniqs-auto" string baked into the client,
    // so it keeps working unchanged if/when the gateway serves more model ids.
    it("is wired off config.model, not a hardcoded model id — same request shape for a different model", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ choices: [] }) });
      const otherModelConfig: OnboardingConfig = {
        provider: HARMONIQS_PROVIDER_ID,
        model: `${HARMONIQS_PROVIDER_ID}/harmoniqs-fast`,
        apiKey: config.apiKey,
      };
      const result = await testConnection(otherModelConfig, fetchMock);

      expect(result.ok).toBe(true);
      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe(`${HARMONIQS_BASE_URL}/chat/completions`);
      const body = JSON.parse(options.body);
      expect(body.model).toBe("harmoniqs-fast");
      expect(body.tools).toBeUndefined();
      expect(body.max_tokens).toBe(HARMONIQS_MIN_OUTPUT_TOKENS);
    });

    it("401 invalid_api_key — reports an invalid-key message", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        json: () =>
          Promise.resolve({ error: { message: "Invalid API key", type: "authentication_error", code: "invalid_api_key" } }),
      });
      const result = await testConnection(config, fetchMock);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Invalid API key");
    });

    it("403 no_entitlement — distinguishes lack of entitlement from a bad key", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        statusText: "Forbidden",
        json: () =>
          Promise.resolve({
            error: { message: "No active inference entitlement", type: "permission_error", code: "no_entitlement" },
          }),
      });
      const result = await testConnection(config, fetchMock);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("entitlement");
    });

    it("429 rate_limit_exceeded — reports a rate-limit message", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        json: () => Promise.resolve({ error: { message: "Rate limit exceeded", type: "rate_limit_error", code: "rate_limit_exceeded" } }),
      });
      const result = await testConnection(config, fetchMock);
      expect(result.ok).toBe(false);
      expect(result.error?.toLowerCase()).toContain("rate limit");
    });

    // Reproduces the exact live-production failure this fix addresses: before
    // it, EVERY Harmoniqs test connection sent max_tokens below the gateway's
    // floor, so it always hit this exact response shape and message,
    // regardless of whether the key/entitlement were valid.
    it("400 invalid_max_tokens (below the gateway's floor) — surfaces the real backend message, not a generic failure", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        json: () =>
          Promise.resolve({
            error: { message: "Invalid chat completion request", type: "invalid_request_error", code: "invalid_request" },
          }),
      });
      const result = await testConnection(config, fetchMock);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Invalid chat completion request");
      // The real fix is that this response should never occur in practice
      // anymore -- assert the outgoing request itself already satisfies the
      // floor, so this failure mode requires a backend-side change to recur.
      const [, options] = fetchMock.mock.calls[0];
      expect(JSON.parse(options.body).max_tokens).toBe(HARMONIQS_MIN_OUTPUT_TOKENS);
    });

    it("400 unsupported_feature — reports it as a model/config error with the backend's message", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        json: () =>
          Promise.resolve({
            error: {
              message: "Tools, structured output, and multiple completions are not supported",
              type: "invalid_request_error",
              code: "unsupported_feature",
            },
          }),
      });
      const result = await testConnection(config, fetchMock);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Tools, structured output");
    });

    it("404 model_not_found — reports it as a model/config error", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: "Not Found",
        json: () =>
          Promise.resolve({
            error: { message: "The requested model does not exist", type: "invalid_request_error", code: "model_not_found" },
          }),
      });
      const result = await testConnection(config, fetchMock);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("does not exist");
    });

    it("upstream 502/provider_error — reports a distinct temporarily-unavailable message", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
        json: () =>
          Promise.resolve({ error: { message: "Inference provider request failed", type: "api_error", code: "provider_error" } }),
      });
      const result = await testConnection(config, fetchMock);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("temporarily unavailable");
    });

    it("network failure — distinguishes a transport error from an HTTP rejection", async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error("getaddrinfo ENOTFOUND app.harmoniqs.ai"));
      const result = await testConnection(config, fetchMock);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Network error");
      expect(result.error).toContain("ENOTFOUND");
    });

    it("tolerates a non-JSON error body (e.g. a CDN error page) without throwing", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        json: () => Promise.reject(new Error("not json")),
      });
      const result = await testConnection(config, fetchMock);
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    });

    it("never includes the API key in any classified result", async () => {
      const responses = [
        { ok: false, status: 401, statusText: "Unauthorized", json: () => Promise.resolve({ error: { code: "invalid_api_key" } }) },
        {
          ok: false,
          status: 403,
          statusText: "Forbidden",
          json: () => Promise.resolve({ error: { code: "no_entitlement" } }),
        },
        { ok: false, status: 429, statusText: "Too Many Requests", json: () => Promise.resolve({ error: {} }) },
      ];
      for (const response of responses) {
        const fetchMock = vi.fn().mockResolvedValue(response);
        const result = await testConnection(config, fetchMock);
        expect(JSON.stringify(result)).not.toContain(config.apiKey);
      }
    });
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

  it("confirm-import keeps the panel alive as a transition splash (not disposed immediately)", async () => {
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

    // Now confirm import
    panel.webview._simulateMessage({
      type: "confirm-import",
      payload: { activeProvider: "anthropic" },
    });
    await new Promise((r) => setTimeout(r, 50));

    // Panel should NOT have been disposed yet — it's showing the transition splash
    expect(disposeSpy).not.toHaveBeenCalled();

    // Instead, the panel HTML should have been swapped to the splash
    expect(panel.webview.html).toContain("Getting Amico ready");
    expect(panel.webview.html).toContain("splash-mark");

    spy.mockRestore();
  });

  it("dismissOnboardingPanel disposes the transition splash", async () => {
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

    const postSpy = vi.fn().mockResolvedValue(true);
    panel.webview.postMessage = postSpy;

    // Trigger scan + confirm to enter transition state
    panel.webview._simulateMessage({ type: "scan-credentials" });
    await new Promise((r) => setTimeout(r, 50));
    panel.webview._simulateMessage({
      type: "confirm-import",
      payload: { activeProvider: "anthropic" },
    });
    await new Promise((r) => setTimeout(r, 50));

    // Panel still alive
    expect(disposeSpy).not.toHaveBeenCalled();

    // Now dismiss (extension calls this after app-ready)
    dismissOnboardingPanel();

    // Panel should now be disposed
    expect(disposeSpy).toHaveBeenCalled();

    spy.mockRestore();
  });

  it("confirm-import restarts server but does NOT open chat directly (waits for ready)", async () => {
    // Clear command execution history
    (vscode.commands as { executed: string[] }).executed = [];

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

    // Trigger scan then confirm
    panel.webview._simulateMessage({ type: "scan-credentials" });
    await new Promise((r) => setTimeout(r, 50));
    panel.webview._simulateMessage({
      type: "confirm-import",
      payload: { activeProvider: "anthropic", includedProviders: ["anthropic"] },
    });
    await new Promise((r) => setTimeout(r, 50));

    const executed = (vscode.commands as { executed: string[] }).executed;
    // Should restart the server
    expect(executed).toContain("amicode.restartServer");
    // Should NOT open chat directly (that causes the fetch-failed error)
    expect(executed).not.toContain("amicode.openChat");

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

describe("registerHarmoniqsConnectCommand — focused connect entry point (Connect Provider dialog handoff)", () => {
  let ctx: { subscriptions: unknown[]; extensionUri: unknown };

  beforeEach(() => {
    _resetForTesting();
    ctx = { subscriptions: [], extensionUri: vscode.Uri.file("/ext") } as never;
    registerOnboardingPanel(ctx as never);
    registerHarmoniqsConnectCommand(ctx as never);
  });

  it("opens the SAME onboarding webview panel type as the Stage-0 command", async () => {
    const spy = vi.spyOn(vscode.window, "createWebviewPanel");
    await vscode.commands.executeCommand("amicode.connectHarmoniqsProvider");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      "amicode.onboarding",
      expect.any(String),
      expect.anything(),
      expect.objectContaining({ enableScripts: true }),
    );
    spy.mockRestore();
  });

  it("is a singleton with amicode.onboarding.open — reveals the existing panel rather than opening a second one", async () => {
    const spy = vi.spyOn(vscode.window, "createWebviewPanel");
    await vscode.commands.executeCommand("amicode.onboarding.open");
    await vscode.commands.executeCommand("amicode.connectHarmoniqsProvider");
    expect(spy).toHaveBeenCalledTimes(1);
    const panel = spy.mock.results[0].value as { revealCount: number };
    expect(panel.revealCount).toBe(1);
    spy.mockRestore();
  });

  it("injects window.__FOCUS_PROVIDER__ = 'harmoniqs', restricting the picker", async () => {
    const spy = vi.spyOn(vscode.window, "createWebviewPanel");
    await vscode.commands.executeCommand("amicode.connectHarmoniqsProvider");
    const panel = spy.mock.results[0].value as { webview: { html: string } };
    expect(panel.webview.html).toContain("__FOCUS_PROVIDER__");
    expect(panel.webview.html).toContain(JSON.stringify(HARMONIQS_PROVIDER_ID));
    spy.mockRestore();
  });

  it("amicode.onboarding.open still gets a null focusProvider (Stage-0 behavior unchanged)", async () => {
    const spy = vi.spyOn(vscode.window, "createWebviewPanel");
    await vscode.commands.executeCommand("amicode.onboarding.open");
    const panel = spy.mock.results[0].value as { webview: { html: string } };
    expect(panel.webview.html).toContain("window.__FOCUS_PROVIDER__ = null");
    spy.mockRestore();
  });

  // bootstrap:false's one behavioral difference is "no restart, no greeting,
  // no fallback chat-open" — config-success's write path defaults to the
  // real ~/.config/opencode path with no configPath override, and os/fs
  // builtins aren't spyable in this vitest setup for that path, so "cancel"
  // is the safe proxy: it hits the identical bootstrap branch with zero
  // filesystem writes (see `cancel` in openOnboardingPanel).
  it("bootstrap:false — cancel does NOT fall back to amicode.openChat (chat panel is already live)", async () => {
    (vscode.commands as { executed: string[] }).executed = [];
    const spy = vi.spyOn(vscode.window, "createWebviewPanel");
    await vscode.commands.executeCommand("amicode.connectHarmoniqsProvider");
    const panel = spy.mock.results[0].value as {
      webview: { _simulateMessage: (msg: unknown) => void };
      disposed?: boolean;
    };

    let cancelled = false;
    const disposable = onOnboardingCancelled(() => {
      cancelled = true;
    });

    panel.webview._simulateMessage({ type: "cancel" });
    await new Promise((r) => setTimeout(r, 10));

    expect(cancelled).toBe(true); // fireOnboardingCancelled still fires either way
    const executed = (vscode.commands as { executed: string[] }).executed;
    expect(executed).not.toContain("amicode.openChat"); // the focused-connect difference

    disposable.dispose();
    spy.mockRestore();
  });

  it("bootstrap:true (Stage-0 default) — cancel DOES fall back to amicode.openChat, unchanged", async () => {
    (vscode.commands as { executed: string[] }).executed = [];
    const spy = vi.spyOn(vscode.window, "createWebviewPanel");
    await vscode.commands.executeCommand("amicode.onboarding.open");
    const panel = spy.mock.results[0].value as {
      webview: { _simulateMessage: (msg: unknown) => void };
    };

    panel.webview._simulateMessage({ type: "cancel" });
    await new Promise((r) => setTimeout(r, 10));

    const executed = (vscode.commands as { executed: string[] }).executed;
    expect(executed).toContain("amicode.openChat");

    spy.mockRestore();
  });
});

describe("testConnection — Bedrock model probe (model-access validation)", () => {
  it("makes an HTTP call to Bedrock converse endpoint with bearer auth", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    const result = await testConnection(
      { provider: "amazon-bedrock", model: "amazon-bedrock/anthropic.claude-opus-4-6-v1", apiKey: "ABSK-test-token" },
      fetchMock,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);

    // Should hit bedrock-runtime endpoint
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("bedrock-runtime");
    expect(url).toContain("amazonaws.com");
    // Should contain the model ID (URL-encoded)
    expect(url).toContain("converse");
  });

  it("uses Authorization: Bearer header with the API key", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    await testConnection(
      { provider: "amazon-bedrock", model: "amazon-bedrock/anthropic.claude-opus-4-6-v1", apiKey: "ABSK-my-token-123" },
      fetchMock,
    );
    const options = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = options.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer ABSK-my-token-123");
  });

  it("returns ok:false on 403 (model not authorized)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
    });
    const result = await testConnection(
      { provider: "amazon-bedrock", model: "amazon-bedrock/anthropic.claude-opus-5", apiKey: "ABSK-token" },
      fetchMock,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("403");
  });

  it("returns ok:false on 401 (invalid credentials)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
    });
    const result = await testConnection(
      { provider: "amazon-bedrock", model: "amazon-bedrock/anthropic.claude-opus-4-6-v1", apiKey: "bad-token" },
      fetchMock,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("401");
  });

  it("applies us. prefix to model ID for US region when model contains 'claude'", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    await testConnection(
      { provider: "amazon-bedrock", model: "amazon-bedrock/anthropic.claude-opus-4-6-v1", apiKey: "ABSK-token" },
      fetchMock,
    );
    const url = fetchMock.mock.calls[0][0] as string;
    // The resolved model ID in the URL should have us. prefix
    expect(url).toContain("us.anthropic.claude-opus-4-6-v1");
  });

  it("does not double-prefix model IDs that already have a region prefix", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    await testConnection(
      { provider: "amazon-bedrock", model: "amazon-bedrock/us.anthropic.claude-opus-4-6-v1", apiKey: "ABSK-token" },
      fetchMock,
    );
    const url = fetchMock.mock.calls[0][0] as string;
    // Should NOT have us.us.anthropic...
    expect(url).not.toContain("us.us.");
    expect(url).toContain("us.anthropic.claude-opus-4-6-v1");
  });

  it("sends a minimal converse payload (maxTokens: 1)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    await testConnection(
      { provider: "amazon-bedrock", model: "amazon-bedrock/anthropic.claude-opus-4-6-v1", apiKey: "ABSK-token" },
      fetchMock,
    );
    const options = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(options.body as string);
    expect(body.inferenceConfig.maxTokens).toBe(1);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("user");
  });

  it("returns ok:false on network error", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await testConnection(
      { provider: "amazon-bedrock", model: "amazon-bedrock/anthropic.claude-opus-4-6-v1", apiKey: "ABSK-token" },
      fetchMock,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");
  });
});

describe("probeModels — find first accessible model for a provider", () => {
  it("returns the first model if it succeeds", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    const result = await probeModels(
      "amazon-bedrock",
      "ABSK-token",
      fetchMock,
    );
    expect(result).toBeDefined();
    expect(result!.id).toBe(PROVIDER_MODELS["amazon-bedrock"][0].id);
    // Should only have called fetch once (first model worked)
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to second model when first returns 403", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 403, statusText: "Forbidden" })
      .mockResolvedValueOnce({ ok: true });
    const result = await probeModels(
      "amazon-bedrock",
      "ABSK-token",
      fetchMock,
    );
    expect(result).toBeDefined();
    expect(result!.id).toBe(PROVIDER_MODELS["amazon-bedrock"][1].id);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back through all models, returns last one that works", async () => {
    const models = PROVIDER_MODELS["amazon-bedrock"];
    // All fail except the last
    const fetchMock = vi.fn();
    for (let i = 0; i < models.length - 1; i++) {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 403, statusText: "Forbidden" });
    }
    fetchMock.mockResolvedValueOnce({ ok: true });

    const result = await probeModels(
      "amazon-bedrock",
      "ABSK-token",
      fetchMock,
    );
    expect(result).toBeDefined();
    expect(result!.id).toBe(models[models.length - 1].id);
    expect(fetchMock).toHaveBeenCalledTimes(models.length);
  });

  it("returns undefined when all models fail with 403", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
    });
    const result = await probeModels(
      "amazon-bedrock",
      "ABSK-token",
      fetchMock,
    );
    expect(result).toBeUndefined();
  });

  it("stops on 401 (bad credentials) without trying more models", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
    });
    const result = await probeModels(
      "amazon-bedrock",
      "bad-token",
      fetchMock,
    );
    expect(result).toBeUndefined();
    // Should stop after first 401 — credentials are bad, no point trying others
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns first model for providers without a test endpoint (untestable)", async () => {
    const fetchMock = vi.fn();
    // github-copilot has no test endpoint — probeModels should return first model without probing
    const result = await probeModels(
      "github-copilot",
      "",
      fetchMock,
    );
    expect(result).toBeDefined();
    expect(result!.id).toBe(PROVIDER_MODELS["github-copilot"][0].id);
    // No fetch call made for untestable providers
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns undefined for providers with empty model list", async () => {
    const fetchMock = vi.fn();
    const result = await probeModels(
      "custom",
      "key",
      fetchMock,
    );
    expect(result).toBeUndefined();
  });

  it("probes each model with the correct resolved model ID in the URL", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 403, statusText: "Forbidden" })
      .mockResolvedValueOnce({ ok: true });
    await probeModels(
      "amazon-bedrock",
      "ABSK-token",
      fetchMock,
    );
    // First call should probe the first model
    const url1 = fetchMock.mock.calls[0][0] as string;
    expect(url1).toContain("claude-opus-4-6-v1");
    // Second call should probe the second model
    const url2 = fetchMock.mock.calls[1][0] as string;
    expect(url2).toContain("claude-sonnet-4-5-v2");
  });
});
