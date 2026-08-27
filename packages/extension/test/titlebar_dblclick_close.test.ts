import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Regression for harmoniqs/amicode#323 — Double-clicking a session tab does not close it.
 * The tab component should bind onDblClick to the existing close-tab handler (props.onClose / closeTab).
 * Mirrors the e2e expectation in tab-dblclick-close.spec.ts but runs as a fast unit check on source.
 */
describe("titlebar tab — double-click to close (amicode#323)", () => {
  const file = path.resolve(
    __dirname,
    "../../app-bundle/overlay/packages/app/src/components/titlebar-tab-nav.tsx",
  );

  it("TabNavItem binds onDblClick to close the tab (not only rename)", () => {
    const src = fs.readFileSync(file, "utf8");
    // The outer [data-titlebar-tab] container for session tabs should have an onDblClick that closes.
    // We expect at least two onDblClick bindings: one for rename (title) and one for close (container).
    // Count onDblClick occurrences — before fix there is exactly 1 (title rename), after fix 2+ (container close).
    const dblClickCount = (src.match(/onDblClick/g) ?? []).length;
    expect(dblClickCount).toBeGreaterThanOrEqual(2);

    // The close binding should be on the tab container ([data-titlebar-tab]) and call the close handler.
    // Look for a pattern like onDblClick={...onClose or ...closeTab}
    const hasCloseDblClick =
      /data-titlebar-tab[\s\S]*?onDblClick\s*=\s*\{[^}]*closeTab/i.test(src) ||
      /data-titlebar-tab[\s\S]*?onDblClick\s*=\s*\{[^}]*onClose/i.test(src) ||
      /onDblClick\s*=\s*\{[^}]*props\.onClose/i.test(src);
    expect(hasCloseDblClick).toBe(true);
  });

  it("DraftTabItem also binds onDblClick to close", () => {
    const src = fs.readFileSync(file, "utf8");
    // DraftTabItem is the second component in the file — ensure it also has a close double-click.
    // Split at 'export function DraftTabItem' and check second half.
    const parts = src.split("export function DraftTabItem");
    expect(parts.length).toBe(2);
    const draftSrc = parts[1];
    const hasDraftClose = /onDblClick/i.test(draftSrc) && /onClose|closeTab/i.test(draftSrc);
    expect(hasDraftClose).toBe(true);
  });
});
