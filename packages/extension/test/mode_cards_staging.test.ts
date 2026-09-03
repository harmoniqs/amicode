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

// ── #761: entitlement gate + overlay merge ─────────────────────────────────
//
// The overlay source fixture mirrors the premium checkout's overlay layout
// (<root>/vault/agents/overlays/<id>.json); the real overlay content arrives
// with the premium slice. researcher-tuning targets hypothesizer (all four
// method-class fields); librarian-tuning targets analyzer + librarian (one
// field, two cards); experimenter-tuning and engineer-tuning are DELIBERATELY
// absent — those cards stage alone, no missing-target errors.
const OVERLAY_ROOT = join(__dirname, "fixtures", "overlays", "root");
const ENTITLED = ["amicissimo"];

describe("stageModCards — entitlement gate", () => {
  it("no entitlement: base cards stage alone even with the overlay source present", () => {
    const destDir = mkdtempSync(join(tmpdir(), "mode-cards-noent-"));
    const r = stageModCards(EXTENSION_PATH, destDir, {
      entitlements: [],
      overlaySource: OVERLAY_ROOT,
    });
    // every card byte-identical to its base — no overlay fields anywhere
    for (const f of expectedCards()) {
      expect(readFileSync(join(destDir, f), "utf8")).toBe(
        readFileSync(join(AGENTS_SRC, f), "utf8"),
      );
    }
    expect(r.staged).toEqual(expectedCards());
    const receipt = JSON.parse(readFileSync(r.receiptPath, "utf8"));
    expect(receipt.cards.every((c: { overlay_id: string | null }) => c.overlay_id === null)).toBe(true);
  });

  it("entitlement via the real resolution path (entitlements.toml fixture dir)", () => {
    const destDir = mkdtempSync(join(tmpdir(), "mode-cards-entcfg-"));
    const configDir = mkdtempSync(join(tmpdir(), "mode-cards-cfg-"));
    writeFileSync(
      join(configDir, "entitlements.toml"),
      'codes = ["amicissimo"]\n',
    );
    const r = stageModCards(EXTENSION_PATH, destDir, {
      entitlementConfigDir: configDir,
      overlaySource: OVERLAY_ROOT,
    });
    const staged = readFileSync(join(destDir, "hypothesizer.md"), "utf8");
    expect(staged).toContain("Model routing, tuned:");
  });

  it("entitlement present but source absent: base cards stage alone, no errors", () => {
    const destDir = mkdtempSync(join(tmpdir(), "mode-cards-nosrc-"));
    const emptyRoot = mkdtempSync(join(tmpdir(), "mode-cards-emptysrc-"));
    const r = stageModCards(EXTENSION_PATH, destDir, {
      entitlements: ENTITLED,
      overlaySource: emptyRoot, // exists, but no overlays dir inside → absent
    });
    for (const f of expectedCards()) {
      expect(readFileSync(join(destDir, f), "utf8")).toBe(
        readFileSync(join(AGENTS_SRC, f), "utf8"),
      );
    }
    const receipt = JSON.parse(readFileSync(r.receiptPath, "utf8"));
    expect(receipt.cards.every((c: { overlay_id: string | null }) => c.overlay_id === null)).toBe(true);
    expect(receipt.rejections ?? []).toEqual([]);
  });
});

describe("stageModCards — overlay merge (entitlement + overlays present)", () => {
  const fixedNow = "2026-09-03T12:00:00.000Z";

  function stageEntitled(): { destDir: string; receipt: any; result: ReturnType<typeof stageModCards> } {
    const destDir = mkdtempSync(join(tmpdir(), "mode-cards-merge-"));
    const result = stageModCards(EXTENSION_PATH, destDir, {
      entitlements: ENTITLED,
      overlaySource: OVERLAY_ROOT,
      now: () => fixedNow,
    });
    const receipt = JSON.parse(readFileSync(result.receiptPath, "utf8"));
    return { destDir, receipt, result };
  }

  it("merges method-class fields into the dispatched card; defaults replaced", () => {
    const { destDir } = stageEntitled();
    const staged = readFileSync(join(destDir, "hypothesizer.md"), "utf8");
    const base = readFileSync(join(AGENTS_SRC, "hypothesizer.md"), "utf8");
    // all four method-class dimensions merged
    expect(staged).toContain("Tuned procedure — the researcher tuning overlay sharpens the default");
    expect(staged).toContain("Model routing, tuned: the heaviest reasoning class on the machine");
    expect(staged).toContain("Iteration budget, tuned: two ranking passes");
    expect(staged).toContain("Queue thin, tuned: Ledger: <path>");
    // the base defaults they replace are GONE from the staged card
    expect(staged).not.toContain("Model routing, default:");
    expect(staged).not.toContain("Iteration budget, default:");
    // the frozen Output contract and the frontmatter are byte-untouched
    const oc = (t: string) => t.slice(t.indexOf("## Output contract"));
    expect(oc(staged)).toBe(oc(base));
    const fm = (t: string) => t.slice(0, t.indexOf("\n---\n", 4) + 5);
    expect(fm(staged)).toBe(fm(base));
  });

  it("one overlay covers two cards (librarian-tuning → analyzer + librarian)", () => {
    const { destDir, receipt } = stageEntitled();
    for (const card of ["analyzer.md", "librarian.md"]) {
      const staged = readFileSync(join(destDir, card), "utf8");
      expect(staged).toContain("Model routing, tuned: the heavy reasoning class for curation casts");
      expect(staged).not.toContain("Model routing, default:");
      const rec = receipt.cards.find((c: { card: string }) => c.card === card);
      expect(rec.overlay_id).toBe("librarian-tuning");
      expect(rec.merged_fields).toEqual(["model_routing"]);
    }
  });

  it("cards whose dispatch target is absent from the registry stage alone, no errors", () => {
    const { destDir, receipt, result } = stageEntitled();
    for (const card of ["experimenter.md", "implementer.md"]) {
      expect(readFileSync(join(destDir, card), "utf8")).toBe(
        readFileSync(join(AGENTS_SRC, card), "utf8"),
      );
      const rec = receipt.cards.find((c: { card: string }) => c.card === card);
      expect(rec.overlay_id).toBeNull();
    }
    // directors carry no dispatch field at all — base, never overlay
    for (const card of ["autodev.md", "autoresearch.md"]) {
      expect(readFileSync(join(destDir, card), "utf8")).toBe(
        readFileSync(join(AGENTS_SRC, card), "utf8"),
      );
    }
    expect(result.rejections).toEqual([]);
  });

  it("provenance lands in the merge record — never in the staged card", () => {
    const { destDir, receipt } = stageEntitled();
    const rec = receipt.cards.find((c: { card: string }) => c.card === "hypothesizer.md");
    // merge record: base card name, base content hash, overlay id, timestamp
    expect(rec.card).toBe("hypothesizer.md");
    const digest = createHash("sha256")
      .update(readFileSync(join(AGENTS_SRC, "hypothesizer.md")))
      .digest("hex");
    expect(rec.base_sha256).toBe(`sha256:${digest}`);
    expect(rec.overlay_id).toBe("researcher-tuning");
    expect(rec.merged_fields).toEqual(["prompt_body", "model_routing", "iteration_budget", "example_brief"]);
    expect(rec.merged_at).toBe(fixedNow);
    // the STAGED card carries no provenance: no hash, no merge timestamp
    const staged = readFileSync(join(destDir, "hypothesizer.md"), "utf8");
    expect(staged).not.toContain("sha256:");
    expect(staged).not.toContain(fixedNow);
    expect(staged).not.toContain("merged_fields");
  });
});
