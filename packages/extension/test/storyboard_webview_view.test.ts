// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { createStoryboardView, FRAMES } from "../media/ui/views/storyboard";

// Coverage for the #46 storyboard frame sequencer: navigation bounds, the
// step counter, and the "rendered by AskUserQuestion in v1" note that must
// appear on EVERY frame (the issue's explicit guard against relitigating the
// v1 rendering decision). Runs under happy-dom because atoms inject styles
// via constructable stylesheets (`new CSSStyleSheet()`), which jsdom can't
// model.

const stepText = (el: HTMLElement) => el.querySelector(".mono.small.dim")?.textContent;
const noteText = (el: HTMLElement) => el.querySelector(".rendered-note")?.textContent;
const buttons = (el: HTMLElement) => [...el.querySelectorAll("button")] as HTMLButtonElement[];

describe("Storyboard view (#46)", () => {
  it("starts on frame 1 of N with Prev disabled and Next enabled", () => {
    const v = createStoryboardView();
    expect(stepText(v.el)).toBe(`Step 1 of ${FRAMES.length}`);
    const [prev, next] = buttons(v.el);
    expect(prev.disabled).toBe(true);
    expect(next.disabled).toBe(false);
  });

  it("Next advances the frame and updates the step counter; Prev goes back", () => {
    const v = createStoryboardView();
    const [prev, next] = buttons(v.el);
    next.click();
    expect(stepText(v.el)).toBe(`Step 2 of ${FRAMES.length}`);
    next.click();
    expect(stepText(v.el)).toBe(`Step 3 of ${FRAMES.length}`);
    prev.click();
    expect(stepText(v.el)).toBe(`Step 2 of ${FRAMES.length}`);
  });

  it("Next disables on the last frame; Prev disables back on the first", () => {
    const v = createStoryboardView();
    const [prev, next] = buttons(v.el);
    for (let i = 0; i < FRAMES.length - 1; i++) next.click();
    expect(stepText(v.el)).toBe(`Step ${FRAMES.length} of ${FRAMES.length}`);
    expect(next.disabled).toBe(true);
    next.click(); // no-op past the end
    expect(stepText(v.el)).toBe(`Step ${FRAMES.length} of ${FRAMES.length}`);

    for (let i = 0; i < FRAMES.length - 1; i++) prev.click();
    expect(prev.disabled).toBe(true);
    prev.click(); // no-op before the start
    expect(stepText(v.el)).toBe(`Step 1 of ${FRAMES.length}`);
  });

  it("every frame carries the AskUserQuestion-v1 note — never a bespoke chat surface", () => {
    const v = createStoryboardView();
    const [, next] = buttons(v.el);
    for (let i = 0; i < FRAMES.length; i++) {
      expect(noteText(v.el)).toMatch(/Rendered by AskUserQuestion in v1/);
      next.click();
    }
  });

  it("the final frame previews a tagged pulse via the shared chip component", () => {
    const v = createStoryboardView();
    const [, next] = buttons(v.el);
    for (let i = 0; i < FRAMES.length - 1; i++) next.click();
    expect(v.el.querySelector(".chip")).not.toBeNull();
    expect(v.el.textContent).toContain("Saved to the catalog automatically");
  });

  it("accepts a custom frame list (test seam, not just the baked default)", () => {
    const custom = [
      { section: "System setup" as const, title: "Only frame", groups: [{ prompt: "p", options: ["a"], defaultIndex: 0 }] },
    ];
    const v = createStoryboardView(custom);
    expect(stepText(v.el)).toBe("Step 1 of 1");
    const [prev, next] = buttons(v.el);
    expect(prev.disabled).toBe(true);
    expect(next.disabled).toBe(true);
  });
});
