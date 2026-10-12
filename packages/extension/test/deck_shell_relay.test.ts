import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ============================================================================
// #1608 AC3: the third iframe relay — the Chat Deck shell (dist/deck_shell.js,
// src/deck/shell.ts) — must forward engine-state + fleet-role from the
// extension host down to every live pane, just as it fans out the inspector
// run:/device: envelopes. Without it the engine toggle inside a deck pane
// never sees a lifecycle push and an intentional off reads as a hang.
//
// shell.ts runs inside the webview (top-level window/DOM), so it is not
// importable in the vitest node harness; this is a SOURCE assertion, mirroring
// submit-stream-gap.test.ts in the app package.
// ============================================================================

const source = readFileSync(join(__dirname, "..", "src", "deck", "shell.ts"), "utf8");

describe("deck shell relay — engine-state + fleet-role fan-out (#1608)", () => {
  it("the Lane-1 (extension → shell) relay forwards engine-state", () => {
    expect(source).toContain('"engine-state"');
  });

  it("the Lane-1 relay forwards fleet-role", () => {
    expect(source).toContain('"fleet-role"');
  });

  it("fans them out to every pane (broadcast), not tab-routed", () => {
    // The push carries no tab id (pushEngineState/pushFleetRole use postToAll),
    // so — like the run:/device: inspector fan-out — it must broadcast to
    // frameByTab.values(), never frameByTab.get(d.tab).
    const idx = source.indexOf('"engine-state"');
    const window = source.slice(idx, idx + 400);
    expect(window).toContain("frameByTab.values()");
  });
});
