// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { createCatalogBrowserView, type CatalogBrowserData } from "../media/ui/views/catalogbrowser";
import type { CatalogEntry } from "../media/ui/components/catalogcard";

// Coverage for the #48 (flat) catalog browser: section rendering, row
// selection → detail pane (catalogcard reuse for Results, lighter panel for
// QILC runs), and the narrow-panel master-detail collapse (back button).
// Runs under happy-dom because atoms/components inject styles via
// constructable stylesheets, which jsdom can't model.

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

const rows = (el: HTMLElement) => [...el.querySelectorAll(".cb-row")] as HTMLButtonElement[];
const sectionTitles = (el: HTMLElement) => [...el.querySelectorAll(".cb-section .label-k")].map((n) => n.textContent);

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
