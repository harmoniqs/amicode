import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Titlebar tab close/rename interactions, pinned at fork pin
 * v1.18.10-amicode.18.
 *
 * amicode#323 ("close tab on double-click") is SUPERSEDED: the fork's .18 tab
 * UX reworked the interactions deliberately — double-click now opens the
 * rename flow, middle-click closes, and the × button stays a plain close.
 * The regression spirit survives: a tab is closable without hunting the ×
 * (middle-click), and double-click does something useful (rename). Pin the
 * current contract so the next pin bump that changes it says so loudly.
 */
describe("titlebar tab interactions (.18 pin: dblclick renames, middle-click closes)", () => {
  const file = path.resolve(
    __dirname,
    "../../app-bundle/overlay/packages/app/src/components/titlebar-tab-nav.tsx",
  );

  it("double-click on the tab title opens the rename flow, not close", () => {
    const src = fs.readFileSync(file, "utf8");
    expect(/onDblClick\s*=\s*\{\s*openRename\s*\}/.test(src)).toBe(true);
  });

  it("middle-click closes the tab in both components (onAuxClick → closeTab)", () => {
    const src = fs.readFileSync(file, "utf8");
    const parts = src.split("export function DraftTabItem");
    expect(parts.length).toBe(2);
    for (const section of parts) {
      expect(/onAuxClick\s*=\s*\{/.test(section)).toBe(true);
      expect(/MIDDLE_MOUSE_BUTTON/.test(section)).toBe(true);
      expect(/closeTab\(/.test(section)).toBe(true);
    }
  });

  it("the close handler is still wired to a plain click (the × button path)", () => {
    const src = fs.readFileSync(file, "utf8");
    expect(/onClick\s*=\s*\{\s*closeTab\s*\}/.test(src)).toBe(true);
  });
});