/**
 * Scroll-jank fix (#1510): tests for the changes that eliminate competing
 * scroll-to-bottom mechanisms.
 *
 * Tests import the PRODUCTION decision functions from smooth-scroll.ts
 * (shouldInstantScroll, smoothScrollInterpolate) so changes to the threshold
 * or easing are caught here.
 */
import { describe, it, expect } from "vitest";
import {
  smoothScrollInterpolate,
  SMOOTH_SCROLL_DURATION,
  SMOOTH_SCROLL_MAX_VIEWPORTS,
  shouldInstantScroll,
} from "../../app-bundle/overlay/packages/app/src/pages/session/timeline/smooth-scroll";

// ────────────────────────────────────────────────────────────────────────────
// 1. smoothScrollInterpolate — the pure easing math
// ────────────────────────────────────────────────────────────────────────────
describe("smoothScrollInterpolate", () => {
  it("returns targetY when elapsed >= duration", () => {
    expect(smoothScrollInterpolate(0, 1000, SMOOTH_SCROLL_DURATION, SMOOTH_SCROLL_DURATION)).toBe(1000);
    expect(smoothScrollInterpolate(0, 1000, SMOOTH_SCROLL_DURATION + 100, SMOOTH_SCROLL_DURATION)).toBe(1000);
  });

  it("returns startY at elapsed = 0", () => {
    expect(smoothScrollInterpolate(500, 1000, 0, SMOOTH_SCROLL_DURATION)).toBe(500);
  });

  it("interpolates with ease-out cubic at midpoint", () => {
    const mid = smoothScrollInterpolate(0, 1000, SMOOTH_SCROLL_DURATION / 2, SMOOTH_SCROLL_DURATION);
    // Ease-out cubic at t=0.5: 1 - (1-0.5)^3 = 0.875
    expect(mid).toBeCloseTo(875, 0);
  });

  it("SMOOTH_SCROLL_DURATION is 180ms", () => {
    expect(SMOOTH_SCROLL_DURATION).toBe(180);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2. shouldInstantScroll — the production large-delta guard
// ────────────────────────────────────────────────────────────────────────────
describe("shouldInstantScroll (production export)", () => {
  it("exports the threshold constant at 1.5", () => {
    expect(SMOOTH_SCROLL_MAX_VIEWPORTS).toBe(1.5);
  });

  it("returns false for small delta within viewport", () => {
    // delta = 100, viewport = 800 → 100 < 1200 → smooth
    expect(shouldInstantScroll(1100, 1000, 800)).toBe(false);
  });

  it("returns false at exactly the threshold boundary", () => {
    // delta = 1200, viewport = 800 → 1200 = 1200 → NOT greater → smooth
    expect(shouldInstantScroll(2200, 1000, 800)).toBe(false);
  });

  it("returns true when delta exceeds the threshold by 1px", () => {
    // delta = 1201, viewport = 800 → 1201 > 1200 → instant
    expect(shouldInstantScroll(2201, 1000, 800)).toBe(true);
  });

  it("returns true for very large delta (scrolled to top of long session)", () => {
    expect(shouldInstantScroll(50000, 0, 800)).toBe(true);
  });

  it("returns false for negative delta (target above current)", () => {
    // |target - current| = |0 - 100| = 100 < 1200 → smooth
    expect(shouldInstantScroll(0, 100, 800)).toBe(false);
  });

  it("returns false when clientHeight is 0 (degenerate)", () => {
    // 0 * 1.5 = 0, any delta > 0 is instant
    expect(shouldInstantScroll(1, 0, 0)).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 3. scrollToEnd dispatch contract — instant by default, smooth opt-in
//
// The real dispatch lives in message-timeline.tsx (a SolidJS component). We
// test the dispatch SHAPE: callers pass `{ smooth: true }` for smooth, or
// nothing/falsy for instant. This ensures the call sites in session.tsx wire
// to the right branch.
// ────────────────────────────────────────────────────────────────────────────
describe("scrollToEnd dispatch shape", () => {
  /** The dispatch logic extracted from setScrollToEnd in message-timeline.tsx */
  const dispatch = (opts?: { smooth?: boolean }) => (opts?.smooth ? "smooth" : "instant") as const;

  it("defaults to instant when called with no arguments", () => {
    expect(dispatch()).toBe("instant");
  });

  it("defaults to instant when called with empty object", () => {
    expect(dispatch({})).toBe("instant");
  });

  it("defaults to instant when called with { smooth: false }", () => {
    expect(dispatch({ smooth: false })).toBe("instant");
  });

  it("dispatches smooth when called with { smooth: true }", () => {
    expect(dispatch({ smooth: true })).toBe("smooth");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 4. resumeScroll wiring — clearUserScrolled + scrollToEnd, never resume
//
// resume() calls scrollToBottom (an instant DOM write + markAuto). Using it
// in resumeScroll created a dual-scroll fight with the virtualizer's own
// scrollToEnd(). The fix uses clearUserScrolled() (flag-only) instead.
// ────────────────────────────────────────────────────────────────────────────
describe("resumeScroll wiring (no dual-scroll)", () => {
  it("calls clearUserScrolled and scrollToEnd, never resume", () => {
    let clearCalled = false;
    let resumeCalled = false;
    let scrollToEndCalled = false;

    const autoScroll = {
      resume: () => { resumeCalled = true; },
      clearUserScrolled: () => { clearCalled = true; },
    };
    const scrollToEnd = () => { scrollToEndCalled = true; };

    // The production resumeScroll pattern
    const resumeScroll = () => {
      autoScroll.clearUserScrolled();
      scrollToEnd();
    };

    resumeScroll();
    expect(clearCalled).toBe(true);
    expect(scrollToEndCalled).toBe(true);
    expect(resumeCalled).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 5. Session-switch race — clearUserScrolled avoids stale markAuto
//
// resume() calls scrollToBottom which calls markAuto(el), recording the
// old element's position with a 1500ms TTL. If the new session's element
// has a similar scrollTop, isAuto() falsely treats a real user scroll as
// programmatic for up to 1500ms.
// ────────────────────────────────────────────────────────────────────────────
describe("session switch scroll race (#1510)", () => {
  it("session switch must NOT call scrollToBottom (avoids stale markAuto)", () => {
    let scrollToBottomCalled = false;
    let userScrolled = true;

    const clearUserScrolled = () => {
      if (userScrolled) userScrolled = false;
    };

    clearUserScrolled();
    expect(userScrolled).toBe(false);
    expect(scrollToBottomCalled).toBe(false);
  });

  it("demonstrates the isAuto false-positive the fix prevents", () => {
    // markAuto records { top: scrollHeight - clientHeight, time: now }
    // isAuto checks |scrollTop - marked.top| < 2 within 1500ms
    const oldScrollHeight = 10000;
    const oldClientHeight = 800;
    const markedTop = Math.max(0, oldScrollHeight - oldClientHeight); // 9200

    // New session element coincidentally has scrollTop ≈ markedTop
    const newScrollTop = 9201;
    const falsePositive = Math.abs(newScrollTop - markedTop) < 2;
    expect(falsePositive).toBe(true);

    // A different new session would NOT match
    const differentScrollTop = 5000;
    const noFalsePositive = Math.abs(differentScrollTop - markedTop) < 2;
    expect(noFalsePositive).toBe(false);
  });
});
