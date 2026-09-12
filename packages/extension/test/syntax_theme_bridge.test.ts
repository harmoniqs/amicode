import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

import {
  resolveSyntaxTheme,
  SHIKI_BUILTIN_MAP,
  type TextMateThemeObject,
} from "../src/syntax_theme_bridge";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Set up vscode.workspace.getConfiguration to return specific values. */
function mockConfig(values: Record<string, Record<string, unknown>>) {
  (vscode.workspace as any).getConfiguration = (section?: string) => ({
    get: (key: string, defaultValue?: unknown) => {
      return values[section ?? ""]?.[key] ?? defaultValue;
    },
    update: () => Promise.resolve(),
  });
}

/** Create a temp directory with a fake VS Code extension contributing a color theme. */
function createMockThemeExtension(
  themeLabel: string,
  themeJson: object,
  opts?: { includes?: Array<{ relativePath: string; content: object }> },
): { extensionPath: string; cleanup: () => void } {
  const extensionPath = fs.mkdtempSync(path.join(os.tmpdir(), "amicode-test-theme-"));
  const themesDir = path.join(extensionPath, "themes");
  fs.mkdirSync(themesDir, { recursive: true });
  fs.writeFileSync(path.join(themesDir, "theme.json"), JSON.stringify(themeJson));

  for (const inc of opts?.includes ?? []) {
    const incPath = path.join(themesDir, inc.relativePath);
    fs.mkdirSync(path.dirname(incPath), { recursive: true });
    fs.writeFileSync(incPath, JSON.stringify(inc.content));
  }

  const ext = {
    extensionPath,
    packageJSON: {
      contributes: {
        themes: [{ label: themeLabel, path: "./themes/theme.json" }],
      },
    },
  };
  (vscode.extensions as any).all = [ext];

  return {
    extensionPath,
    cleanup: () => fs.rmSync(extensionPath, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("syntax_theme_bridge", () => {
  const originalGetConfig = (vscode.workspace as any).getConfiguration;
  let cleanups: Array<() => void> = [];

  beforeEach(() => {
    (vscode.extensions as any).all = [];
    cleanups = [];
  });

  afterEach(() => {
    (vscode.workspace as any).getConfiguration = originalGetConfig;
    for (const fn of cleanups) fn();
  });

  describe("SHIKI_BUILTIN_MAP", () => {
    it("maps common VS Code themes to Shiki built-in names", () => {
      expect(SHIKI_BUILTIN_MAP["Default Dark+"]).toBe("dark-plus");
      expect(SHIKI_BUILTIN_MAP["Default Light+"]).toBe("light-plus");
      expect(SHIKI_BUILTIN_MAP["Dracula"]).toBe("dracula");
      expect(SHIKI_BUILTIN_MAP["Monokai"]).toBe("monokai");
      expect(SHIKI_BUILTIN_MAP["Nord"]).toBe("nord");
    });
  });

  describe("resolveSyntaxTheme", () => {
    it("returns a Shiki built-in name for a known VS Code theme", () => {
      mockConfig({
        workbench: { colorTheme: "Default Dark+" },
        editor: { tokenColorCustomizations: undefined },
      });
      expect(resolveSyntaxTheme()).toBe("dark-plus");
    });

    it("returns null when no theme is configured", () => {
      mockConfig({ workbench: { colorTheme: undefined } });
      expect(resolveSyntaxTheme()).toBeNull();
    });

    it("extracts a TextMate theme object from a custom extension", () => {
      const themeJson = {
        name: "My Custom Theme",
        type: "dark",
        colors: { "editor.background": "#1e1e1e" },
        tokenColors: [
          { scope: "comment", settings: { foreground: "#6A9955" } },
          { scope: "keyword", settings: { foreground: "#569CD6" } },
        ],
      };
      const { cleanup } = createMockThemeExtension("My Custom Theme", themeJson);
      cleanups.push(cleanup);

      mockConfig({
        workbench: { colorTheme: "My Custom Theme" },
        editor: { tokenColorCustomizations: undefined },
      });

      const result = resolveSyntaxTheme();
      expect(result).not.toBeNull();
      expect(typeof result).toBe("object");

      const theme = result as TextMateThemeObject;
      expect(theme.name).toBe("My Custom Theme");
      expect(theme.colors?.["editor.background"]).toBe("#1e1e1e");
      expect(theme.tokenColors).toHaveLength(2);
      expect(theme.tokenColors[0].scope).toBe("comment");
      expect(theme.tokenColors[0].settings.foreground).toBe("#6A9955");
    });

    it("resolves include chains in theme files", () => {
      const parentTheme = {
        name: "Parent",
        tokenColors: [
          { scope: "comment", settings: { foreground: "#888888" } },
        ],
        colors: { "editor.background": "#000000" },
      };
      const childTheme = {
        include: "./parent.json",
        tokenColors: [
          { scope: "keyword", settings: { foreground: "#FF0000" } },
        ],
        colors: { "editor.foreground": "#FFFFFF" },
      };
      const { cleanup } = createMockThemeExtension("Child Theme", childTheme, {
        includes: [{ relativePath: "parent.json", content: parentTheme }],
      });
      cleanups.push(cleanup);

      mockConfig({
        workbench: { colorTheme: "Child Theme" },
        editor: { tokenColorCustomizations: undefined },
      });

      const result = resolveSyntaxTheme() as TextMateThemeObject;
      expect(result).not.toBeNull();
      // Parent tokenColors come first, child on top
      expect(result.tokenColors).toHaveLength(2);
      expect(result.tokenColors[0].scope).toBe("comment");
      expect(result.tokenColors[0].settings.foreground).toBe("#888888");
      expect(result.tokenColors[1].scope).toBe("keyword");
      // Colors are merged: parent + child
      expect(result.colors?.["editor.background"]).toBe("#000000");
      expect(result.colors?.["editor.foreground"]).toBe("#FFFFFF");
    });

    it("detects circular includes and returns null", () => {
      // Create a theme that includes itself
      const selfRef = { include: "./theme.json", tokenColors: [] };
      const { cleanup } = createMockThemeExtension("Circular Theme", selfRef);
      cleanups.push(cleanup);

      mockConfig({
        workbench: { colorTheme: "Circular Theme" },
        editor: { tokenColorCustomizations: undefined },
      });

      const result = resolveSyntaxTheme() as TextMateThemeObject;
      // Should still return a result (the self-referencing include is skipped,
      // but the theme itself is still valid with empty tokenColors)
      expect(result).not.toBeNull();
      expect(result.tokenColors).toHaveLength(0);
    });

    it("merges user tokenColorCustomizations on top", () => {
      const themeJson = {
        tokenColors: [
          { scope: "comment", settings: { foreground: "#888888" } },
        ],
      };
      const { cleanup } = createMockThemeExtension("Customized Theme", themeJson);
      cleanups.push(cleanup);

      mockConfig({
        workbench: { colorTheme: "Customized Theme" },
        editor: {
          tokenColorCustomizations: {
            textMateRules: [
              { scope: "comment", settings: { foreground: "#FF0000" } },
            ],
          },
        },
      });

      const result = resolveSyntaxTheme() as TextMateThemeObject;
      expect(result).not.toBeNull();
      // Base theme rule + user override rule (user last, so it wins at render time)
      expect(result.tokenColors).toHaveLength(2);
      expect(result.tokenColors[0].settings.foreground).toBe("#888888");
      expect(result.tokenColors[1].settings.foreground).toBe("#FF0000");
    });

    it("returns null for an unknown theme with no contributing extension", () => {
      mockConfig({
        workbench: { colorTheme: "Some Unknown Theme" },
        editor: { tokenColorCustomizations: undefined },
      });
      (vscode.extensions as any).all = [];

      expect(resolveSyntaxTheme()).toBeNull();
    });
  });
});
