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

// ── #761: the contract freeze — interface-class fields never merge ─────────
//
// Table-driven over the ADR's FULL frozen list (output schema, tool
// permissions, brief/cast grammar, dispatch/cast rules) plus unclassified
// field names, which default to reject.
import { INTERFACE_CLASS_FIELDS, cardDispatch, classifyOverlayField, mergeOverlayIntoCard, validateDispatchTarget } from "../src/mode_cards";

describe("overlay field classification (the freeze table)", () => {
  it("every interface-class field on the frozen list classifies interface", () => {
    for (const f of INTERFACE_CLASS_FIELDS) {
      expect(classifyOverlayField(f), `${f} → interface`).toBe("interface");
    }
    expect(INTERFACE_CLASS_FIELDS.length).toBe(4); // the full list, no shrinkage
  });

  it("unclassified field names default to reject", () => {
    for (const f of ["banana_split", "role", "tools", "output", "mode", "color"]) {
      expect(classifyOverlayField(f), `${f} → unclassified`).toBe("unclassified");
    }
  });
});

describe("mergeOverlayIntoCard — freeze enforcement (table-driven)", () => {
  const BASE = readFileSync(join(AGENTS_SRC, "hypothesizer.md"), "utf8");

  // one offending field per interface-class entry, each named in the error
  it.each([...INTERFACE_CLASS_FIELDS])("rejects interface-class field %s", (field) => {
    const overlay = { id: "researcher-tuning", fields: { [field]: "BOGUS_INTERFACE_OVERRIDE" } };
    expect(() => mergeOverlayIntoCard(BASE, overlay, "hypothesizer.md")).toThrow(
      new RegExp(`"${field}" is interface-class`),
    );
  });

  it.each(["banana_split", "role", "tools"])("rejects unclassified field %s", (field) => {
    const overlay = { id: "researcher-tuning", fields: { [field]: "BOGUS_UNCLASSIFIED_OVERRIDE" } };
    expect(() => mergeOverlayIntoCard(BASE, overlay, "hypothesizer.md")).toThrow(
      new RegExp(`"${field}" is unclassified-class`),
    );
  });
});

describe("stageModCards — freeze violations stage the base alone, rejection recorded", () => {
  const BASE_HYPOTHESIZER = () => readFileSync(join(AGENTS_SRC, "hypothesizer.md"), "utf8");

  function rootWithOverlay(overlayId: string, fields: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "mode-cards-freeze-"));
    const dir = join(root, "vault", "agents", "overlays");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${overlayId}.json`), JSON.stringify({ overlay_version: 1, id: overlayId, fields }));
    return root;
  }

  it.each([...INTERFACE_CLASS_FIELDS, "banana_split"])(
    "interface/unclassified field %s: base stages alone, rejection names the field",
    (field) => {
      const destDir = mkdtempSync(join(tmpdir(), "mode-cards-frz-"));
      const r = stageModCards(EXTENSION_PATH, destDir, {
        entitlements: ENTITLED,
        overlaySource: rootWithOverlay("researcher-tuning", { [field]: "BOGUS" }),
      });
      expect(readFileSync(join(destDir, "hypothesizer.md"), "utf8")).toBe(BASE_HYPOTHESIZER());
      const rej = r.rejections.find((x) => x.card === "hypothesizer.md");
      expect(rej).toBeDefined();
      expect(rej.overlay_id).toBe("researcher-tuning");
      expect(rej.reason).toContain(`"${field}"`);
    },
  );

  it("malformed overlay JSON is a registry rejection; other overlays still merge", () => {
    const root = mkdtempSync(join(tmpdir(), "mode-cards-badjson-"));
    const dir = join(root, "vault", "agents", "overlays");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "researcher-tuning.json"), "{ not json");
    writeFileSync(
      join(dir, "librarian-tuning.json"),
      JSON.stringify({
        overlay_version: 1,
        id: "librarian-tuning",
        fields: { model_routing: "the heavy class for curation casts spanning campaigns." },
      }),
    );
    const destDir = mkdtempSync(join(tmpdir(), "mode-cards-badjson-dest-"));
    const r = stageModCards(EXTENSION_PATH, destDir, {
      entitlements: ENTITLED,
      overlaySource: root,
    });
    // the good overlay still merged
    const staged = readFileSync(join(destDir, "librarian.md"), "utf8");
    expect(staged).toContain("Model routing, tuned: the heavy class");
    // the malformed one is a registry-level rejection naming the file
    const rej = r.rejections.find((x) => x.overlay_id === "researcher-tuning" && !x.card);
    expect(rej).toBeDefined();
    expect(rej.reason).toContain("malformed overlay");
  });
});

// ── #761: the dispatch-target validator ───────────────────────────────────
describe("dispatch-target validator", () => {
  it("every worker card's dispatch target is a well-formed slug; directors carry none", () => {
    for (const f of expectedCards()) {
      const text = readFileSync(join(AGENTS_SRC, f), "utf8");
      const target = cardDispatch(text);
      if (f === "autodev.md" || f === "autoresearch.md") {
        expect(target, `${f} — directors dispatch no overlay`).toBeUndefined();
      } else {
        expect(target, `${f} declares a dispatch target`).toBeDefined();
        expect(() => validateDispatchTarget(f, target!)).not.toThrow();
      }
    }
  });

  it("the five workers name the four tuned targets (librarian-tuning covers two)", () => {
    const targets = new Map<string, string[]>();
    for (const f of expectedCards()) {
      const target = cardDispatch(readFileSync(join(AGENTS_SRC, f), "utf8"));
      if (target === undefined) continue;
      targets.set(target, [...(targets.get(target) ?? []), f]);
    }
    expect([...targets.keys()].sort()).toEqual([
      "engineer-tuning",
      "experimenter-tuning",
      "librarian-tuning",
      "researcher-tuning",
    ]);
    expect(targets.get("librarian-tuning")?.sort()).toEqual(["analyzer.md", "librarian.md"]);
  });

  it("a malformed dispatch target throws (loud — a base-card defect)", () => {
    expect(() => validateDispatchTarget("bogus.md", "Bad_Name!")).toThrow(/malformed dispatch target/);
    expect(() => validateDispatchTarget("bogus.md", "")).toThrow(/malformed dispatch target/);
  });

  it("a card with a malformed dispatch field aborts staging loudly", () => {
    // fixture extension dir: one card with a malformed dispatch value
    const fakeExt = mkdtempSync(join(tmpdir(), "mode-cards-badcard-"));
    mkdirSync(join(fakeExt, "agents"), { recursive: true });
    writeFileSync(
      join(fakeExt, "agents", "worker.md"),
      "---\ndescription: x\nmode: subagent\ndispatch: Bad_Name!\n---\n\nbody\n",
    );
    const destDir = mkdtempSync(join(tmpdir(), "mode-cards-badcard-dest-"));
    expect(() =>
      stageModCards(fakeExt, destDir, { entitlements: ENTITLED, overlaySource: null }),
    ).toThrow(/malformed dispatch target/);
  });
});

// ── review F1: every merge anchor is scoped to the Method section ───────────
//
// An overlay value must only ever land inside `## Method` … the next `## `
// heading. The live failure: a card whose Method example sits in a PLAIN
// fence and whose Output contract carries a ```text fence — the fence search
// must not cross the section boundary and silently overwrite the frozen
// Output contract.
function fixtureCard(methodFence: "text" | "plain"): string {
  return [
    "---",
    "description: fixture worker card",
    "mode: subagent",
    "dispatch: fixture-tuning",
    "---",
    "",
    "## Role",
    "",
    "Fixture role.",
    "",
    "## Method",
    "",
    "Default procedure — the complete default; a tuning overlay sharpens this method,",
    "never replaces it:",
    "",
    "1. Step one.",
    "",
    "Model routing, default: the standard class for fixture work.",
    "",
    "Iteration budget, default: one pass per cast.",
    "",
    "Example brief (the shape of the input, not the cast grammar):",
    "",
    methodFence === "text" ? "```text" : "```",
    "plain fixture example",
    "```",
    "",
    "## Output contract",
    "",
    "**Frozen interface — a tuning overlay may change how you work, never what you",
    "return.**",
    "",
    "```text",
    "FROZEN_OUTPUT_CONTRACT_EXAMPLE that must never move",
    "```",
    "",
  ].join("\n");
}

describe("merge anchors are scoped to the Method section (review F1)", () => {
  const overlay = { id: "fixture-tuning", fields: { example_brief: "TUNED_EXAMPLE_BRIEF" } };

  it("a Method example in a plain fence is a missing ```text anchor — never an Output-contract overwrite", () => {
    // Current-code live bug: the fence search finds the Output contract's
    // ```text fence and silently overwrites the frozen content.
    expect(() =>
      mergeOverlayIntoCard(fixtureCard("plain"), overlay, "fixture.md"),
    ).toThrow(/Example brief fence/);
  });

  it("the Output contract stays byte-untouched when the Method fence is the lawful one", () => {
    const merged = mergeOverlayIntoCard(fixtureCard("text"), overlay, "fixture.md");
    const oc = (t: string) => t.slice(t.indexOf("## Output contract"));
    expect(oc(merged.text)).toBe(oc(fixtureCard("text")));
    // the tuned value landed in the METHOD fence, exactly once
    expect(merged.text).toContain("```text\nTUNED_EXAMPLE_BRIEF\n```");
    expect(merged.text.match(/TUNED_EXAMPLE_BRIEF/g)?.length).toBe(1);
  });

  it("staging: a fence-crossing merge is rejected and the base stages alone, Output contract intact", () => {
    const fakeExt = mkdtempSync(join(tmpdir(), "mode-cards-f1-"));
    mkdirSync(join(fakeExt, "agents"), { recursive: true });
    writeFileSync(join(fakeExt, "agents", "fixture.md"), fixtureCard("plain"));
    const root = mkdtempSync(join(tmpdir(), "mode-cards-f1-src-"));
    mkdirSync(join(root, "vault", "agents", "overlays"), { recursive: true });
    writeFileSync(
      join(root, "vault", "agents", "overlays", "fixture-tuning.json"),
      JSON.stringify({ overlay_version: 1, id: "fixture-tuning", fields: overlay.fields }),
    );
    const destDir = mkdtempSync(join(tmpdir(), "mode-cards-f1-dest-"));
    const r = stageModCards(fakeExt, destDir, { entitlements: ENTITLED, overlaySource: root });
    expect(readFileSync(join(destDir, "fixture.md"), "utf8")).toBe(fixtureCard("plain"));
    expect(r.merges).toEqual([]);
    const rej = r.rejections.find((x) => x.card === "fixture.md");
    expect(rej).toBeDefined();
    expect(rej.reason).toContain("Example brief fence");
  });

  it("a Default-procedure block that sits AFTER the routing paragraph rejects (unordered anchors)", () => {
    // The prompt_body merge replaces the span [Default procedure … Model
    // routing); a card whose procedure sits after its routing paragraph would
    // splice garbage. That is a base-card defect: reject, never guess.
    const reversed = [
      "---",
      "description: fixture worker card",
      "mode: subagent",
      "dispatch: fixture-tuning",
      "---",
      "",
      "## Method",
      "",
      "Model routing, default: the standard class for fixture work.",
      "",
      "Iteration budget, default: one pass per cast.",
      "",
      "Default procedure — the complete default:",
      "",
      "1. Step one.",
      "",
      "## Output contract",
      "",
      "**Frozen interface.**",
      "",
    ].join("\n");
    const ov = { id: "fixture-tuning", fields: { prompt_body: "Tuned procedure." } };
    expect(() => mergeOverlayIntoCard(reversed, ov, "fixture.md")).toThrow(
      /Default procedure/,
    );
  });
});

// ── review F3: an unreadable overlays dir degrades to absence ───────────────
//
// existsSync passes on a mode-000 dir; readdirSync then throws EACCES. The
// funnel invariant: an entitlement/overlay failure never dead-ends staging.
import { chmodSync } from "node:fs";
import { loadOverlayRegistry } from "../src/mode_cards";

describe("unreadable overlays dir (review F3)", () => {
  it("loadOverlayRegistry never throws on an unreadable dir", () => {
    const root = mkdtempSync(join(tmpdir(), "mode-cards-eacces-"));
    const dir = join(root, "vault", "agents", "overlays");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "x.json"), "{}");
    chmodSync(dir, 0o000);
    try {
      let registry: ReturnType<typeof loadOverlayRegistry> | undefined;
      expect(() => (registry = loadOverlayRegistry(dir))).not.toThrow();
      expect(registry!.overlays.size).toBe(0);
      // honest, not silent: the unreadable dir is a registry-level rejection
      expect(registry!.rejections.length).toBe(1);
      expect(registry!.rejections[0]!.reason).toMatch(/unreadable|EACCES|denied/i);
    } finally {
      chmodSync(dir, 0o755); // restore so tmp cleanup can remove it
    }
  });

  it("staging with an entitled but unreadable overlays dir stages every base card, no throw", () => {
    const root = mkdtempSync(join(tmpdir(), "mode-cards-eacces-stg-"));
    const dir = join(root, "vault", "agents", "overlays");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "researcher-tuning.json"),
      JSON.stringify({ overlay_version: 1, id: "researcher-tuning", fields: { model_routing: "TUNED" } }),
    );
    chmodSync(dir, 0o000);
    const destDir = mkdtempSync(join(tmpdir(), "mode-cards-eacces-dest-"));
    try {
      const r = stageModCards(EXTENSION_PATH, destDir, {
        entitlements: ENTITLED,
        overlaySource: root,
      });
      for (const f of expectedCards()) {
        expect(readFileSync(join(destDir, f), "utf8")).toBe(readFileSync(join(AGENTS_SRC, f), "utf8"));
      }
      expect(r.merges).toEqual([]);
      expect(r.rejections.length).toBe(1);
      expect(r.rejections[0]!.reason).toMatch(/unreadable|EACCES|denied/i);
    } finally {
      chmodSync(dir, 0o755);
    }
  });
});
