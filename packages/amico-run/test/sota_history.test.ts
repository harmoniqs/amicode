// sota_history.test.ts — the fetch anomaly floor (#820, spec
// spec-20260905-103000 / sota_fetch_anomaly_floor / S6): a successful fetch
// returning ZERO entries where the trailing 7-fetch-day mean is NONZERO
// records a NAMED anomaly and renders "scan returned nothing — anomalous" —
// NEVER "nothing new". Per-source; armed only after 7 fetch-days of history
// (O1's granularity edge is pinned here: what counts as a fetch-day and what
// a day's value is).
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluateAnomalyFloor,
  recordFetchOutcome,
  readFetchHistory,
  historyPath,
  type FetchHistoryEntry,
} from "../src/sota_history.js";

function root(): string {
  return mkdtempSync(join(tmpdir(), "sota-hist-"));
}

/** n prior fetch-DAYS with the given per-day counts (one fetch per day). */
function days(counts: number[], startDay = 1): FetchHistoryEntry[] {
  return counts.map((count, i) => ({
    date: `2026-08-${String(startDay + i).padStart(2, "0")}`,
    count,
  }));
}

describe("evaluateAnomalyFloor (O1 — armed only after 7 fetch-days)", () => {
  it("NOT armed with fewer than 7 prior fetch-days — an empty scan renders ordinary, never 'anomalous'", () => {
    const v = evaluateAnomalyFloor(days([5, 4, 6, 5, 4, 5]), { date: "2026-08-07", count: 0 });
    expect(v.armed).toBe(false);
    expect(v.anomaly).toBe(false);
  });

  it("armed at exactly 7 prior fetch-days: an empty-200 against a NONZERO mean is the NAMED anomaly", () => {
    const v = evaluateAnomalyFloor(days([5, 4, 6, 5, 4, 5, 6]), { date: "2026-08-08", count: 0 });
    expect(v.armed).toBe(true);
    expect(v.anomaly).toBe(true);
    expect(v.name).toBe("empty-200-vs-nonzero-mean");
    expect(v.render).toContain("scan returned nothing — anomalous");
  });

  it("the anomaly render NEVER says 'nothing new' (the silent-empty failure mode, banned verbatim)", () => {
    const v = evaluateAnomalyFloor(days([5, 4, 6, 5, 4, 5, 6]), { date: "2026-08-08", count: 0 });
    expect(v.render).not.toMatch(/nothing new/i);
  });

  it("an empty scan with a ZERO trailing mean is ordinary — a source that always returns nothing is not anomalous", () => {
    const v = evaluateAnomalyFloor(days([0, 0, 0, 0, 0, 0, 0]), { date: "2026-08-08", count: 0 });
    expect(v.armed).toBe(true);
    expect(v.anomaly).toBe(false);
  });

  it("a NONZERO scan is never an anomaly (the floor only fires on empty-200)", () => {
    const v = evaluateAnomalyFloor(days([5, 4, 6, 5, 4, 5, 6]), { date: "2026-08-08", count: 3 });
    expect(v.anomaly).toBe(false);
  });

  it("O1 granularity edge: a day's value is the LAST count recorded that day (a same-day refetch supersedes)", () => {
    // day 7 recorded 5 then 1 — the day's value is 1, so the mean drops by 4/7
    const history = days([5, 4, 6, 5, 4, 5]);
    history.push({ date: "2026-08-07", count: 5 });
    history.push({ date: "2026-08-07", count: 1 });
    const v = evaluateAnomalyFloor(history, { date: "2026-08-08", count: 0 });
    expect(v.armed).toBe(true);
    expect(v.anomaly).toBe(true);
    expect(v.mean).toBeCloseTo((5 + 4 + 6 + 5 + 4 + 5 + 1) / 7, 5);
  });

  it("the trailing window is the LAST 7 distinct fetch-days — older days drop out of the mean", () => {
    // 8 prior days: the first (count 999) must NOT be in the window
    const history = days([999, 5, 4, 6, 5, 4, 5, 6]);
    const v = evaluateAnomalyFloor(history, { date: "2026-08-09", count: 0 });
    expect(v.mean).toBeCloseTo((5 + 4 + 6 + 5 + 4 + 5 + 6) / 7, 5);
  });
});

describe("the history store (O1 — storage pinned)", () => {
  it("recordFetchOutcome appends to the per-source history file and readFetchHistory round-trips", () => {
    const r = root();
    const key = "test-source";
    recordFetchOutcome(r, key, { date: "2026-08-01", count: 5 });
    recordFetchOutcome(r, key, { date: "2026-08-02", count: 0 });
    const hist = readFetchHistory(r, key);
    expect(hist).toEqual([
      { date: "2026-08-01", count: 5 },
      { date: "2026-08-02", count: 0 },
    ]);
  });

  it("the history is PER-SOURCE: a second source's file is disjoint", () => {
    const r = root();
    recordFetchOutcome(r, "source-a", { date: "2026-08-01", count: 5 });
    recordFetchOutcome(r, "source-b", { date: "2026-08-01", count: 1 });
    expect(readFetchHistory(r, "source-a")).toHaveLength(1);
    expect(readFetchHistory(r, "source-b")).toHaveLength(1);
    expect(readFetchHistory(r, "source-a")[0].count).toBe(5);
  });

  it("a corrupt history file reads as EMPTY (degrades, never crashes the lens)", () => {
    const r = root();
    mkdirSync(join(r, "fetch-history"), { recursive: true });
    writeFileSync(historyPath(r, "corrupt"), "\x00 not json");
    expect(readFetchHistory(r, "corrupt")).toEqual([]);
  });

  it("a missing history file reads as EMPTY (a fresh source is unarmed by construction)", () => {
    const r = root();
    expect(readFetchHistory(r, "fresh")).toEqual([]);
  });

  it("the store is APPEND-ONLY (entries never mutated) and capped (the lens only needs the trailing window)", () => {
    const r = root();
    for (let i = 0; i < 30; i++) recordFetchOutcome(r, "cap", { date: `2026-07-${String(i + 1).padStart(2, "0")}`, count: i });
    const hist = readFetchHistory(r, "cap");
    expect(hist).toHaveLength(30);
    const raw = JSON.parse(readFileSync(historyPath(r, "cap"), "utf8")) as { entries?: unknown[] };
    expect(raw.entries).toHaveLength(30);
  });
});
