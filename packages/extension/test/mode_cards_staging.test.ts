// #533: auto-deploy mode cards to ~/.config/opencode/agents/ on activate.
// #761: generalized precedence staging — every card in the package's agents
// directory (two directors + five workers), entitlement-gated overlay merge
// with frozen-field classification, provenance merge records in a staging
// receipt, and the dispatch-target validator.
//
// Tests mirror pasqal_assets.test.ts: real file operations in tmp dirs,
// no mocks. The public interface is stageModCards(extensionPath, destDir?,
// opts?) which copies the shipped mode-card markdown into the global opencode
// agents directory. Semantics: ALWAYS-COPY (extension-owned, overwrite-on-
// activate, never blocks activation).
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globalAgentsDir, stageModCards } from "../src/mode_cards";

// The REAL extension root — packages/extension/agents/ ships in the vsix.
const EXTENSION_PATH = join(__dirname, "..");
const AGENTS_SRC = join(EXTENSION_PATH, "agents");

// The expected staging surface is DISCOVERED from the source directory —
// never a second fixed list to drift from the shipped cards (#761 AC1).
function expectedCards(): string[] {
  return readdirSync(AGENTS_SRC)
    .filter((f) => f.endsWith(".md"))
    .sort();
}

// Hermetic default: no entitlement, no overlay source — tests that exercise
// the gate inject their own opts; the machine's real entitlements file must
// never leak into a staging test.
const HERMETIC = { entitlements: [] as string[], overlaySource: null as string | null };

describe("globalAgentsDir", () => {
  it("is ~/.config/opencode/agents/", () => {
    const home = process.env.HOME ?? "/tmp";
    expect(globalAgentsDir()).toBe(join(home, ".config", "opencode", "agents"));
  });
});

describe("stageModCards", () => {
  it("stages every card in the package's agents directory into a fresh dest dir, creating it", () => {
    const expected = expectedCards();
    // #761 AC1: seven cards ship today (two directors + five workers), and
    // staging covers EVERY card in the dir — the count guard keeps a dropped
    // card from silently shrinking the surface.
    expect(expected.length).toBeGreaterThanOrEqual(7);
    const destDir = join(mkdtempSync(join(tmpdir(), "mode-cards-")), "agents");
    // destDir does NOT exist yet — stageModCards must create it
    expect(existsSync(destDir)).toBe(false);
    const r = stageModCards(EXTENSION_PATH, destDir, HERMETIC);
    expect(r.dir).toBe(destDir);
    expect(r.staged).toEqual(expected);
    for (const f of expected) expect(existsSync(join(destDir, f)), `missing ${f}`).toBe(true);
    // staged cards are byte-identical to the shipped source (no entitlement:
    // base cards stage alone, no overlay fields)
    for (const f of expected) {
      expect(readFileSync(join(destDir, f), "utf8")).toBe(
        readFileSync(join(AGENTS_SRC, f), "utf8"),
      );
    }
  });

  it("overwrites a stale copy (extension-owned; always-copy on activate)", () => {
    const destDir = mkdtempSync(join(tmpdir(), "mode-cards-stale-"));
    mkdirSync(destDir, { recursive: true });
    writeFileSync(join(destDir, "autodev.md"), "# BOGUS_PLACEHOLDER_NOT_IN_REAL_CARD\n");
    stageModCards(EXTENSION_PATH, destDir, HERMETIC);
    expect(readFileSync(join(destDir, "autodev.md"), "utf8")).not.toContain("BOGUS_PLACEHOLDER_NOT_IN_REAL_CARD");
  });

  it("is idempotent — second call stages identical content without error", () => {
    const destDir = mkdtempSync(join(tmpdir(), "mode-cards-idem-"));
    const first = stageModCards(EXTENSION_PATH, destDir, HERMETIC);
    const second = stageModCards(EXTENSION_PATH, destDir, HERMETIC);
    expect(second.staged).toEqual(first.staged);
    for (const f of first.staged) {
      expect(readFileSync(join(destDir, f), "utf8")).toBe(
        readFileSync(join(AGENTS_SRC, f), "utf8"),
      );
    }
  });

  it("throws (naming a shipped card) when the extension bundle carries no cards", () => {
    const fakeExtension = mkdtempSync(join(tmpdir(), "mode-cards-noext-"));
    const destDir = mkdtempSync(join(tmpdir(), "mode-cards-dest-"));
    expect(() => stageModCards(fakeExtension, destDir, HERMETIC)).toThrow(/autodev\.md/);
  });

  it("tripwire: the extension really ships the cards at the source path", () => {
    for (const f of expectedCards())
      expect(existsSync(join(AGENTS_SRC, f)), `missing source ${f}`).toBe(true);
  });

  it("writes a staging receipt recording every card and its base content hash", () => {
    const destDir = mkdtempSync(join(tmpdir(), "mode-cards-receipt-"));
    const fixedNow = "2026-09-03T00:00:00.000Z";
    const r = stageModCards(EXTENSION_PATH, destDir, { ...HERMETIC, now: () => fixedNow });
    const receiptPath = join(destDir, ".staging-receipt.json");
    expect(r.receiptPath).toBe(receiptPath);
    expect(existsSync(receiptPath)).toBe(true);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    expect(receipt.staged_at).toBe(fixedNow);
    expect(receipt.dir).toBe(destDir);
    // one record per staged card, each carrying the BASE content hash
    expect(receipt.cards.map((c: { card: string }) => c.card)).toEqual(r.staged);
    for (const c of receipt.cards) {
      expect(c.overlay_id).toBeNull(); // no entitlement → base alone
      expect(c.merged_fields).toEqual([]);
      const digest = createHash("sha256")
        .update(readFileSync(join(AGENTS_SRC, c.card)))
        .digest("hex");
      expect(c.base_sha256).toBe(`sha256:${digest}`);
    }
  });
});
