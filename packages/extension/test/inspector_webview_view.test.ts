// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { createInspectorView } from "../media/ui/views/inspector";

// Coverage for the 1.3 webview ROUTER (freeze-2, runId-keyed protocol): per-run
// pane isolation, `activate` pane-toggling, the empty-state hint, and #67's
// plot-only pulse (a pulse must never touch the badge). Closes the gap the
// adversarial review flagged — half the slice's guarantee lives here and was
// asserted only by comments.
//
// The pane MARKUP is the design lane (UX4 #49): these assertions target the
// router CONTRACT + observable badge/visibility, not class names beyond
// .pane/.active/.pill. Runs under happy-dom because the atoms inject styles via
// constructable stylesheets (`new CSSStyleSheet()`), which jsdom can't model.

const iter = (runId: string, n: number) => ({
  type: "iteration",
  runId,
  iter: n,
  f_val: 1e-2,
  eq_viol: 1e-8,
  kkt_error: 1e-6,
});
const panes = (v: { el: HTMLElement }) => [...v.el.querySelectorAll(".pane")];
const activePane = (v: { el: HTMLElement }) => v.el.querySelector(".pane.active");
// The RUN-STATE pill specifically. The topbar now carries a second pill (the
// Harmoniqs Cloud location badge), so a bare ".pill" query returns whichever
// comes first in the DOM. role=status is the status pill's own semantic hook —
// the same one a screen reader keys off — so it is the honest selector here.
const pillText = (pane: Element | null | undefined) => pane?.querySelector(".pill[role=status]")?.textContent;

describe("Inspector webview router (1.3 per-run panes)", () => {
  it("activate shows exactly one pane and hides the empty-state hint", () => {
    const v = createInspectorView(() => {});
    expect(v.el.querySelectorAll(".pane.active")).toHaveLength(0);
    const emptyHint = v.el.firstElementChild as HTMLElement; // the idle hint, appended first
    expect(emptyHint.style.display).not.toBe("none");

    v.onMessage(iter("r1", 3));
    v.onMessage(iter("r2", 4));
    expect(panes(v)).toHaveLength(2);
    expect(v.el.querySelectorAll(".pane.active")).toHaveLength(0); // panes exist but none shown yet

    v.onMessage({ type: "activate", runId: "r2" });
    expect(v.el.querySelectorAll(".pane.active")).toHaveLength(1);
    expect(panes(v)[1].classList.contains("active")).toBe(true); // r2 = 2nd-created pane
    expect(panes(v)[0].classList.contains("active")).toBe(false);
    expect(emptyHint.style.display).toBe("none");
  });

  it("activate before any data still creates and shows the pane", () => {
    const v = createInspectorView(() => {});
    v.onMessage({ type: "activate", runId: "rX" });
    expect(panes(v)).toHaveLength(1);
    expect(panes(v)[0].classList.contains("active")).toBe(true);
    expect((v.el.firstElementChild as HTMLElement).style.display).toBe("none");
  });

  it("a background run's iteration never mutates the active pane (no cross-talk)", () => {
    const v = createInspectorView(() => {});
    v.onMessage({ type: "activate", runId: "r1" });
    v.onMessage(iter("r1", 3));
    const r1 = activePane(v)!;
    expect(pillText(r1)).toBe("running");

    // r2 is a background run — its iteration must land in ITS pane, not r1's.
    v.onMessage(iter("r2", 99));
    expect(pillText(activePane(v))).toBe("running"); // r1 badge unchanged
    const r2 = panes(v).find((p) => !p.classList.contains("active"))!;
    expect(pillText(r2)).toBe("running"); // r2 has its OWN running badge
    expect(r1.textContent).toContain("3"); // r1 still reads iter 3…
    expect(r1.textContent).not.toContain("99"); // …not r2's 99 (no value bleed)
  });

  it("pulse is plot-only — it never touches the active pane's badge (#67)", () => {
    const v = createInspectorView(() => {});
    v.onMessage({ type: "activate", runId: "r1" });
    const r1 = activePane(v)!;
    expect(pillText(r1)).toBe("idle");
    v.onMessage({ type: "pulsemeta", runId: "r1", drives: 1, knots: 2, labels: ["a_1"], bounds: [[-0.2, 0.2]] });
    v.onMessage({ type: "pulse", runId: "r1", iter: 1, dt: 0.2, values: [[0.1, 0.2]] });
    expect(pillText(r1)).toBe("idle"); // pulse did NOT flip the badge
  });

  it("switching activate moves the visible pane, each pane keeps its own state", () => {
    const v = createInspectorView(() => {});
    v.onMessage(iter("r1", 1));
    v.onMessage({ type: "completed", runId: "r1", status: "completed", fidelity: 0.999 }); // hidden pane still updates
    v.onMessage(iter("r2", 2));
    v.onMessage({ type: "activate", runId: "r1" });
    expect(pillText(activePane(v))).toBe("converged"); // r1 terminal badge shows on activate
    v.onMessage({ type: "activate", runId: "r2" });
    expect(v.el.querySelectorAll(".pane.active")).toHaveLength(1);
    expect(pillText(activePane(v))).toBe("running"); // now r2 is visible
    const r1 = panes(v).find((p) => !p.classList.contains("active"))!;
    expect(pillText(r1)).toBe("converged"); // r1 untouched by the switch
  });
});

// The location badge: the answer to "is this run on the tier I'm paying for?".
// Asserted through the real DOM the user sees, not the stylesheet source.
const cloudBadge = (pane: Element | null | undefined) =>
  [...(pane?.querySelectorAll(".pill") ?? [])].find((p) => p.textContent === "Harmoniqs Cloud");

describe("Harmoniqs Cloud location badge", () => {
  it("is absent from a pane until a location message says cloud", () => {
    const v = createInspectorView(() => {});
    v.onMessage({ type: "activate", runId: "r1" });
    const badge = cloudBadge(activePane(v));
    // present in the DOM but hidden — a local run shows no cloud chrome at all
    expect((badge as HTMLElement | undefined)?.hidden).toBe(true);
  });

  it("appears on the run it was sent for, and NOT on a sibling local run", () => {
    const v = createInspectorView(() => {});
    v.onMessage({ type: "activate", runId: "rCloud" });
    v.onMessage({ type: "location", runId: "rCloud", cloud: true });
    v.onMessage(iter("rLocal", 1)); // a second, local run in its own pane
    const cloudPane = [...panes(v)].find((p) => !(cloudBadge(p) as HTMLElement).hidden);
    expect(cloudPane).toBeTruthy();
    // exactly one pane claims the cloud — panes must not leak each other's state
    expect(panes(v).filter((p) => !(cloudBadge(p) as HTMLElement).hidden)).toHaveLength(1);
  });

  it("a location message without cloud:true never lights the badge", () => {
    const v = createInspectorView(() => {});
    v.onMessage({ type: "activate", runId: "r1" });
    v.onMessage({ type: "location", runId: "r1" }); // malformed / local
    expect((cloudBadge(activePane(v)) as HTMLElement).hidden).toBe(true);
  });

  it("the badge does not disturb the run-state pill beside it", () => {
    const v = createInspectorView(() => {});
    v.onMessage({ type: "activate", runId: "r1" });
    v.onMessage({ type: "location", runId: "r1", cloud: true });
    v.onMessage(iter("r1", 3));
    expect(pillText(activePane(v))).toBe("running");
  });
});
