// sota_history.ts — the per-source fetch history + the anomaly floor (#820,
// spec-20260905-103000 living-sota / sota_fetch_anomaly_floor / S6): the
// "quiet failures are the ones that matter" machinery. A successful fetch
// returning ZERO entries where the trailing 7-fetch-day mean is NONZERO
// records a NAMED anomaly ("empty-200-vs-nonzero-mean") and renders
// "scan returned nothing — anomalous" — never "nothing new".
//
// ── O1 — history storage + granularity, pinned ──────────────────────────
//
// STORAGE: one append-only JSON file per source under
// <sota-root>/fetch-history/<source-key>.json — {entries: [{date, count}]}
// (an object with a named field, extensible without a breaking read of the
// old shape). Append-only: entries are never mutated or rewritten (the
// ledger discipline — the floor's evidence must be trustable); a corrupt or
// missing file reads as EMPTY, degrading to unarmed rather than crashing the
// lens. The file is capped at HISTORY_CAP entries (a year+ of daily fetches
// at 400) — the floor only reads the trailing window, and an unbounded file
// is an unbounded cost for nothing.
//
// GRANULARITY EDGE: a "fetch-day" is a DISTINCT UTC calendar date on which at
// least one fetch was recorded. The floor is ARMED iff ≥7 distinct fetch-days
// exist in the PRIOR history (the current fetch is not part of its own
// window). A day's VALUE is the LAST count recorded that day (a same-day
// refetch supersedes — the day's final state is what the mean sees). The
// trailing window is the LAST 7 distinct fetch-days, so a long-gone quiet
// era drops out of the mean exactly 7 days after it ends.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FetchHistoryEntry {
  /** UTC calendar date, YYYY-MM-DD. */
  date: string;
  /** The count the fetch returned (entries, releases, …). */
  count: number;
}

/** O1: the trailing window — 7 fetch-days, armed only after 7 days of history. */
export const ANOMALY_FLOOR_WINDOW_DAYS = 7;

/** O1: the store cap — the floor only reads the trailing window. */
export const HISTORY_CAP = 400;

export interface AnomalyFloorVerdict {
  /** Is the floor armed (≥7 prior fetch-days)? */
  armed: boolean;
  /** Did the armed floor fire? */
  anomaly: boolean;
  /** The named anomaly kind ("empty-200-vs-nonzero-mean") when it fired. */
  name?: string;
  /** The human render — "scan returned nothing — anomalous (…)", never "nothing new". */
  render?: string;
  /** The trailing-window mean (when armed). */
  mean?: number;
}

export function historyPath(root: string, sourceKey: string): string {
  return join(root, "fetch-history", `${sourceKey}.json`);
}

/** Read a source's history — append-only entries; corrupt/missing → [] (the
 *  fresh-install state, unarmed by construction). */
export function readFetchHistory(root: string, sourceKey: string): FetchHistoryEntry[] {
  try {
    const j = JSON.parse(readFileSync(historyPath(root, sourceKey), "utf8")) as { entries?: FetchHistoryEntry[] };
    return Array.isArray(j.entries) ? j.entries.slice(-HISTORY_CAP) : [];
  } catch {
    return [];
  }
}

/** Append one fetch outcome to the source's history (append-only, capped,
 *  written atomically — tmp+rename, the house discipline). */
export function recordFetchOutcome(root: string, sourceKey: string, entry: FetchHistoryEntry): void {
  const entries = [...readFetchHistory(root, sourceKey), entry].slice(-HISTORY_CAP);
  mkdirSync(join(root, "fetch-history"), { recursive: true });
  const p = historyPath(root, sourceKey);
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ entries } satisfies { entries: FetchHistoryEntry[] }) + "\n");
  renameSync(tmp, p);
}

/** The trailing-7-fetch-day window over PRIOR history: the last 7 distinct
 *  dates, each valued by its LAST recorded count. */
export function trailingWindow(history: FetchHistoryEntry[]): { date: string; value: number }[] {
  const byDay = new Map<string, number>();
  for (const e of history) byDay.set(e.date, e.count); // later entries supersede same-day
  return [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).slice(-ANOMALY_FLOOR_WINDOW_DAYS).map(([date, value]) => ({ date, value }));
}

/** Evaluate the anomaly floor for a fetch that just returned `count` entries
 *  with HTTP 200, against the PRIOR history (armed only after 7 distinct
 *  fetch-days — a fresh source cannot cry anomaly). */
export function evaluateAnomalyFloor(priorHistory: FetchHistoryEntry[], current: { date: string; count: number }): AnomalyFloorVerdict {
  const window = trailingWindow(priorHistory);
  if (window.length < ANOMALY_FLOOR_WINDOW_DAYS) {
    return { armed: false, anomaly: false };
  }
  const mean = window.reduce((s, d) => s + d.value, 0) / window.length;
  if (current.count === 0 && mean > 0) {
    return {
      armed: true,
      anomaly: true,
      name: "empty-200-vs-nonzero-mean",
      mean,
      render: `scan returned nothing — anomalous (empty 200 against a trailing ${ANOMALY_FLOOR_WINDOW_DAYS}-fetch-day mean of ${mean.toFixed(1)})`,
    };
  }
  return { armed: true, anomaly: false, mean };
}

/** The UTC calendar date of a timestamp (the granularity unit, O1). */
export function utcFetchDay(nowIso: string): string {
  return new Date(nowIso).toISOString().slice(0, 10);
}

void existsSync;
