// jev_curation — issue #1311 (slice of #1301 session curation): the two
// confidence-gated call sites on top of the jev_client — (a) the classifier
// residual (sessions the deterministic rules leave unclassified get ONE
// Jev Choice over the closed junk-bucket set; junk-bucket p ≥ 0.95 AND
// age ≥ 48 h admits to the archive path) and (b) the onset thread-Noul
// (one Noul per digest candidate; ≥ 0.5 promotes into the open-thread
// surface — the digest itself stays deterministic).
//
// Thresholds are the curation spec's calibrated pair (spec-20260920-
// session-curation §Calibration — "never act on an ambiguous mid-confidence
// read"), named exports like the #1303 classifier's. Pure gates + question
// builders; the loops are injectable-deps (transport stubbed — no network).
// Run: `pnpm --filter @amicode/amico-run test`.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  JEV_ARCHIVE_CONFIDENCE_MIN,
  JEV_ARCHIVE_MIN_AGE_HOURS,
  JUNK_BUCKET_RUBRIC,
  jevArchiveAdmits,
  jevJunkResidual,
  jevThreadNouls,
  junkResidualQuestion,
  threadNoulQuestion,
  type NoulCandidate,
  type ResidualSession,
  type SessionFeaturesLite,
} from "../src/jev_curation.js";

function features(over: Partial<SessionFeaturesLite> = {}): SessionFeaturesLite {
  return {
    title: "CZ gate design",
    user_message_count: 6,
    user_text_chars: 412,
    assistant_message_count: 14,
    todo_count: 0,
    ...over,
  };
}

// ── the closed bucket set + the no-match option (the issue's AC 2) ────────────
describe("JUNK_BUCKET_RUBRIC — one rubric line per option, closed set + no-match", () => {
  it("covers every classifier bucket AND the unclassified no-match option", () => {
    expect(Object.keys(JUNK_BUCKET_RUBRIC).sort()).toEqual(["dead-cast", "junk-greeting", "probe", "substantive", "unclassified"]);
  });

  it("gives every option a non-empty rubric description", () => {
    for (const [option, rubric] of Object.entries(JUNK_BUCKET_RUBRIC)) {
      expect(rubric.length, option).toBeGreaterThan(10);
    }
  });
});

// ── the residual question: a deterministic fold + the choice shape ───────────
describe("junkResidualQuestion — the state fold and the choice question", () => {
  it("builds ONE choice question over the closed set; state is the deterministic fold (no raw text)", () => {
    const { question, state } = junkResidualQuestion(features({ title: "hello", user_text_chars: 12, assistant_message_count: 3 }));
    expect(question.type).toBe("choice");
    expect(question.criteria).toBe(JUNK_BUCKET_RUBRIC);
    expect(question.instructions.length).toBeGreaterThan(10);
    expect(state).toEqual({
      title: "hello",
      user_message_count: 6,
      user_text_chars: 12,
      assistant_message_count: 3,
      todo_count: 0,
    });
    // the fold carries counts and the title only — never message text
    expect(JSON.stringify(state).length).toBeLessThan(400);
  });
});

// ── the archive admission gate: p ≥ 0.95 AND age ≥ 48 h, never an ambiguous read ──
describe("jevArchiveAdmits — the calibrated pair", () => {
  it("exports the spec's thresholds as named constants", () => {
    expect(JEV_ARCHIVE_CONFIDENCE_MIN).toBe(0.95);
    expect(JEV_ARCHIVE_MIN_AGE_HOURS).toBe(48);
  });

  it("admits a junk-bucket read at p ≥ 0.95 AND age ≥ 48 h (boundaries inclusive)", () => {
    expect(jevArchiveAdmits("junk-greeting", 0.95, 48)).toBe(true);
    expect(jevArchiveAdmits("dead-cast", 0.99, 100)).toBe(true);
    expect(jevArchiveAdmits("probe", 1.0, 72)).toBe(true);
  });

  it("never admits below the confidence floor — 0.94 is an ambiguous read", () => {
    expect(jevArchiveAdmits("junk-greeting", 0.94, 100)).toBe(false);
    expect(jevArchiveAdmits("dead-cast", 0.75, 100)).toBe(false); // the fleet-smoke shape: never act on a 0.75
  });

  it("never admits a session younger than the fixed 48 h Jev age gate", () => {
    expect(jevArchiveAdmits("junk-greeting", 0.99, 47)).toBe(false);
    expect(jevArchiveAdmits("junk-greeting", 0.99, 0)).toBe(false);
  });

  it("never admits a substantive or no-match verdict — the label must be a JUNK bucket", () => {
    expect(jevArchiveAdmits("substantive", 1.0, 100)).toBe(false);
    expect(jevArchiveAdmits("unclassified", 1.0, 100)).toBe(false);
  });

  it("a missing verdict (call failed / no answer) admits nothing — fail-open", () => {
    expect(jevArchiveAdmits(undefined, 0, 100)).toBe(false);
  });
});

// ── the loops: one call per residual/candidate session, fail-open per session ──

/** A hermetic world for the loop tests: temp key + temp receipts. */
function loopWorld(): { root: string; env: Record<string, string>; receipts: string } {
  const root = mkdtempSync(join(tmpdir(), "amico-jev-cur-"));
  const key = join(root, "key");
  writeFileSync(key, "k_test_cur", { mode: 0o600 });
  const receipts = join(root, "receipts", "receipts.jsonl");
  return { root, env: { AMICO_TYPESAFE_KEY_FILE: key, AMICO_TYPESAFE_RECEIPTS: receipts }, receipts };
}

function residualSession(id: string, over: Partial<SessionFeaturesLite> = {}, ageHours = 72): ResidualSession {
  return { id, features: features(over), ageHours };
}

describe("jevJunkResidual — the classifier residual loop", () => {
  it("makes exactly ONE choice call per residual session, in order, and returns per-session verdicts", async () => {
    const w = loopWorld();
    try {
      const bodies: unknown[] = [];
      const transport = async (_url: string, init: { body: string }) => {
        bodies.push(JSON.parse(init.body));
        const questionId = Object.keys(JSON.parse(init.body).questions)[0];
        return {
          status: 200,
          text: async () => JSON.stringify({ model: "jev-1.13.0", answers: { [questionId]: { type: "choice", choice: "substantive", confidence: 1.0 } }, usage: { input_tokens: 500, output_tokens: 21 } }),
        };
      };

      const res = await jevJunkResidual([residualSession("ses_a"), residualSession("ses_b", { title: "hello", user_text_chars: 12, assistant_message_count: 2 })], { env: w.env, transport });

      expect(res.status).toBe("ran");
      expect(res.verdicts.ses_a).toEqual({ choice: "substantive", confidence: 1.0 });
      expect(res.verdicts.ses_b).toEqual({ choice: "substantive", confidence: 1.0 });
      // exactly one call per session, one question per call, the residual question shape
      expect(bodies).toHaveLength(2);
      for (const b of bodies as { questions: Record<string, { type: string; criteria: unknown }> }[]) {
        expect(Object.keys(b.questions)).toHaveLength(1);
        expect(Object.values(b.questions)[0].type).toBe("choice");
        expect(Object.values(b.questions)[0].criteria).toEqual(JUNK_BUCKET_RUBRIC);
      }
    } finally {
      rmSync(w.root, { recursive: true, force: true });
    }
  });

  it("a failing call for one session fails OPEN for that session only — the others still judge", async () => {
    const w = loopWorld();
    try {
      let n = 0;
      const transport = async () => {
        n += 1;
        if (n === 1) return { status: 200, text: async () => JSON.stringify({ model: "jev-1.13.0", answers: { junk_bucket: { type: "choice", choice: "junk-greeting", confidence: 0.97 } }, usage: { input_tokens: 1, output_tokens: 1 } }) };
        return { status: 500, text: async () => "boom" };
      };

      const res = await jevJunkResidual([residualSession("ses_ok"), residualSession("ses_down")], { env: w.env, transport });

      expect(res.verdicts.ses_ok).toEqual({ choice: "junk-greeting", confidence: 0.97 });
      expect(res.verdicts.ses_down).toEqual({ error: expect.any(String) });
      // the gate composes: only the healthy read can admit
      expect(jevArchiveAdmits(res.verdicts.ses_ok.choice, res.verdicts.ses_ok.confidence ?? 0, 72)).toBe(true);
      expect(jevArchiveAdmits(res.verdicts.ses_down.choice, res.verdicts.ses_down.confidence ?? 0, 72)).toBe(false);
    } finally {
      rmSync(w.root, { recursive: true, force: true });
    }
  });

  it("no key → status unavailable, ZERO transport calls (the primary test configuration)", async () => {
    const w = loopWorld();
    rmSync(w.root, { recursive: true, force: true }); // key gone with the world
    const calls: number[] = [];
    const transport = async () => {
      calls.push(1);
      return { status: 200, text: async () => "{}" };
    };

    const res = await jevJunkResidual([residualSession("ses_a")], { env: { AMICO_TYPESAFE_KEY_FILE: "/nonexistent/key", AMICO_TYPESAFE_RECEIPTS: "/tmp/x.jsonl" }, transport });
    expect(res.status).toBe("unavailable");
    expect(res.verdicts).toEqual({});
    expect(calls).toHaveLength(0);
  });

  it("off-switch → status disabled, zero calls, zero delta", async () => {
    const calls: number[] = [];
    const transport = async () => {
      calls.push(1);
      return { status: 200, text: async () => "{}" };
    };
    const res = await jevJunkResidual([residualSession("ses_a")], { env: { AMICO_JEV_DISABLED: "1" }, transport });
    expect(res.status).toBe("disabled");
    expect(calls).toHaveLength(0);
  });
});

describe("jevThreadNouls — the onset digest's noul map", () => {
  function candidate(id: string, over: Partial<NoulCandidate> = {}): NoulCandidate {
    return { id, title: `Thread ${id}`, lastAssistantText: "Which solver should I pin?", pendingTodos: 1, ...over };
  }

  it("builds ONE noul question per candidate: true/false criteria, digest-sized state", () => {
    const { question, state } = threadNoulQuestion(candidate("ses_x", { lastAssistantText: "Waiting on your call.".repeat(400) }));
    expect(question.type).toBe("noul");
    expect(question.criteria).toHaveProperty("true");
    expect(question.criteria).toHaveProperty("false");
    // the fold truncates the text — digests, never spines
    expect(JSON.stringify(state).length).toBeLessThan(600);
  });

  it("makes ONE noul call per candidate and returns the map; failures fail open (session absent from the map)", async () => {
    const w = loopWorld();
    try {
      let n = 0;
      const transport = async (_url: string, init: { body: string }) => {
        n += 1;
        const questionId = Object.keys(JSON.parse(init.body).questions)[0];
        if (n === 2) return { status: 503, text: async () => "down" };
        return { status: 200, text: async () => JSON.stringify({ model: "jev-1.13.0", answers: { [questionId]: { type: "noul", noul: 0.71 } }, usage: { input_tokens: 300, output_tokens: 9 } }) };
      };

      const res = await jevThreadNouls([candidate("ses_a"), candidate("ses_b")], { env: w.env, transport });
      expect(res.status).toBe("ran");
      expect(res.nouls).toEqual({ ses_a: 0.71 }); // ses_b failed → absent, never a guessed 0
    } finally {
      rmSync(w.root, { recursive: true, force: true });
    }
  });

  it("no key / off-switch → unavailable / disabled with an EMPTY map (the digest degrades to today)", async () => {
    const transport = async () => ({ status: 200, text: async () => "{}" });
    const off = await jevThreadNouls([candidate("ses_a")], { env: { AMICO_JEV_DISABLED: "1" }, transport });
    expect(off.status).toBe("disabled");
    expect(off.nouls).toEqual({});
    const missing = await jevThreadNouls([candidate("ses_a")], { env: { AMICO_TYPESAFE_KEY_FILE: "/nonexistent" }, transport });
    expect(missing.status).toBe("unavailable");
    expect(missing.nouls).toEqual({});
  });
});
