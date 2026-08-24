// #533: auto-deploy mode cards to ~/.config/opencode/agents/ on activate.
//
// Tests mirror pasqal_assets.test.ts: real file operations in tmp dirs,
// no mocks. The public interface is stageModCards(extensionPath, destDir?)
// which copies the shipped mode-card markdown into the global opencode
// agents directory. Semantics: ALWAYS-COPY (extension-owned, overwrite-on-
// activate, never blocks activation).
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODE_CARD_FILES, globalAgentsDir, stageModCards } from "../src/mode_cards";

// The REAL extension root — packages/extension/agents/ ships in the vsix.
const EXTENSION_PATH = join(__dirname, "..");

describe("globalAgentsDir", () => {
  it("is ~/.config/opencode/agents/", () => {
    const home = process.env.HOME ?? "/tmp";
    expect(globalAgentsDir()).toBe(join(home, ".config", "opencode", "agents"));
  });
});

describe("stageModCards", () => {
  it("stages both mode cards into a fresh dest dir, creating it", () => {
    const destDir = join(mkdtempSync(join(tmpdir(), "mode-cards-")), "agents");
    // destDir does NOT exist yet — stageModCards must create it
    expect(existsSync(destDir)).toBe(false);
    const r = stageModCards(EXTENSION_PATH, destDir);
    expect(r.dir).toBe(destDir);
    expect(r.staged).toEqual([...MODE_CARD_FILES]);
    for (const f of MODE_CARD_FILES) expect(existsSync(join(destDir, f)), `missing ${f}`).toBe(true);
    // staged cards are byte-identical to the shipped source
    for (const f of MODE_CARD_FILES) {
      expect(readFileSync(join(destDir, f), "utf8")).toBe(
        readFileSync(join(EXTENSION_PATH, "agents", f), "utf8"),
      );
    }
  });

  it("overwrites a stale copy (extension-owned; always-copy on activate)", () => {
    const destDir = mkdtempSync(join(tmpdir(), "mode-cards-stale-"));
    mkdirSync(destDir, { recursive: true });
    writeFileSync(join(destDir, "autodev.md"), "# BOGUS_PLACEHOLDER_NOT_IN_REAL_CARD\n");
    stageModCards(EXTENSION_PATH, destDir);
    expect(readFileSync(join(destDir, "autodev.md"), "utf8")).not.toContain("BOGUS_PLACEHOLDER_NOT_IN_REAL_CARD");
  });

  it("is idempotent — second call stages identical content without error", () => {
    const destDir = mkdtempSync(join(tmpdir(), "mode-cards-idem-"));
    const first = stageModCards(EXTENSION_PATH, destDir);
    const second = stageModCards(EXTENSION_PATH, destDir);
    expect(second).toEqual(first);
  });

  it("throws (naming the file) when a shipped card is absent from the extension bundle", () => {
    const fakeExtension = mkdtempSync(join(tmpdir(), "mode-cards-noext-"));
    const destDir = mkdtempSync(join(tmpdir(), "mode-cards-dest-"));
    expect(() => stageModCards(fakeExtension, destDir)).toThrow(/autodev\.md/);
  });

  it("tripwire: the extension really ships both mode cards at the source path", () => {
    for (const f of MODE_CARD_FILES)
      expect(existsSync(join(EXTENSION_PATH, "agents", f)), `missing source ${f}`).toBe(true);
  });
});
