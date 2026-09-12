import { describe, it, expect } from "vitest";
import { join } from "node:path";

describe("runtime path self-discovery (#1022)", () => {
  async function importModule() {
    return import("../src/rebuild/runtime_paths");
  }

  // ════════════════════════════════════════════════════════════════════════
  // resolveRuntimePaths
  // ════════════════════════════════════════════════════════════════════════
  describe("resolveRuntimePaths", () => {
    it("discovers binary and app paths from extensionPath when no overrides set", async () => {
      const { resolveRuntimePaths } = await importModule();
      const result = resolveRuntimePaths({
        extensionPath: "/home/user/.vscode/extensions/harmoniqs.amicode-0.2.0",
        platform: "linux",
        arch: "x64",
        configBinary: "",
        configAppBundleDir: "",
      });
      expect(result.binaryPath).toBe(
        "/home/user/.vscode/extensions/harmoniqs.amicode-0.2.0/vendor/opencode/linux-x64/opencode",
      );
      expect(result.appBundlePath).toBe(
        "/home/user/.vscode/extensions/harmoniqs.amicode-0.2.0/dist/app",
      );
      expect(result.binarySource).toBe("self-discovered");
    });

    it("uses config override for binary when set", async () => {
      const { resolveRuntimePaths } = await importModule();
      const result = resolveRuntimePaths({
        extensionPath: "/home/user/.vscode/extensions/harmoniqs.amicode-0.2.0",
        platform: "linux",
        arch: "x64",
        configBinary: "/custom/path/to/opencode",
        configAppBundleDir: "",
      });
      expect(result.binaryPath).toBe("/custom/path/to/opencode");
      expect(result.binarySource).toBe("config-override");
    });

    it("uses config override for app bundle when set", async () => {
      const { resolveRuntimePaths } = await importModule();
      const result = resolveRuntimePaths({
        extensionPath: "/home/user/.vscode/extensions/harmoniqs.amicode-0.2.0",
        platform: "linux",
        arch: "x64",
        configBinary: "",
        configAppBundleDir: "/custom/dist/app",
      });
      expect(result.appBundlePath).toBe("/custom/dist/app");
      expect(result.appBundleSource).toBe("config-override");
    });

    it("works for Insiders extension path", async () => {
      const { resolveRuntimePaths } = await importModule();
      const result = resolveRuntimePaths({
        extensionPath: "/home/user/.vscode-insiders/extensions/harmoniqs.amicode-0.2.0",
        platform: "linux",
        arch: "x64",
        configBinary: "",
        configAppBundleDir: "",
      });
      expect(result.binaryPath).toContain(".vscode-insiders");
      expect(result.binarySource).toBe("self-discovered");
    });

    it("works for WSL/Remote-SSH server extension path", async () => {
      const { resolveRuntimePaths } = await importModule();
      const result = resolveRuntimePaths({
        extensionPath: "/home/user/.vscode-server/extensions/harmoniqs.amicode-0.2.0",
        platform: "linux",
        arch: "x64",
        configBinary: "",
        configAppBundleDir: "",
      });
      expect(result.binaryPath).toContain(".vscode-server");
    });

    it("handles darwin-arm64 platform", async () => {
      const { resolveRuntimePaths } = await importModule();
      const result = resolveRuntimePaths({
        extensionPath: "/Users/dev/.vscode/extensions/harmoniqs.amicode-0.2.0",
        platform: "darwin",
        arch: "arm64",
        configBinary: "",
        configAppBundleDir: "",
      });
      expect(result.binaryPath).toContain("darwin-arm64");
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // detectDeveloperMode
  // ════════════════════════════════════════════════════════════════════════
  describe("detectDeveloperMode", () => {
    it("detects developer mode from setting", async () => {
      const { detectDeveloperMode } = await importModule();
      expect(detectDeveloperMode({ developerModeSetting: true })).toBe(true);
      expect(detectDeveloperMode({ developerModeSetting: false })).toBe(false);
    });

    it("detects developer mode from marker file", async () => {
      const { detectDeveloperMode } = await importModule();
      expect(
        detectDeveloperMode({ developerModeSetting: false, markerFileExists: true }),
      ).toBe(true);
    });

    it("defaults to false when neither setting nor marker", async () => {
      const { detectDeveloperMode } = await importModule();
      expect(
        detectDeveloperMode({ developerModeSetting: false, markerFileExists: false }),
      ).toBe(false);
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // validateOverride
  // ════════════════════════════════════════════════════════════════════════
  describe("validateOverride", () => {
    it("validates an existing path as ok", async () => {
      const { validateOverride } = await importModule();
      // Use a path that definitely exists
      const result = validateOverride("/usr/bin/env");
      expect(result.exists).toBe(true);
    });

    it("returns a diagnostic for a non-existent path", async () => {
      const { validateOverride } = await importModule();
      const result = validateOverride("/definitely/not/a/real/path/opencode");
      expect(result.exists).toBe(false);
      expect(result.diagnostic).toMatch(/does not exist/i);
    });
  });
});
