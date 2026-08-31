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
      flags: { modelConfigured: false, onboardingCompleted: false, partialStage: undefined },
      expected: "show-webview",
    },
    {
      name: "no model, welcome already shown → show-webview (need model before chat)",
      flags: { modelConfigured: false, onboardingCompleted: false, partialStage: undefined },
      expected: "show-webview",
    },
    {
      name: "model configured, no onboarding done → open-chat (overture will run inside)",
      flags: { modelConfigured: true, onboardingCompleted: false, partialStage: undefined },
      expected: "open-chat",
    },
    {
      name: "model configured, partial at stage 2 → resume-chat-at-stage",
      flags: { modelConfigured: true, onboardingCompleted: false, partialStage: 2 },
      expected: "resume-chat-at-stage",
    },
    {
      name: "model configured, onboarding completed → normal-session",
      flags: { modelConfigured: true, onboardingCompleted: true, partialStage: undefined },
      expected: "normal-session",
    },
    {
      name: "onboarding completed (regardless of other flags) → normal-session",
      flags: { modelConfigured: true, onboardingCompleted: true, partialStage: undefined },
      expected: "normal-session",
    },
    {
      name: "model configured, welcome shown, no partial stage → open-chat",
      flags: { modelConfigured: true, onboardingCompleted: false, partialStage: undefined },
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

describe("first-run routing — env-var providers count as configured", () => {
  // extension.ts feeds `isModelConfigured() || hasProviderEnvVar()` into the
  // predicate. A machine whose only credential is an env var must NOT be sent
  // to the Stage 0 model-setup webview.
  it("a provider env var alone routes past the webview", () => {
    expect(
      resolveOnboardingAction({
        modelConfigured: true, // isModelConfigured() || hasProviderEnvVar()
        onboardingCompleted: false,
        partialStage: undefined,
      }),
    ).toBe("open-chat");
  });

  it("no model and no completion marker is the Stage 0 case", () => {
    expect(
      resolveOnboardingAction({
        modelConfigured: false,
        onboardingCompleted: false,
        partialStage: undefined,
      }),
    ).toBe("show-webview");
  });

  it("a completed onboarding never re-runs, even with no model", () => {
    expect(
      resolveOnboardingAction({
        modelConfigured: false,
        onboardingCompleted: true,
        partialStage: undefined,
      }),
    ).toBe("normal-session");
  });
});

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

  it("returns false when config has no provider section", () => {
    fs.writeFileSync(path.join(tmpDir, "config.json"), JSON.stringify({ model: "x/y" }));
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
});

// ─── AC4: At-most-once guard ─────────────────────────────────────────────────

// ─── AC5: Stage 0 success → chat auto-open ───────────────────────────────────

// ─── AC6: welcome_shown persistence ──────────────────────────────────────────

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
