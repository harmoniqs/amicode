// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { createCatalogBrowserView, type CatalogBrowserData } from "../media/ui/views/catalogbrowser";
import type { CatalogEntry } from "../media/ui/components/catalogcard";

// Coverage for the #48 catalog browser: section rendering, row selection →
// detail pane (catalogcard reuse for Results, lighter panel for QILC runs),
// the narrow-panel master-detail collapse (back button), and the flat/grouped
// A/B toggle (#48b) — Krishna's own open question, so both arrangements must
// actually work, not just the default. Runs under happy-dom because
// atoms/components inject styles via constructable stylesheets, which jsdom
// can't model.

const entry = (over: Partial<CatalogEntry> = {}): CatalogEntry => ({
  schema_version: "1",
  run_id: "r1",
  lab_id: "default",
  fidelity: 0.999,
  pulse_path: "/runs/r1/pulse.jld2",
  gate: "X",
  proposed: { tags: ["smooth"], hash6: "ab12cd" },
  ...over,
});

function data(): CatalogBrowserData {
  return {
    qilcRuns: [{ run_id: "q1", gate: "CZ", iteration: 7, tags: ["fast"], hash6: "11aa22" }],
    results: [{ entry: entry() }],
  };
}

function groupableData(): CatalogBrowserData {
  return {
    qilcRuns: [
      { run_id: "q1", system: "transmon", gate: "CZ", iteration: 7, hash6: "11aa22" },
      { run_id: "q2", system: "fluxonium", gate: "H", iteration: 2, hash6: "33cc44" },
    ],
    results: [
      { entry: entry({ run_id: "r1", gate: "CZ", params: { system: "transmon" } }) },
      { entry: entry({ run_id: "r2", gate: "X", params: { system: "transmon" } }) },
    ],
  };
}

const rows = (el: HTMLElement) => [...el.querySelectorAll(".cb-row")] as HTMLButtonElement[];
const sectionTitles = (el: HTMLElement) => [...el.querySelectorAll(".cb-section .label-k")].map((n) => n.textContent);
const groupTitles = (el: HTMLElement) => [...el.querySelectorAll(".cb-group-title")].map((n) => n.textContent);
const toggleBtn = (el: HTMLElement, label: string) =>
  [...el.querySelectorAll(".cb-mode-toggle button")].find((b) => b.textContent === label) as HTMLButtonElement;

describe("Catalog browser view (#48, flat)", () => {
  it("renders both sections with their rows, hash visible on each row", () => {
    const v = createCatalogBrowserView(data());
    expect(sectionTitles(v.el)).toEqual(["QILC runs", "Results"]);
    const rs = rows(v.el);
    expect(rs).toHaveLength(2);
    expect(rs.map((r) => r.textContent).join("|")).toContain("11aa22");
    expect(rs.map((r) => r.textContent).join("|")).toContain("ab12cd");
  });

  it("empty section shows a hint instead of nothing", () => {
    const v = createCatalogBrowserView({ qilcRuns: [], results: [{ entry: entry() }] });
    expect(v.el.textContent).toContain("none yet"); // QILC runs is empty; Results is not
    expect(rows(v.el)).toHaveLength(1);
  });

  it("selecting a Result row renders the full catalogcard in the detail pane", () => {
    const v = createCatalogBrowserView(data());
    const resultRow = rows(v.el)[1];
    resultRow.click();
    expect(resultRow.classList.contains("selected")).toBe(true);
    expect(v.el.querySelector(".catalogcard")).not.toBeNull();
    expect(v.el.querySelector(".chip")).not.toBeNull(); // catalogcard's header chip
  });

  it("selecting a QILC row renders the lighter in-progress panel, not a catalogcard", () => {
    const v = createCatalogBrowserView(data());
    const qilcRow = rows(v.el)[0];
    qilcRow.click();
    expect(qilcRow.classList.contains("selected")).toBe(true);
    expect(v.el.querySelector(".catalogcard")).toBeNull();
    expect(v.el.querySelector(".cb-panel")).not.toBeNull();
    expect(v.el.textContent).toContain("Not yet promoted to a result");
  });

  it("selecting a row collapses to the detail pane (narrow-panel behavior); Back restores the list", () => {
    const v = createCatalogBrowserView(data());
    const list = v.el.querySelector(".cb-list")!;
    const detail = v.el.querySelector(".cb-detail")!;
    expect(list.classList.contains("cb-hidden")).toBe(false);

    rows(v.el)[1].click();
    expect(list.classList.contains("cb-hidden")).toBe(true);
    expect(detail.classList.contains("cb-hidden")).toBe(false);

    const backBtn = v.el.querySelector(".cb-back") as HTMLButtonElement;
    backBtn.click();
    expect(list.classList.contains("cb-hidden")).toBe(false);
    expect(detail.classList.contains("cb-hidden")).toBe(true);
  });

  it("only one row is selected at a time", () => {
    const v = createCatalogBrowserView(data());
    const [qilc, result] = rows(v.el);
    qilc.click();
    expect(qilc.classList.contains("selected")).toBe(true);
    result.click();
    expect(qilc.classList.contains("selected")).toBe(false);
    expect(result.classList.contains("selected")).toBe(true);
  });
});

describe("Catalog browser view — flat/grouped A/B toggle (#48b)", () => {
  it("defaults to flat, with the Flat toggle marked active and no groups rendered", () => {
    const v = createCatalogBrowserView(groupableData());
    expect(toggleBtn(v.el, "Flat").classList.contains("active")).toBe(true);
    expect(toggleBtn(v.el, "By system · gate").classList.contains("active")).toBe(false);
    expect(v.el.querySelector(".cb-group")).toBeNull();
    expect(rows(v.el)).toHaveLength(4); // 2 qilc + 2 results, still all present flat
  });

  it("switching to grouped nests rows under system, then gate, without losing any row", () => {
    const v = createCatalogBrowserView(groupableData());
    toggleBtn(v.el, "By system · gate").click();
    expect(toggleBtn(v.el, "By system · gate").classList.contains("active")).toBe(true);
    expect(toggleBtn(v.el, "Flat").classList.contains("active")).toBe(false);

    expect(groupTitles(v.el).sort()).toEqual(["fluxonium", "transmon", "transmon"].sort()); // one per section
    expect(rows(v.el)).toHaveLength(4); // same 4 rows, just regrouped

    // transmon's Results group contains a "CZ" subgroup and an "X" subgroup.
    const subgroupLabels = [...v.el.querySelectorAll(".cb-subgroup > .dim")].map((n) => n.textContent);
    expect(subgroupLabels).toEqual(expect.arrayContaining(["CZ", "H", "X"]));
  });

  it("selection and detail rendering still work in grouped mode", () => {
    const v = createCatalogBrowserView(groupableData());
    toggleBtn(v.el, "By system · gate").click();
    const someRow = rows(v.el).find((r) => r.textContent?.includes("11aa22"))!;
    someRow.click();
    expect(someRow.classList.contains("selected")).toBe(true);
    expect(v.el.querySelector(".cb-panel")).not.toBeNull(); // the qilc-run detail panel
  });

  it("selection survives switching modes — same row elements are reused, not recreated", () => {
    const v = createCatalogBrowserView(groupableData());
    const flatRow = rows(v.el).find((r) => r.textContent?.includes("11aa22"))!;
    flatRow.click();
    expect(flatRow.classList.contains("selected")).toBe(true);

    toggleBtn(v.el, "By system · gate").click();
    const sameRow = rows(v.el).find((r) => r.textContent?.includes("11aa22"))!;
    expect(sameRow).toBe(flatRow); // identical node, just moved to a new parent
    expect(sameRow.classList.contains("selected")).toBe(true);
  });
});
