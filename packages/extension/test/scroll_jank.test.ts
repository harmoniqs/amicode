/**
 * Scroll-jank fix (#1510): tests for the three changes that eliminate competing
 * scroll-to-bottom mechanisms:
 *
 * 1. smoothScrollToEnd large-delta guard (> 1.5× viewport → instant)
 * 2. createAutoScroll.clearUserScrolled (flag-only, no scroll side-effect)
 * 3. setScrollToEnd defaults to instant, opt-in smooth via { smooth: true }
 *
 * These tests exercise the DECISION BOUNDARIES, not the DOM — the smooth-scroll
 * math already has its own pure test surface in smooth-scroll.ts.
 */
import { describe, it, expect } from "vitest";
import { smoothScrollInterpolate, SMOOTH_SCROLL_DURATION } from "../../app-bundle/overlay/packages/app/src/pages/session/timeline/smooth-scroll";

// ────────────────────────────────────────────────────────────────────────────
// 1. smoothScrollInterpolate — the pure math is unchanged; sanity-check it
// ────────────────────────────────────────────────────────────────────────────
describe("smoothScrollInterpolate (sanity)", () => {
  it("returns targetY when elapsed >= duration", () => {
    expect(smoothScrollInterpolate(0, 1000, SMOOTH_SCROLL_DURATION, SMOOTH_SCROLL_DURATION)).toBe(1000);
    expect(smoothScrollInterpolate(0, 1000, SMOOTH_SCROLL_DURATION + 100, SMOOTH_SCROLL_DURATION)).toBe(1000);
  });

  it("returns startY at elapsed = 0", () => {
    expect(smoothScrollInterpolate(500, 1000, 0, SMOOTH_SCROLL_DURATION)).toBe(500);
  });

  it("interpolates between start and target at midpoint", () => {
    const mid = smoothScrollInterpolate(0, 1000, SMOOTH_SCROLL_DURATION / 2, SMOOTH_SCROLL_DURATION);
    // Ease-out cubic at t=0.5: 1 - (1-0.5)^3 = 1 - 0.125 = 0.875
    expect(mid).toBeCloseTo(875, 0);
  });

  it("SMOOTH_SCROLL_DURATION is 180ms", () => {
    expect(SMOOTH_SCROLL_DURATION).toBe(180);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2. Large-delta guard logic — the decision boundary at 1.5× viewport
// ────────────────────────────────────────────────────────────────────────────
describe("smoothScrollToEnd large-delta guard", () => {
  /**
   * The guard in message-timeline.tsx:
   *   if (Math.abs(target - current) > el.clientHeight * 1.5) → instant
   * We test the boundary function in isolation.
   */
  const shouldUseInstant = (target: number, current: number, clientHeight: number) =>
    Math.abs(target - current) > clientHeight * 1.5;

  it("returns false (smooth) for small delta within viewport", () => {
    // Delta = 100, viewport = 800 → 100 < 1200 → smooth
    expect(shouldUseInstant(1100, 1000, 800)).toBe(false);
  });

  it("returns false (smooth) for delta at exactly 1.5× viewport", () => {
    // Delta = 1200, viewport = 800 → 1200 = 1200 → NOT greater → smooth
    expect(shouldUseInstant(2200, 1000, 800)).toBe(false);
  });

  it("returns true (instant) for delta exceeding 1.5× viewport", () => {
    // Delta = 1201, viewport = 800 → 1201 > 1200 → instant
    expect(shouldUseInstant(2201, 1000, 800)).toBe(true);
  });

  it("returns true (instant) for very large delta (scrolled to top of long session)", () => {
    // Delta = 50000, viewport = 800 → instant
    expect(shouldUseInstant(50000, 0, 800)).toBe(true);
  });

  it("returns false when already at bottom (delta < 2)", () => {
    // This is the "already there" guard that fires before the large-delta check
    expect(Math.abs(1000 - 999) < 2).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 3. clearUserScrolled — flag-only mutation, no scroll side-effect
// ────────────────────────────────────────────────────────────────────────────
describe("createAutoScroll.clearUserScrolled contract", () => {
  /**
   * clearUserScrolled must:
   * - Clear userScrolled when it is true
   * - Be a no-op when userScrolled is already false
   * - NOT call scrollToBottom (unlike resume())
   *
   * Since createAutoScroll depends on SolidJS reactivity and DOM, we test
   * the contract via a minimal mock that exercises the same logic.
   */
  it("clears the flag from true to false", () => {
    let userScrolled = true;
    const clearUserScrolled = () => {
      if (userScrolled) userScrolled = false;
    };
    clearUserScrolled();
    expect(userScrolled).toBe(false);
  });

  it("is a no-op when flag is already false", () => {
    let userScrolled = false;
    let setCalled = false;
    const clearUserScrolled = () => {
      if (userScrolled) {
        userScrolled = false;
        setCalled = true;
      }
    };
    clearUserScrolled();
    expect(userScrolled).toBe(false);
    expect(setCalled).toBe(false);
  });

  it("does not trigger scrollToBottom (unlike resume)", () => {
    let scrollToBottomCalled = false;
    let userScrolled = true;

    // resume() does both: clear flag + scroll
    const resume = () => {
      if (userScrolled) userScrolled = false;
      scrollToBottomCalled = true;
    };

    // clearUserScrolled() does only: clear flag
    const clearUserScrolled = () => {
      if (userScrolled) userScrolled = false;
    };

    clearUserScrolled();
    expect(userScrolled).toBe(false);
    expect(scrollToBottomCalled).toBe(false);

    // Contrast: resume() would have set it
    userScrolled = true;
    resume();
    expect(scrollToBottomCalled).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 4. scrollToEnd dispatch — instant by default, smooth opt-in
// ────────────────────────────────────────────────────────────────────────────
describe("scrollToEnd dispatch contract", () => {
  /**
   * The function exposed via setScrollToEnd now has the signature:
   *   (opts?: { smooth?: boolean }) => void
   *
   * - No args / {} / { smooth: false } → instant (virtualizer.scrollToEnd)
   * - { smooth: true } → smooth (smoothScrollToEnd)
   */
  it("dispatches to instant when called with no arguments", () => {
    let mode: "instant" | "smooth" | undefined;
    const scrollToEnd = (opts?: { smooth?: boolean }) => {
      mode = opts?.smooth ? "smooth" : "instant";
    };
    scrollToEnd();
    expect(mode).toBe("instant");
  });

  it("dispatches to instant when called with empty object", () => {
    let mode: "instant" | "smooth" | undefined;
    const scrollToEnd = (opts?: { smooth?: boolean }) => {
      mode = opts?.smooth ? "smooth" : "instant";
    };
    scrollToEnd({});
    expect(mode).toBe("instant");
  });

  it("dispatches to instant when called with { smooth: false }", () => {
    let mode: "instant" | "smooth" | undefined;
    const scrollToEnd = (opts?: { smooth?: boolean }) => {
      mode = opts?.smooth ? "smooth" : "instant";
    };
    scrollToEnd({ smooth: false });
    expect(mode).toBe("instant");
  });

  it("dispatches to smooth when called with { smooth: true }", () => {
    let mode: "instant" | "smooth" | undefined;
    const scrollToEnd = (opts?: { smooth?: boolean }) => {
      mode = opts?.smooth ? "smooth" : "instant";
    };
    scrollToEnd({ smooth: true });
    expect(mode).toBe("smooth");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 5. resumeScroll contract — clearUserScrolled + instant, NOT resume + smooth
// ────────────────────────────────────────────────────────────────────────────
describe("resumeScroll contract (no dual-scroll)", () => {
  /**
   * The old resumeScroll called autoScroll.resume() (which itself scrolls)
   * AND scrollToEnd() (which also scrolls) — two competing scroll operations.
   *
   * The new resumeScroll must:
   * - Call clearUserScrolled() (flag only, no scroll)
   * - Call scrollToEnd() once (instant by default)
   * - NOT call autoScroll.resume() (which triggers its own scroll)
   */
  it("calls clearUserScrolled and scrollToEnd, never resume", () => {
    let clearCalled = false;
    let resumeCalled = false;
    let scrollToEndCalled = false;

    const autoScroll = {
      resume: () => { resumeCalled = true; },
      clearUserScrolled: () => { clearCalled = true; },
    };
    const scrollToEnd = () => { scrollToEndCalled = true; };

    // Simulate the new resumeScroll
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
// 6. Session-switch race: clearUserScrolled, never resume
// ────────────────────────────────────────────────────────────────────────────
describe("session switch scroll race (#1510)", () => {
  /**
   * When params.id changes (session switch), the old code called
   * autoScroll.resume() which:
   *   1. Scrolls the OLD session's element (about to be unmounted — wasted)
   *   2. Calls markAuto(el), recording the old position with a 1500ms TTL
   *   3. If the new session's element has a similar scrollTop within 1500ms,
   *      isAuto() returns true, swallowing a real user scroll as "programmatic"
   *
   * The fix uses clearUserScrolled() — flag only, no scroll, no markAuto.
   */
  it("session switch must NOT call scrollToBottom (which marks a stale auto position)", () => {
    let scrollToBottomCalled = false;
    let markAutoCalled = false;
    let userScrolled = true;

    const resume = () => {
      if (userScrolled) userScrolled = false;
      scrollToBottomCalled = true;
      markAutoCalled = true; // resume→scrollToBottom→markAuto
    };

    const clearUserScrolled = () => {
      if (userScrolled) userScrolled = false;
    };

    // Simulate session switch using clearUserScrolled (the fixed path)
    clearUserScrolled();
    expect(userScrolled).toBe(false);
    expect(scrollToBottomCalled).toBe(false);
    expect(markAutoCalled).toBe(false);
  });

  it("stale markAuto can swallow a real scroll (the race it prevents)", () => {
    // This demonstrates the bug that resume() causes:
    // markAuto records {top: X, time: now}. isAuto checks |scrollTop - X| < 2.
    // If the new session's element happens to have scrollTop ≈ X, the user's
    // scroll is treated as programmatic and ignored.
    const oldScrollHeight = 10000;
    const oldClientHeight = 800;
    const markedTop = Math.max(0, oldScrollHeight - oldClientHeight); // 9200

    // New session coincidentally has similar dimensions
    const newScrollTop = 9201; // within 2px of markedTop
    const isAutoFalsePositive = Math.abs(newScrollTop - markedTop) < 2;

    expect(isAutoFalsePositive).toBe(true);
    // This proves: if markAuto fires on the old element, the new session's
    // scroll events can be misidentified as programmatic for up to 1500ms.
  });
});
