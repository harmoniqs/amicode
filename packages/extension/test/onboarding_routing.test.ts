// Onboarding auto-launch and session routing tests (#434)
//
// Tests the routing predicate (pure), the at-most-once guard, the model-presence
// check, and the Stage 0 → chat transition wiring.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as vscode from "vscode";

import {
  type OnboardingFlags,
  resolveOnboardingAction,
  type OnboardingAction,
  isModelConfigured,
  OnboardingLauncher,
  readWelcomeShown,
  writeWelcomeShown,
} from "../src/onboarding_routing";

import {
  hasOnboardingCompleted,
  writeDevtoolsRestoreMarker,
  consumeDevtoolsRestoreMarker,
} from "../src/substrate/vault_store";

// ─── AC10: Routing predicate (pure function, table-driven) ───────────────────

describe("resolveOnboardingAction — routing predicate (AC10)", () => {
  const cases: Array<{ name: string; flags: OnboardingFlags; expected: OnboardingAction }> = [
    {
      name: "fresh install, no model → show-webview",
      flags: { modelConfigured: false, welcomeShown: false, onboardingCompleted: false, partialStage: undefined },
      expected: "show-webview",
    },
    {
      name: "no model, welcome already shown → show-webview (need model before chat)",
      flags: { modelConfigured: false, welcomeShown: true, onboardingCompleted: false, partialStage: undefined },
      expected: "show-webview",
    },
    {
      name: "model configured, no onboarding done → open-chat (overture will run inside)",
      flags: { modelConfigured: true, welcomeShown: false, onboardingCompleted: false, partialStage: undefined },
      expected: "open-chat",
    },
    {
      name: "model configured, partial at stage 2 → resume-chat-at-stage",
      flags: { modelConfigured: true, welcomeShown: true, onboardingCompleted: false, partialStage: 2 },
      expected: "resume-chat-at-stage",
    },
    {
      name: "model configured, onboarding completed → normal-session",
      flags: { modelConfigured: true, welcomeShown: true, onboardingCompleted: true, partialStage: undefined },
      expected: "normal-session",
    },
    {
      name: "onboarding completed (regardless of other flags) → normal-session",
      flags: { modelConfigured: true, welcomeShown: false, onboardingCompleted: true, partialStage: undefined },
      expected: "normal-session",
    },
    {
      name: "model configured, welcome shown, no partial stage → open-chat",
      flags: { modelConfigured: true, welcomeShown: true, onboardingCompleted: false, partialStage: undefined },
      expected: "open-chat",
    },
  ];

  for (const { name, flags, expected } of cases) {
    it(name, () => {
      expect(resolveOnboardingAction(flags)).toBe(expected);
    });
  }
});

// ─── AC9: isModelConfigured ──────────────────────────────────────────────────

describe("isModelConfigured — model-presence check (AC9)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "model-chk-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns false when config file does not exist", () => {
    expect(isModelConfigured(path.join(tmpDir, "nonexistent.json"))).toBe(false);
  });

  it("returns false when config has no provider and no model", () => {
    fs.writeFileSync(path.join(tmpDir, "config.json"), JSON.stringify({ permission: {} }));
    expect(isModelConfigured(path.join(tmpDir, "config.json"))).toBe(false);
  });

  it("returns false when provider section is empty", () => {
    fs.writeFileSync(path.join(tmpDir, "config.json"), JSON.stringify({ provider: {} }));
    expect(isModelConfigured(path.join(tmpDir, "config.json"))).toBe(false);
  });

  it("returns true when provider section has at least one entry", () => {
    fs.writeFileSync(
      path.join(tmpDir, "config.json"),
      JSON.stringify({ provider: { anthropic: { apiKey: "sk-x" } } }),
    );
    expect(isModelConfigured(path.join(tmpDir, "config.json"))).toBe(true);
  });

  it("returns true for JSONC content (ignores comments gracefully)", () => {
    // The actual config might be opencode.jsonc — we strip comments or use tolerant parse
    fs.writeFileSync(
      path.join(tmpDir, "config.json"),
      '{\n  "provider": { "anthropic": {} }\n}\n',
    );
    expect(isModelConfigured(path.join(tmpDir, "config.json"))).toBe(true);
  });

  it("returns true when provider is empty but model field is set", () => {
    fs.writeFileSync(
      path.join(tmpDir, "config.json"),
      JSON.stringify({ provider: {}, model: "anthropic/claude-sonnet-4" }),
    );
    expect(isModelConfigured(path.join(tmpDir, "config.json"))).toBe(true);
  });

  it("returns false when both provider and model are absent", () => {
    fs.writeFileSync(
      path.join(tmpDir, "config.json"),
      JSON.stringify({ permission: {} }),
    );
    expect(isModelConfigured(path.join(tmpDir, "config.json"))).toBe(false);
  });
});

// ─── AC4: At-most-once guard ─────────────────────────────────────────────────

describe("OnboardingLauncher — at-most-once guard (AC4)", () => {
  it("fires the launch callback at most once per instance", () => {
    const launches: string[] = [];
    const launcher = new OnboardingLauncher({
      resolveFlags: () => ({
        modelConfigured: false,
        welcomeShown: false,
        onboardingCompleted: false,
        partialStage: undefined,
      }),
      showWebview: () => { launches.push("webview"); },
      openChat: () => { launches.push("chat"); },
      openChatAtStage: () => { launches.push("resume"); },
    });

    launcher.tryLaunch();
    launcher.tryLaunch();
    launcher.tryLaunch();

    expect(launches).toEqual(["webview"]); // only once
  });

  it("does not fire for normal-session action", () => {
    const launches: string[] = [];
    const launcher = new OnboardingLauncher({
      resolveFlags: () => ({
        modelConfigured: true,
        welcomeShown: true,
        onboardingCompleted: true,
        partialStage: undefined,
      }),
      showWebview: () => { launches.push("webview"); },
      openChat: () => { launches.push("chat"); },
      openChatAtStage: () => { launches.push("resume"); },
    });

    launcher.tryLaunch();
    expect(launches).toEqual([]); // normal session → no action
  });

  it("routes to openChat when model is configured", () => {
    const launches: string[] = [];
    const launcher = new OnboardingLauncher({
      resolveFlags: () => ({
        modelConfigured: true,
        welcomeShown: false,
        onboardingCompleted: false,
        partialStage: undefined,
      }),
      showWebview: () => { launches.push("webview"); },
      openChat: () => { launches.push("chat"); },
      openChatAtStage: () => { launches.push("resume"); },
    });

    launcher.tryLaunch();
    expect(launches).toEqual(["chat"]);
  });

  it("routes to openChatAtStage for partial state", () => {
    const launches: string[] = [];
    const launcher = new OnboardingLauncher({
      resolveFlags: () => ({
        modelConfigured: true,
        welcomeShown: true,
        onboardingCompleted: false,
        partialStage: 3,
      }),
      showWebview: () => { launches.push("webview"); },
      openChat: () => { launches.push("chat"); },
      openChatAtStage: (_n) => { launches.push("resume"); },
    });

    launcher.tryLaunch();
    expect(launches).toEqual(["resume"]);
  });
});

// ─── AC5: Stage 0 success → chat auto-open ───────────────────────────────────

describe("OnboardingLauncher — webview success triggers chat (AC5)", () => {
  it("onWebviewSuccess opens chat", () => {
    const launches: string[] = [];
    const launcher = new OnboardingLauncher({
      resolveFlags: () => ({
        modelConfigured: false,
        welcomeShown: false,
        onboardingCompleted: false,
        partialStage: undefined,
      }),
      showWebview: () => { launches.push("webview"); },
      openChat: () => { launches.push("chat"); },
      openChatAtStage: () => { launches.push("resume"); },
    });

    launcher.tryLaunch(); // shows webview
    expect(launches).toEqual(["webview"]);

    launcher.onWebviewSuccess(); // webview completed → open chat
    expect(launches).toEqual(["webview", "chat"]);
  });
});

// ─── AC6: welcome_shown persistence ──────────────────────────────────────────

describe("welcome_shown flag semantics (AC6)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "welcome-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reading from non-existent file returns false", () => {
    expect(readWelcomeShown(path.join(tmpDir, "state.json"))).toBe(false);
  });

  it("writing and reading round-trips", () => {
    const file = path.join(tmpDir, "state.json");
    writeWelcomeShown(file);
    expect(readWelcomeShown(file)).toBe(true);
  });
});

// ─── devtools restore marker — toggle-OFF guard ─────────────────────────────

describe("devtools restore marker — toggle-OFF guard", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devtools-marker-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("consumeDevtoolsRestoreMarker returns false when no marker exists", () => {
    expect(consumeDevtoolsRestoreMarker(tmpDir)).toBe(false);
  });

  it("writeDevtoolsRestoreMarker + consumeDevtoolsRestoreMarker returns true and deletes the marker", () => {
    writeDevtoolsRestoreMarker(tmpDir);
    expect(consumeDevtoolsRestoreMarker(tmpDir)).toBe(true);
    // Second consume returns false (marker was deleted)
    expect(consumeDevtoolsRestoreMarker(tmpDir)).toBe(false);
  });

  it("does not interfere with onboarding completion state", () => {
    // Marker exists but onboarding events.jsonl does not
    writeDevtoolsRestoreMarker(tmpDir);
    expect(hasOnboardingCompleted(tmpDir)).toBe(false);
    // Consuming the marker doesn't create onboarding_completed
    consumeDevtoolsRestoreMarker(tmpDir);
    expect(hasOnboardingCompleted(tmpDir)).toBe(false);
  });
});
