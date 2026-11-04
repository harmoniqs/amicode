// card_overlay_merge.test.ts — #2118: every dispatching worker card (the four
// cast cards plus the librarian) carries a `## Method` section with a COMPLETE
// default for each method-class dimension, so a premium overlay is always a
// delta on a working default (ADR-0003, amicissimo) and never throws
// `base card lacks the anchor`.
//
// What is pinned per card:
//   - `dispatch: <role>-tuning` (and the critic carries none — new, no overlay)
//   - a synthetic overlay with ALL FOUR method fields merges with no throw,
//     and everything outside the Method slice (frontmatter incl. permission
//     block, the Return contract, and the Output contract where the card has
//     one) is byte-identical afterwards
//   - interface-class and unclassified overlay fields are rejected
//   - the unmerged base card is a complete default: non-empty text after each
//     of the four anchors
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cardDispatch,
  validateDispatchTarget,
  mergeOverlayIntoCard,
  METHOD_CLASS_FIELDS,
} from "../src/mode_cards";

const AGENTS_DIR = join(__dirname, "..", "agents");
const DISPATCHING = ["analyzer", "experimenter", "hypothesizer", "implementer", "librarian"] as const;

const card = (role: string) => readFileSync(join(AGENTS_DIR, `${role}.md`), "utf8");

/** Bytes of a `## ` section: heading to the next `## ` heading (or EOF). */
const section = (text: string, heading: string) => {
  const m = new RegExp(`^${heading}[^\\n]*$`, "m").exec(text);
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length);
  const next = /^## /m.exec(rest);
  return text.slice(m.index, m.index + m[0].length + (next ? next.index : rest.length));
};
const frontmatterOf = (text: string) => text.slice(0, text.indexOf("\n---\n", 4) + 5);
const permissionBlock = (text: string) => /^permission:\n(?: {2}.+\n)+/m.exec(frontmatterOf(text))?.[0];

/** The card with its Method section cut out — everything an overlay must never reach. */
const outsideMethod = (text: string) => {
  const method = section(text, "## Method")!;
  return text.replace(method, "");
};

const FULL_OVERLAY = {
  id: "synthetic-tuning",
  fields: {
    prompt_body:
      "Default procedure — TUNED-PROCEDURE-MARKER:\n\n1. Tuned step one.\n2. Tuned step two.",
    model_routing: "TUNED-ROUTING-MARKER strongest-reasoner for the hard casts",
    iteration_budget: "TUNED-BUDGET-MARKER two passes per cast",
    example_brief: "TUNED-BRIEF-MARKER read <ledger>, then <artifact>",
  },
};

describe("dispatching worker cards accept a full method overlay (#2118)", () => {
  for (const role of DISPATCHING) {
    describe(role, () => {
      const base = card(role);

      it(`declares dispatch: ${role}-tuning, a well-formed slug`, () => {
        expect(cardDispatch(base)).toBe(`${role}-tuning`);
        expect(() => validateDispatchTarget(`${role}.md`, cardDispatch(base)!)).not.toThrow();
      });

      it("merges an overlay carrying all four method fields without throwing, outside-Method bytes untouched", () => {
        expect(Object.keys(FULL_OVERLAY.fields).sort()).toEqual([...METHOD_CLASS_FIELDS].sort());
        const merged = mergeOverlayIntoCard(base, FULL_OVERLAY, `${role}.md`);
        expect(merged.mergedFields).toEqual([...METHOD_CLASS_FIELDS]);
        for (const marker of ["TUNED-PROCEDURE-MARKER", "TUNED-ROUTING-MARKER", "TUNED-BUDGET-MARKER", "TUNED-BRIEF-MARKER"]) {
          expect(merged.text, `${role}: ${marker} landed`).toContain(marker);
        }
        // frontmatter (the permission block byte for byte) and the frozen sections
        expect(frontmatterOf(merged.text)).toBe(frontmatterOf(base));
        expect(permissionBlock(base), `${role} has a permission block`).toBeDefined();
        expect(merged.text).toContain(permissionBlock(base)!);
        const receipt = section(base, "## Return contract \\(receipt\\)");
        expect(receipt, `${role} carries the receipt contract`).not.toBeNull();
        expect(merged.text).toContain(receipt!);
        const outputContract = section(base, "## Output contract");
        if (outputContract !== null) expect(merged.text).toContain(outputContract);
        // and structurally: nothing outside the Method slice moved at all
        expect(outsideMethod(merged.text)).toBe(outsideMethod(base));
        // the tuned defaults replaced the base defaults, one routing line remains
        expect(merged.text).not.toContain("Model routing, default:");
        expect(merged.text).not.toContain("Iteration budget, default:");
      });

      it("rejects an interface-class field and an unclassified field", () => {
        expect(() =>
          mergeOverlayIntoCard(base, { id: "x", fields: { tool_permissions: "edit: allow" } }, `${role}.md`),
        ).toThrow(/interface-class/);
        expect(() =>
          mergeOverlayIntoCard(base, { id: "x", fields: { temperature_hack: "9" } }, `${role}.md`),
        ).toThrow(/unclassified-class/);
        // a method field riding along does not launder the offender
        expect(() =>
          mergeOverlayIntoCard(
            base,
            { id: "x", fields: { model_routing: "workhorse", output_schema: "{}" } },
            `${role}.md`,
          ),
        ).toThrow(/interface-class/);
      });

      it("the empty overlay leaves the card byte-unchanged", () => {
        const merged = mergeOverlayIntoCard(base, { id: "x", fields: {} }, `${role}.md`);
        expect(merged.text).toBe(base);
        expect(merged.mergedFields).toEqual([]);
      });

      it("the unmerged base is a complete default: non-empty text after each of the four anchors", () => {
        const method = section(base, "## Method")!;
        expect(method, `${role} carries ## Method`).not.toBeNull();
        // anchors in the pinned order, exactly one routing paragraph, one brief caption
        const order = [/^Default procedure/m, /^Model routing, default:/m, /^Iteration budget, default:/m, /^Example brief/m];
        const at = order.map((re) => method.search(re));
        at.forEach((p, k) => expect(p, `${role}: anchor ${k} present`).toBeGreaterThan(-1));
        expect([...at].sort((a, b) => a - b)).toEqual(at);
        expect((method.match(/^Model routing, /gm) ?? []).length).toBe(1);
        expect((method.match(/^Iteration budget, /gm) ?? []).length).toBe(1);
        expect((method.match(/^Example brief/gm) ?? []).length).toBe(1);
        // content after each anchor (to the next anchor / paragraph) is real, not a stub
        const afterDefault = method.slice(at[0]!, at[1]!);
        expect(afterDefault, `${role}: numbered procedure`).toMatch(/^1\. \S/m);
        expect(afterDefault.split("\n").slice(1).join("\n").trim().length).toBeGreaterThan(80);
        expect(method.slice(at[1]!, at[2]!).replace(/^Model routing, default:/, "").trim().length).toBeGreaterThan(40);
        expect(method.slice(at[2]!, at[3]!).replace(/^Iteration budget, default:/, "").trim().length).toBeGreaterThan(40);
        const brief = /```text\n([\s\S]*?)```/.exec(method.slice(at[3]!));
        expect(brief, `${role}: example brief in a text fence`).not.toBeNull();
        expect(brief![1]!.trim().length).toBeGreaterThan(40);
        // a model CLASS, never a model id
        expect(method.slice(at[1]!, at[2]!)).toMatch(/workhorse|strongest-reasoner|fast-cheap/);
        // no other `## ` heading falls inside the Method slice
        expect(method.slice(method.indexOf("\n") + 1)).not.toMatch(/^## /m);
      });
    });
  }

  it("the critic carries no dispatch target (new card, no overlay yet)", () => {
    expect(cardDispatch(card("critic"))).toBeUndefined();
  });
});
