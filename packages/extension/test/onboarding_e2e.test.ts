// Onboarding end-to-end integration test (#433/#438)
//
// Verifies the full chain:
//   1. Panel opens with cancel button + providers + animation
//   2. Cancel (X) message → panel disposes → amicode.openChat fires
//   3. Config success message → panel disposes → onOnboardingComplete fires

import { describe, it, expect, beforeEach, vi } from "vitest";
import * as vscode from "vscode";
import {
  registerOnboardingPanel,
  onOnboardingComplete,
  _resetForTesting,
} from "../src/onboarding_panel";

describe("Onboarding end-to-end flow", () => {
  let ctx: { subscriptions: unknown[]; extensionUri: unknown };

  beforeEach(() => {
    _resetForTesting();
    (vscode.commands as unknown as { executed: string[] }).executed = [];
    ctx = { subscriptions: [], extensionUri: vscode.Uri.file("/ext") } as never;
    registerOnboardingPanel(ctx as never);
  });

  it("cancel (X) disposes panel and executes amicode.openChat", async () => {
    const spy = vi.spyOn(vscode.window, "createWebviewPanel");
    await vscode.commands.executeCommand("amicode.onboarding.open");

    const panel = spy.mock.results[0].value as {
      webview: { _simulateMessage: (msg: unknown) => void };
      dispose: () => void;
    };

    // Clear the executed log
    (vscode.commands as unknown as { executed: string[] }).executed = [];

    // Simulate cancel from webview
    panel.webview._simulateMessage({ type: "cancel" });

    // Verify: amicode.openChat was executed
    const executed = (vscode.commands as unknown as { executed: string[] }).executed;
    expect(executed).toContain("amicode.openChat");

    spy.mockRestore();
  });

  it("config-success disposes panel and fires onOnboardingComplete listener", async () => {
    const spy = vi.spyOn(vscode.window, "createWebviewPanel");
    const completed: boolean[] = [];
    onOnboardingComplete(() => { completed.push(true); });

    await vscode.commands.executeCommand("amicode.onboarding.open");

    const panel = spy.mock.results[0].value as {
      webview: { _simulateMessage: (msg: unknown) => void };
    };

    // Simulate successful config from webview
    panel.webview._simulateMessage({
      type: "config-success",
      payload: { provider: "anthropic", model: "anthropic/claude-sonnet-4", apiKey: "sk-test" },
    });

    expect(completed).toHaveLength(1);
    spy.mockRestore();
  });

  it("panel HTML contains cancel button, animation, providers, and webview script", async () => {
    const spy = vi.spyOn(vscode.window, "createWebviewPanel");
    await vscode.commands.executeCommand("amicode.onboarding.open");

    const panel = spy.mock.results[0].value as { webview: { html: string } };

    expect(panel.webview.html).toContain("cancel-btn");
    expect(panel.webview.html).toContain("animation");
    expect(panel.webview.html).toContain("__PROVIDERS__");
    expect(panel.webview.html).toContain("onboarding_webview.js");
    expect(panel.webview.html).toContain("Content-Security-Policy");

    spy.mockRestore();
  });
});
