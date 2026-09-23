// session_junk — issue #1303 (slice of #1301 session curation): the
// deterministic junk classifier for top-level chat sessions. Pure core: a
// classifier of session-features objects, never a DB reader (the caller maps
// rows). Table-driven per the issue's testing decision: one case per
// acceptance criterion plus the 2026-09-20 manual-sweep calibration cases.
// Run: `pnpm --filter @amicode/amico-run test`.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  classifySession,
  JUNK_GREETING_MAX_USER_CHARS,
  JUNK_GREETING_MAX_ASSISTANT_MESSAGES,
  GREETING_TITLE_VOCABULARY,
  type SessionFeatures,
} from "../src/session_junk.js";

/** A plausible substantive baseline — the sweep's live campaign sessions look
 *  like this (many turns, hundreds of chars). Each case overrides what matters. */
function features(over: Partial<SessionFeatures> = {}): SessionFeatures {
  return {
    title: "Session cleanup & curation planning",
    user_message_count: 6,
    user_text_chars: 412,
    assistant_message_count: 14,
    todo_count: 0,
    ...over,
  };
}

// ── thresholds are named module constants (the nightly archiver reads them) ──
describe("named threshold constants", () => {
  it("exports the sweep-calibrated thresholds and the greeting vocabulary", () => {
    expect(JUNK_GREETING_MAX_USER_CHARS).toBe(40);
    expect(JUNK_GREETING_MAX_ASSISTANT_MESSAGES).toBe(6);
    expect(GREETING_TITLE_VOCABULARY).toContain("hello");
    expect(GREETING_TITLE_VOCABULARY).toContain("hi");
    expect(GREETING_TITLE_VOCABULARY).toContain("howdy");
    expect(GREETING_TITLE_VOCABULARY).toContain("test");
    expect(GREETING_TITLE_VOCABULARY).toContain("smoke");
  });
});

// ── AC 1: greeting-titled, < 40 user chars, no todos, ≤ 6 assistant → junk ──
describe("AC 1 — greeting-titled low-activity sessions classify junk-greeting", () => {
  it("classifies every greeting-vocabulary title as junk-greeting when features are junk-shaped", () => {
    // 2026-09-20 sweep calibration: the greeting titles actually observed.
    const greetingTitles = [
      "hello",
      "hi",
      "Howdy greeting",
      "Friendly greeting",
      "test",
      "one-word reply test",
      "fleet-smoke",
    ];
    for (const title of greetingTitles) {
      expect(classifySession(features({ title, user_text_chars: 12, assistant_message_count: 3 })), title).toBe(
        "junk-greeting",
      );
    }
  });

  it("matches vocabulary on word boundaries, not substrings", () => {
    // "hi" must not match inside "history"; "test" must not match "protest".
    expect(
      classifySession(features({ title: "Shipping history replay", user_text_chars: 12, assistant_message_count: 3 })),
    ).toBe("substantive");
  });

  it("holds at the boundary: exactly 6 assistant messages is still junk, 40 user chars is not", () => {
    expect(
      classifySession(features({ title: "hello", user_text_chars: 12, assistant_message_count: 6 })),
    ).toBe("junk-greeting");
    expect(
      classifySession(features({ title: "hello", user_text_chars: 40, assistant_message_count: 3 })),
    ).toBe("substantive");
  });
});

// ── AC 2: zero assistant messages and ≤ 1 user message → dead-cast ──────────
describe("AC 2 — silent casts classify dead-cast regardless of title", () => {
  it("classifies one-user-message no-reply sessions as dead-cast even with a long substantive title", () => {
    expect(
      classifySession(
        features({
          title: "Deep architectural refactor of the ingestion pipeline and its scheduler",
          user_message_count: 1,
          user_text_chars: 500,
          assistant_message_count: 0,
        }),
      ),
    ).toBe("dead-cast");
  });

  it("dead-cast wins over junk-greeting when both rules fire (title is irrelevant)", () => {
    expect(
      classifySession(
        features({ title: "hello", user_message_count: 1, user_text_chars: 5, assistant_message_count: 0 }),
      ),
    ).toBe("dead-cast");
  });

  it("two user messages with no assistant reply are NOT dead-cast (curation never loses work)", () => {
    expect(
      classifySession(features({ user_message_count: 2, user_text_chars: 90, assistant_message_count: 0 })),
    ).toBe("substantive");
  });
});

// ── AC 3: zero user and zero assistant messages → probe ─────────────────────
describe("AC 3 — empty sessions classify probe", () => {
  it("classifies a session that was opened but never used as probe", () => {
    expect(
      classifySession(
        features({ title: "New session - 2026-09-20T08:31", user_message_count: 0, user_text_chars: 0, assistant_message_count: 0 }),
      ),
    ).toBe("probe");
  });

  it("probe wins over junk-greeting for an empty greeting-titled session", () => {
    expect(
      classifySession(features({ title: "hello", user_message_count: 0, user_text_chars: 0, assistant_message_count: 0 })),
    ).toBe("probe");
  });
});

// ── AC 4: greeting title but > 6 assistant messages → substantive ───────────
describe("AC 4 — a greeting title cannot junk a session with real activity", () => {
  it("classifies a greeting-titled session with 7 assistant messages as substantive", () => {
    expect(
      classifySession(features({ title: "hello", user_text_chars: 12, assistant_message_count: 7 })),
    ).toBe("substantive");
  });
});

// ── AC 5: pending todos never classify into a junk bucket ───────────────────
describe("AC 5 — todos make a session substantive, full stop", () => {
  it("overrides junk-greeting", () => {
    expect(
      classifySession(
        features({ title: "hello", user_text_chars: 5, assistant_message_count: 2, todo_count: 1 }),
      ),
    ).toBe("substantive");
  });

  it("overrides dead-cast and probe", () => {
    expect(
      classifySession(
        features({ title: "test", user_message_count: 1, user_text_chars: 3, assistant_message_count: 0, todo_count: 2 }),
      ),
    ).toBe("substantive");
    expect(
      classifySession(
        features({ user_message_count: 0, user_text_chars: 0, assistant_message_count: 0, todo_count: 1 }),
      ),
    ).toBe("substantive");
  });
});

// ── AC 6: the classifier is pure — features in, bucket out, nothing else ────
describe("AC 6 — purity", () => {
  it("is deterministic: identical features always yield the identical bucket", () => {
    const f = features({ title: "hi", user_text_chars: 9, assistant_message_count: 1 });
    const first = classifySession(f);
    expect(first).toBe("junk-greeting");
    for (let i = 0; i < 5; i++) expect(classifySession(f)).toBe(first);
  });

  it("imports no I/O, network, or environment surface (mechanical purity guard)", () => {
    const src = readFileSync(join(__dirname, "..", "src", "session_junk.ts"), "utf8");
    expect(src).not.toMatch(/from\s+"node:/);
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/process\.env/);
    expect(src).not.toMatch(/require\s*\(/);
  });

  it("does not mutate its input", () => {
    const f = features({ title: "hi", user_text_chars: 9, assistant_message_count: 1 });
    const snapshot = JSON.stringify(f);
    classifySession(f);
    expect(JSON.stringify(f)).toBe(snapshot);
  });
});

// ── sweep calibration: the live campaign session stays substantive ──────────
describe("2026-09-20 sweep calibration — real sessions", () => {
  it("classifies the live campaign session as substantive", () => {
    expect(
      classifySession(
        features({
          title: "Session cleanup & curation planning",
          user_message_count: 11,
          user_text_chars: 1400,
          assistant_message_count: 25,
          todo_count: 3,
        }),
      ),
    ).toBe("substantive");
  });
});
