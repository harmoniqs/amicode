// Tests for the open_threads module — the pure/testable layer (#1305).
//
// Mirrors session_recap.test.ts: the DB-access layer (bun:sqlite) is not
// available under vitest/Node, so buildOpenThreadsBlock() itself is tested
// only as "returns null when bun:sqlite is unavailable" (graceful
// degradation). The logic it orchestrates — junk filtering, bucket
// classification, PR-state as an input feature, digest composition with
// ordering/cap/stale-flagging, env-seam thresholds — is all exercised here
// through the exported pure functions. Network-free, LLM-free.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  isJunkTitle,
  classifyThread,
  buildThread,
  composeOpenThreadsDigest,
  buildOpenThreadsBlock,
  readThreadNoulMap,
  resolveWindowDays,
  resolveMaxThreads,
  resolveStaleDays,
  JUNK_TITLE_WORDS,
  THREAD_NOUL_PROMOTION_MIN,
  DEFAULT_WINDOW_DAYS,
  DEFAULT_MAX_THREADS,
  DEFAULT_STALE_DAYS,
  type ThreadFeatures,
  type OpenThread,
} from "../opencode-plugin/open_threads";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeFeatures(overrides: Partial<ThreadFeatures> = {}): ThreadFeatures {
  return {
    title: "CZ gate design",
    lastAssistantText: "I've recorded the formulation and the plan is documented.",
    pendingTodos: 0,
    ageDays: 2,
    ...overrides,
  };
}

// ── Env-seam threshold resolution (#1305 AC7) ────────────────────────────────

describe("threshold resolution — env seams like the recap module's paths", () => {
  const orig: Record<string, string | undefined> = {
    AMICODE_OPEN_THREADS_WINDOW_DAYS: process.env.AMICODE_OPEN_THREADS_WINDOW_DAYS,
    AMICODE_OPEN_THREADS_MAX_THREADS: process.env.AMICODE_OPEN_THREADS_MAX_THREADS,
    AMICODE_OPEN_THREADS_STALE_DAYS: process.env.AMICODE_OPEN_THREADS_STALE_DAYS,
  };

  afterEach(() => {
    for (const [k, v] of Object.entries(orig)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("defaults: window 14, max 5, stale 14", () => {
    expect(DEFAULT_WINDOW_DAYS).toBe(14);
    expect(DEFAULT_MAX_THREADS).toBe(5);
    expect(DEFAULT_STALE_DAYS).toBe(14);
    expect(resolveWindowDays()).toBe(14);
    expect(resolveMaxThreads()).toBe(5);
    expect(resolveStaleDays()).toBe(14);
  });

  it("env overrides win when set to valid numbers", () => {
    process.env.AMICODE_OPEN_THREADS_WINDOW_DAYS = "7";
    process.env.AMICODE_OPEN_THREADS_MAX_THREADS = "3";
    process.env.AMICODE_OPEN_THREADS_STALE_DAYS = "30";
    expect(resolveWindowDays()).toBe(7);
    expect(resolveMaxThreads()).toBe(3);
    expect(resolveStaleDays()).toBe(30);
  });

  it("falls back to defaults on invalid values", () => {
    process.env.AMICODE_OPEN_THREADS_WINDOW_DAYS = "not-a-number";
    process.env.AMICODE_OPEN_THREADS_MAX_THREADS = "-2";
    process.env.AMICODE_OPEN_THREADS_STALE_DAYS = "";
    expect(resolveWindowDays()).toBe(14);
    expect(resolveMaxThreads()).toBe(5);
    expect(resolveStaleDays()).toBe(14);
  });
});

// ── Junk-title vocabulary (#1305 AC5) ────────────────────────────────────────

describe("isJunkTitle — junk-bucket vocabulary exclusion", () => {
  it.each([
    [""],
    ["New Session"],
    ["Greeting"],
    ["hello"],
    ["hi there"],
    ["howdy"],
    ["test"],
    ["test: quick probe"],
    ["Compaction of old messages"],
    ["compaction run"],
    ["untitled"],
    ["scratch pad"],
  ])("classifies %j as junk", (title) => {
    expect(isJunkTitle(title)).toBe(true);
  });

  it.each([
    ["CZ gate design"],
    ["Session cleanup & curation planning"],
    ["hierarchy refactor"],
    ["Testing in production — the fluxonium solve"],
    ["Integration of the fleet poller"],
  ])("keeps %j as a real thread", (title) => {
    expect(isJunkTitle(title)).toBe(false);
  });

  it("exports the junk vocabulary for audit", () => {
    expect(JUNK_TITLE_WORDS.length).toBeGreaterThan(0);
    expect(JUNK_TITLE_WORDS).toContain("greeting");
  });
});

// ── classifyThread — bucket classification (#1305 AC1–AC5) ──────────────────

describe("classifyThread — open-threads bucket classification", () => {
  const STALE = 14;

  it("blocked-on-user: last assistant text asks the user a question", () => {
    const f = makeFeatures({
      lastAssistantText: "I can route this to the cloud or run locally — which would you prefer?",
    });
    expect(classifyThread(f, STALE)).toBe("blocked-on-user");
  });

  it("blocked-on-user: states a waiting condition", () => {
    const f = makeFeatures({
      lastAssistantText: "Everything is staged. Waiting on your confirmation before I merge.",
    });
    expect(classifyThread(f, STALE)).toBe("blocked-on-user");
  });

  it("blocked-on-user: say-the-word style handoff", () => {
    const f = makeFeatures({ lastAssistantText: "Say the word and I'll spawn the sessions." });
    expect(classifyThread(f, STALE)).toBe("blocked-on-user");
  });

  it("interrupted: session ending mid-action with no wrap-up", () => {
    const f = makeFeatures({
      lastAssistantText: "Now compiling the kernel against the pinned Manifest...",
    });
    expect(classifyThread(f, STALE)).toBe("interrupted");
  });

  it("interrupted: announces an action that never completed", () => {
    const f = makeFeatures({
      lastAssistantText: "Let me re-run the sweep with the corrected bounds and compare.",
    });
    expect(classifyThread(f, STALE)).toBe("interrupted");
  });

  it("interrupted: explicit in-progress marker", () => {
    const f = makeFeatures({
      lastAssistantText: "The optimization is in progress on the cloud worker.",
    });
    expect(classifyThread(f, STALE)).toBe("interrupted");
  });

  it("interrupted: NOT classified when the text wraps up", () => {
    const f = makeFeatures({
      lastAssistantText: "Solved — F = 0.9982 in 137 iterations. The pulse is banked and we are done.",
    });
    expect(classifyThread(f, STALE)).toBeNull();
  });

  it("parked: pending todos classify at least parked", () => {
    const f = makeFeatures({
      pendingTodos: 3,
      lastAssistantText: "The plan is recorded in the campaign ledger.",
    });
    expect(classifyThread(f, STALE)).toBe("parked");
  });

  it("parked: a single pending todo", () => {
    const f = makeFeatures({ pendingTodos: 1 });
    expect(classifyThread(f, STALE)).toBe("parked");
  });

  it("awaiting-review: PR-state is an INPUT feature — no network in the module", () => {
    const f = makeFeatures({
      lastAssistantText: "The branch is pushed and the PR is up.",
      prState: "awaiting-review",
    });
    expect(classifyThread(f, STALE)).toBe("awaiting-review");
  });

  it("awaiting-review: non-awaiting PR states do not trigger the bucket", () => {
    const f = makeFeatures({ prState: "merged" });
    expect(classifyThread(f, STALE)).toBeNull();
    const draft = makeFeatures({ prState: "draft" });
    expect(classifyThread(draft, STALE)).toBeNull();
  });

  it("stale: age overrides the underlying bucket past the stale threshold", () => {
    const f = makeFeatures({
      lastAssistantText: "Waiting on your decision about the routing.",
      ageDays: 21,
    });
    expect(classifyThread(f, STALE)).toBe("stale");
  });

  it("stale: threshold is the caller-resolved seam, not hardcoded", () => {
    const f = makeFeatures({ lastAssistantText: "Which solver should I pin?", ageDays: 8 });
    expect(classifyThread(f, 7)).toBe("stale");
    expect(classifyThread(f, 14)).toBe("blocked-on-user");
  });

  it("no signal and young age: not an open thread", () => {
    expect(classifyThread(makeFeatures(), STALE)).toBeNull();
  });

  it("junk titles are excluded from classification entirely", () => {
    const f = makeFeatures({
      title: "Greeting",
      lastAssistantText: "Waiting on your call.",
    });
    expect(classifyThread(f, STALE)).toBeNull();
  });
});

// ── buildThread — classify + signal composition ──────────────────────────────

describe("buildThread — OpenThread assembly with a per-bucket signal", () => {
  it("carries the parked signal with the todo count", () => {
    const t = buildThread("ses_1", "2026-09-18T10:00:00.000Z", makeFeatures({ pendingTodos: 3 }), 14);
    expect(t).not.toBeNull();
    expect(t!.bucket).toBe("parked");
    expect(t!.signal).toContain("3");
    expect(t!.signal).toContain("todo");
  });

  it("returns null for junk titles and signal-less sessions", () => {
    expect(buildThread("ses_1", "2026-09-18T10:00:00.000Z", makeFeatures({ title: "hi" }), 14)).toBeNull();
    expect(buildThread("ses_1", "2026-09-18T10:00:00.000Z", makeFeatures(), 14)).toBeNull();
  });
});

// ── composeOpenThreadsDigest — render, order, cap, stale flag (#1305 AC6) ────

describe("composeOpenThreadsDigest — block composition", () => {
  function mk(overrides: Partial<OpenThread> = {}): OpenThread {
    return {
      sessionId: "ses_x",
      title: "Thread",
      bucket: "parked",
      signal: "2 pending todos",
      created: "2026-09-18T10:00:00.000Z",
      ageDays: 2,
      ...overrides,
    };
  }

  it("renders NOTHING when there are no open threads (honest empty state)", () => {
    expect(composeOpenThreadsDigest([], 5)).toBeNull();
  });

  it("starts with the Open threads heading", () => {
    const md = composeOpenThreadsDigest([mk()], 5)!;
    expect(md.startsWith("## Open threads")).toBe(true);
  });

  it("renders bucket, date, title and signal per entry", () => {
    const md = composeOpenThreadsDigest(
      [mk({ title: "CZ gate design", bucket: "parked", signal: "3 pending todos", created: "2026-09-18T10:00:00.000Z" })],
      5,
    )!;
    expect(md).toContain("parked");
    expect(md).toContain("CZ gate design");
    expect(md).toContain("3 pending todos");
    expect(md).toContain("Sep 18");
  });

  it("flags stale entries", () => {
    const md = composeOpenThreadsDigest([mk({ bucket: "stale", ageDays: 21 })], 5)!;
    expect(md).toContain("stale");
  });

  it("orders non-stale entries newest-first, stale entries last", () => {
    const md = composeOpenThreadsDigest(
      [
        mk({ title: "Old fresh", ageDays: 6 }),
        mk({ title: "New fresh", ageDays: 1 }),
        mk({ title: "Stale one", bucket: "stale", ageDays: 21 }),
        mk({ title: "Stale older", bucket: "stale", ageDays: 30 }),
      ],
      5,
    )!;
    const pos = (t: string) => md.indexOf(t);
    expect(pos("New fresh")).toBeLessThan(pos("Old fresh"));
    expect(pos("Old fresh")).toBeLessThan(pos("Stale one"));
    expect(pos("Stale one")).toBeLessThan(pos("Stale older"));
  });

  it("recency wins ties — equal ages keep input order", () => {
    const md = composeOpenThreadsDigest(
      [mk({ title: "First same age" }), mk({ title: "Second same age" })],
      5,
    )!;
    expect(md.indexOf("First same age")).toBeLessThan(md.indexOf("Second same age"));
  });

  it("caps at the caller-provided top-N", () => {
    const threads = Array.from({ length: 8 }, (_, i) =>
      mk({ title: `Thread ${i}`, ageDays: i + 1 }),
    );
    const md = composeOpenThreadsDigest(threads, 3)!;
    expect(md).toContain("Thread 0");
    expect(md).toContain("Thread 2");
    expect(md).not.toContain("Thread 3");
  });
});

// ── buildOpenThreadsBlock graceful degradation ───────────────────────────────

describe("buildOpenThreadsBlock — graceful degradation under Node (no bun:sqlite)", () => {
  it("returns null when bun:sqlite is unavailable (Node runtime)", () => {
    const result = buildOpenThreadsBlock("ses_current");
    expect(result).toBeNull();
  });
});

// ── Hook wiring: digest renders AFTER the recent-sessions block (#1305 AC6) ──

describe("amicode_context wiring — open-threads block follows the recap block", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "opencode-plugin", "amicode_context.ts"),
    "utf8",
  );

  it("imports buildOpenThreadsBlock from the open_threads sibling", () => {
    expect(source).toContain('from "./open_threads"');
  });

  it("pushes the open-threads block after the recent-sessions block", () => {
    const recapAt = source.indexOf("buildRecentSessionsBlock(input.sessionID)");
    const threadsAt = source.indexOf("buildOpenThreadsBlock(input.sessionID");
    expect(recapAt).toBeGreaterThan(-1);
    expect(threadsAt).toBeGreaterThan(recapAt);
  });
});

// ── #1311: the thread-Noul middle layer — ranking + promotion, labels stay deterministic ──
// The noul map is an INPUT feature (sibling of prStateFor: the amico-run pass
// spends the network; this module reads a derived map). Jev informs ranking
// and promotion ONLY — the bucket label and the no-noul ordering are exactly
// #1305's, so an absent map degrades to today's digest byte-for-byte.

describe("thread-Noul promotion — ranking + cap (#1311)", () => {
  function mk(overrides: Partial<OpenThread> = {}): OpenThread {
    return {
      session_id: "ses_x",
      title: "Thread",
      bucket: "parked",
      signal: "2 pending todos",
      created: "2026-09-18T10:00:00.000Z",
      ageDays: 2,
      ...overrides,
    };
  }

  it("exports the promotion threshold as a named constant (the curation spec's calibrated gate)", () => {
    expect(THREAD_NOUL_PROMOTION_MIN).toBe(0.5);
  });

  it("ZERO-DELTA: threads with no noul compose to exactly today's digest (no noul rendered, today's order)", () => {
    const threads = [
      mk({ session_id: "a", title: "Old fresh", ageDays: 6 }),
      mk({ session_id: "b", title: "New fresh", ageDays: 1 }),
      mk({ session_id: "c", title: "Stale one", bucket: "stale", ageDays: 21 }),
    ];
    const md = composeOpenThreadsDigest(threads, 5)!;
    expect(md).not.toContain("noul");
    const pos = (t: string) => md.indexOf(t);
    expect(pos("New fresh")).toBeLessThan(pos("Old fresh"));
    expect(pos("Old fresh")).toBeLessThan(pos("Stale one"));
  });

  it("PROMOTES: a noul ≥ 0.5 outranks recency under the cap — a capped-out thread makes the surface", () => {
    const threads = Array.from({ length: 8 }, (_, i) =>
      mk({ session_id: `t${i}`, title: `Thread ${i}`, ageDays: i + 1 }),
    );
    // threads 6 and 7 would lose the cap of 3 to recency — the noul promotes them in
    threads[6].threadNoul = 0.6;
    threads[7].threadNoul = 0.91;
    const md = composeOpenThreadsDigest(threads, 3)!;
    // promoted first, BY NOUL DESC (Jev ranks the surface), then today's order fills
    const pos = (t: string) => md.indexOf(t);
    expect(pos("Thread 7")).toBeLessThan(pos("Thread 6"));
    expect(md).toContain("Thread 0"); // the rest, today's recency order, fills the cap
    expect(md).not.toContain("Thread 2");
  });

  it("the digest CARRIES the noul per surfaced session (rendered on the line)", () => {
    const md = composeOpenThreadsDigest(
      [mk({ title: "Bug report", bucket: "blocked-on-user", signal: "waiting on you", threadNoul: 0.71 })],
      5,
    )!;
    expect(md).toContain("blocked-on-user");
    expect(md).toContain("noul 0.71");
  });

  it("a sub-threshold noul neither promotes NOR drops — fail-open keeps today's behavior for that thread", () => {
    const threads = [
      mk({ session_id: "a", title: "Promoted", ageDays: 9, threadNoul: 0.9 }),
      mk({ session_id: "b", title: "Below floor", ageDays: 1, threadNoul: 0.4 }),
      mk({ session_id: "c", title: "Plain", ageDays: 2 }),
    ];
    const md = composeOpenThreadsDigest(threads, 2)!;
    // promoted first; the 0.4 noul does NOT outrank recency but is NOT dropped either
    const pos = (t: string) => md.indexOf(t);
    expect(pos("Promoted")).toBeLessThan(pos("Below floor"));
    expect(md).toContain("Below floor"); // the cap's second slot — today's rule
    expect(md).not.toContain("Plain");
  });

  it("stale stays retirement-ranked even when promoted — promotion never outranks the retire flag", () => {
    const threads = [
      mk({ session_id: "s", title: "Stale promoted", bucket: "stale", ageDays: 30, threadNoul: 0.95 }),
      mk({ session_id: "f", title: "Fresh plain", ageDays: 1 }),
    ];
    const md = composeOpenThreadsDigest(threads, 5)!;
    const pos = (t: string) => md.indexOf(t);
    expect(pos("Fresh plain")).toBeLessThan(pos("Stale promoted")); // stale still last
  });

  it("the deterministic derivation never calls Jev — mechanical purity guard on the module source", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "opencode-plugin", "open_threads.ts"), "utf8");
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/api\.typesafe/);
    expect(source).not.toMatch(/from\s+"\.\.?\/.*jev/);
  });
});

// ── the derived noul map: the amico-run pass writes it, the digest reads it ──

describe("readThreadNoulMap — the ops-dir derived map (input feature, fail-open)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amico-thread-noul-"));
    process.env.AMICODE_OPS_DIR = tmp;
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.AMICODE_OPS_DIR;
  });

  it("reads the map the amico-run pass wrote (session id → noul)", () => {
    fs.writeFileSync(
      path.join(tmp, "thread-nouls.json"),
      JSON.stringify({ schema_version: 1, generated_at: "2026-09-20T05:00:00.000Z", entries: { ses_a: 0.71, ses_b: 0.05 } }),
    );
    expect(readThreadNoulMap()).toEqual({ ses_a: 0.71, ses_b: 0.05 });
  });

  it("a missing or corrupt map is undefined — the digest degrades to today, never to a crash", () => {
    expect(readThreadNoulMap()).toBeUndefined();
    fs.writeFileSync(path.join(tmp, "thread-nouls.json"), "{not json");
    expect(readThreadNoulMap()).toBeUndefined();
  });
});

// ── wiring: amicode_context passes the map reader as the third input feature ──

describe("amicode_context wiring — the thread-noul map rides the digest's input-feature seam", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "opencode-plugin", "amicode_context.ts"),
    "utf8",
  );

  it("buildOpenThreadsBlock receives a threadNoulFor input map (the caller spends the network)", () => {
    expect(source).toContain("buildOpenThreadsBlock(input.sessionID, undefined, threadNoulFor");
  });
});
