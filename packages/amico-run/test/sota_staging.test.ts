// sota_staging.test.ts — the SIDECAR staging streams (#living-sota slice 2,
// spec-20260905-103000 D3 / S3): per-campaign append-only transition streams
// beside the session ledger, event-id idempotent, PIPE_BUF + O_APPEND
// line-atomic; stage/drop/accept are ALL appended transition lines — entries
// never mutated, staging state always DERIVED from the stream; the acceptance
// stamp is the SOLE sanctioned non-job append (PI-instructed, its schema
// provenance-stamped); expiry drops with the recorded drop line; compaction
// (O2) removes expired-and-dropped chains past the window, recorded by an
// appended compact line, never touching accepted or pending entries.
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SIDECAR_SUFFIX,
  HOPPER_CAMPAIGN,
  REVIEW_BY_DAYS,
  EXPIRES_AFTER_DAYS,
  COMPACTION_WINDOW_DAYS,
  EXPIRED_WITHOUT_REVIEW,
  stagingStreamPath,
  appendStageLine,
  appendAcceptStamp,
  appendDropLine,
  sweepExpiry,
  compactStagingStream,
  deriveStagingState,
  readStagingStream,
  renderAwaitingTheEye,
  expiredWithoutReviewCount,
  type StageEntryInput,
  type StagingProvenance,
} from "../src/sota_staging.js";
import { PIPE_BUF } from "../src/ledger.js";

function sessions(): string {
  return mkdtempSync(join(tmpdir(), "sota-staging-"));
}

function vclock(start = 1_000_000_000_000): { nowMs: () => number; jump: (ms: number) => void } {
  let t = start;
  return { nowMs: () => t, jump: (ms: number) => (t += ms) };
}

const PROV: StagingProvenance = {
  job: "papers-digest",
  via: "fetched",
  source: "arXiv export API over HTTPS",
  fetched_at: "2026-09-05T10:00:00.000Z",
};

function paperEntry(event_id = "arxiv:2606.05060", campaign = "session-20260901-rydberg-cz"): StageEntryInput {
  return {
    event_id,
    campaign,
    kind: "paper",
    title: "Fast Rydberg CZ gates via shaped pulses",
    url: "https://arxiv.org/abs/2606.05060",
    provenance: PROV,
    matched: ["rydberg", "cz"],
  };
}

describe("the SIDECAR staging stream — stage with stamps (S3 cell 1)", () => {
  it("a stage line lands beside the ledger with review-by/expiry stamps, provenance, and a monotonic seq", () => {
    const dir = sessions();
    const c = vclock();
    const path = stagingStreamPath(dir, "session-20260901-rydberg-cz");
    expect(path).toBe(join(dir, "session-20260901-rydberg-cz" + SIDECAR_SUFFIX));
    const r = appendStageLine(path, paperEntry(), { nowMs: c.nowMs });
    expect(r.appended).toBe(true);
    const raw = readFileSync(path, "utf8");
    expect(raw.endsWith("\n")).toBe(true); // whole, flushed line — O_APPEND atomicity
    const line = JSON.parse(raw.trim()) as Record<string, unknown>;
    expect(line.ev).toBe("stage");
    expect(line.seq).toBe(1); // seq IS the line count at write time
    expect(line.event_id).toBe("arxiv:2606.05060");
    expect(line.campaign).toBe("session-20260901-rydberg-cz");
    expect(line.kind).toBe("paper");
    expect(line.provenance).toEqual(PROV); // provenance-stamped
    expect(line.matched).toEqual(["rydberg", "cz"]);
    const ts = Date.parse(String(line.ts));
    expect(Date.parse(String(line.review_by))).toBe(ts + REVIEW_BY_DAYS * 86_400_000); // the review-by stamp
    expect(Date.parse(String(line.expires_at))).toBe(ts + EXPIRES_AFTER_DAYS * 86_400_000); // the expiry stamp
  });

  it("seq is monotonic across appends (the stream replays in write order)", () => {
    const dir = sessions();
    const c = vclock();
    const path = stagingStreamPath(dir, "session-20260901-rydberg-cz");
    appendStageLine(path, paperEntry("arxiv:1", "session-20260901-rydberg-cz"), { nowMs: c.nowMs });
    appendStageLine(path, paperEntry("arxiv:2", "session-20260901-rydberg-cz"), { nowMs: c.nowMs });
    const { lines } = readStagingStream(path);
    expect(lines.map((l) => (l as { seq: number }).seq)).toEqual([1, 2]);
  });

  it("a line that would exceed PIPE_BUF is refused — O_APPEND atomicity holds only under the ceiling", () => {
    const dir = sessions();
    const path = stagingStreamPath(dir, "session-20260901-rydberg-cz");
    const big = paperEntry();
    // the title is capped at 240 chars by the writer — the honest way past the
    // ceiling is a provenance extra (a job stamp gone wrong), never a torn append
    big.provenance = { ...PROV, note: "x".repeat(PIPE_BUF) };
    expect(() => appendStageLine(path, big)).toThrow(/PIPE_BUF/);
    expect(existsSync(path)).toBe(false); // nothing torn landed
  });
});

describe("idempotency — double-delivery is impossible (S3 cell)", () => {
  it("the same event_id staged twice produces ONE line (idempotent by event id)", () => {
    const dir = sessions();
    const path = stagingStreamPath(dir, "session-20260901-rydberg-cz");
    const a = appendStageLine(path, paperEntry());
    const b = appendStageLine(path, paperEntry());
    expect(a.appended).toBe(true);
    expect(b.appended).toBe(false);
    expect(b.reason).toMatch(/already staged|duplicate/);
    const { lines } = readStagingStream(path);
    expect(lines).toHaveLength(1);
  });

  it("the digest re-running tomorrow on the same paper dedupes centrally (state derived, one stage line)", () => {
    const dir = sessions();
    const path = stagingStreamPath(dir, "session-20260901-rydberg-cz");
    appendStageLine(path, paperEntry());
    appendStageLine(path, paperEntry());
    appendStageLine(path, paperEntry());
    expect(readStagingStream(path).lines).toHaveLength(1);
    expect(deriveStagingState(path).entries.get("arxiv:2606.05060")?.state).toBe("staged");
  });
});

describe("the acceptance stamp — the PI-instructed promote (S3 cell 2; O3's schema)", () => {
  it("an accepted match promotes by an appended accept line carrying the PI-instruction provenance", () => {
    const dir = sessions();
    const c = vclock();
    const path = stagingStreamPath(dir, "session-20260901-rydberg-cz");
    appendStageLine(path, paperEntry(), { nowMs: c.nowMs });
    const r = appendAcceptStamp(path, "arxiv:2606.05060", { channel: "chat", note: "the blockade number is load-bearing — accept" }, { nowMs: c.nowMs });
    expect(r.appended).toBe(true);
    const { lines } = readStagingStream(path);
    const accept = lines[1] as Record<string, unknown>;
    expect(accept.ev).toBe("accept");
    expect(accept.event_id).toBe("arxiv:2606.05060");
    expect(accept.instructed_by).toBe("PI");
    expect(accept.instruction).toEqual({
      channel: "chat",
      note: "the blockade number is load-bearing — accept",
      received_at: new Date(c.nowMs()).toISOString(),
    });
    expect(deriveStagingState(path).entries.get("arxiv:2606.05060")?.state).toBe("accepted");
  });

  it("a second accept stamp is an idempotent no-op (event-id-idempotent stamp)", () => {
    const dir = sessions();
    const path = stagingStreamPath(dir, "session-20260901-rydberg-cz");
    appendStageLine(path, paperEntry());
    appendAcceptStamp(path, "arxiv:2606.05060", { channel: "chat", note: "first" });
    const again = appendAcceptStamp(path, "arxiv:2606.05060", { channel: "chat", note: "repeated instruction" });
    expect(again.appended).toBe(false);
    expect(again.reason).toMatch(/already accepted|idempotent/i);
    expect(readStagingStream(path).lines).toHaveLength(2);
  });

  it("an accept without a staged match is REFUSED — the stamp is a decision's record, never free-floating", () => {
    const dir = sessions();
    const path = stagingStreamPath(dir, "session-20260901-rydberg-cz");
    const r = appendAcceptStamp(path, "arxiv:never-staged", { channel: "chat", note: "x" });
    expect(r.appended).toBe(false);
    expect(r.reason).toMatch(/no staged match/i);
    expect(existsSync(path)).toBe(false);
  });

  it("an accept for an already-dropped match is REFUSED (a drop is terminal)", () => {
    const dir = sessions();
    const c = vclock();
    const path = stagingStreamPath(dir, "session-20260901-rydberg-cz");
    appendStageLine(path, paperEntry(), { nowMs: c.nowMs });
    c.jump(EXPIRES_AFTER_DAYS * 86_400_000 + 1);
    sweepExpiry(path, { nowMs: c.nowMs });
    const r = appendAcceptStamp(path, "arxiv:2606.05060", { channel: "chat", note: "late" }, { nowMs: c.nowMs });
    expect(r.appended).toBe(false);
    expect(r.reason).toMatch(/dropped|terminal/i);
  });

  it("the instruction note is REQUIRED — an unstamped acceptance is refused (the schema records the instruction)", () => {
    const dir = sessions();
    const path = stagingStreamPath(dir, "session-20260901-rydberg-cz");
    appendStageLine(path, paperEntry());
    const r = appendAcceptStamp(path, "arxiv:2606.05060", { channel: "chat", note: "" });
    expect(r.appended).toBe(false);
    expect(r.reason).toMatch(/instruction|note/i);
  });
});

describe("expiry — a match past its review window drops with the recorded line (S3 cell 3)", () => {
  it("the sweep appends a drop line with the recorded reason; the state derives dropped", () => {
    const dir = sessions();
    const c = vclock();
    const path = stagingStreamPath(dir, "session-20260901-rydberg-cz");
    appendStageLine(path, paperEntry(), { nowMs: c.nowMs });
    c.jump(EXPIRES_AFTER_DAYS * 86_400_000 + 1); // past the expiry stamp
    const { dropped } = sweepExpiry(path, { nowMs: c.nowMs });
    expect(dropped).toEqual(["arxiv:2606.05060"]);
    const { lines } = readStagingStream(path);
    const drop = lines[1] as Record<string, unknown>;
    expect(drop.ev).toBe("drop");
    expect(drop.reason).toBe(EXPIRED_WITHOUT_REVIEW);
    expect(typeof drop.recorded).toBe("string"); // the recorded line
    expect(deriveStagingState(path).entries.get("arxiv:2606.05060")?.state).toBe("dropped");
  });

  it("a NOT-yet-expired staged match is NOT dropped (stage-before-count, no premature laundering)", () => {
    const dir = sessions();
    const c = vclock();
    const path = stagingStreamPath(dir, "session-20260901-rydberg-cz");
    appendStageLine(path, paperEntry(), { nowMs: c.nowMs });
    c.jump((EXPIRES_AFTER_DAYS - 1) * 86_400_000);
    const { dropped } = sweepExpiry(path, { nowMs: c.nowMs });
    expect(dropped).toEqual([]);
    expect(deriveStagingState(path).entries.get("arxiv:2606.05060")?.state).toBe("staged");
  });

  it("the sweep is idempotent (one recorded drop, never two)", () => {
    const dir = sessions();
    const c = vclock();
    const path = stagingStreamPath(dir, "session-20260901-rydberg-cz");
    appendStageLine(path, paperEntry(), { nowMs: c.nowMs });
    c.jump(EXPIRES_AFTER_DAYS * 86_400_000 + 1);
    sweepExpiry(path, { nowMs: c.nowMs });
    const second = sweepExpiry(path, { nowMs: c.nowMs });
    expect(second.dropped).toEqual([]);
    expect(readStagingStream(path).lines).toHaveLength(2);
  });

  it("a drop on an ACCEPTED match is refused — acceptance is terminal", () => {
    const dir = sessions();
    const path = stagingStreamPath(dir, "session-20260901-rydberg-cz");
    appendStageLine(path, paperEntry());
    appendAcceptStamp(path, "arxiv:2606.05060", { channel: "chat", note: "accept" });
    const r = appendDropLine(path, "arxiv:2606.05060", EXPIRED_WITHOUT_REVIEW);
    expect(r.appended).toBe(false);
    expect(r.reason).toMatch(/accepted|terminal/i);
  });
});

describe("the hopper fallback stream (S3 cell 4)", () => {
  it("below-threshold / unmatched material lands in the hopper stream under sessions/, same shape", () => {
    const dir = sessions();
    const path = stagingStreamPath(dir, HOPPER_CAMPAIGN);
    expect(path).toBe(join(dir, "hopper" + SIDECAR_SUFFIX));
    const r = appendStageLine(path, {
      event_id: "arxiv:2606.99999",
      campaign: HOPPER_CAMPAIGN,
      kind: "paper",
      title: "Protein folding via deep learning",
      url: "https://arxiv.org/abs/2606.99999",
      provenance: PROV,
      matched: [],
      reason: "below-threshold",
    });
    expect(r.appended).toBe(true);
    const line = readStagingStream(path).lines[0] as Record<string, unknown>;
    expect(line.campaign).toBe("hopper");
    expect(line.reason).toBe("below-threshold");
  });
});

describe("derivation — staging state is always DERIVED from the stream (the invariant)", () => {
  it("readers tolerate unknown ev values (opacity: carried, never fatal) and skip a torn in-flight tail", () => {
    const dir = sessions();
    const path = stagingStreamPath(dir, "session-20260901-rydberg-cz");
    appendStageLine(path, paperEntry());
    // a future writer class appends an unknown transition kind — readers carry it
    writeFileSync(path, '{"ev":"triage-tag","seq":2,"ts":"2026-09-05T10:05:00.000Z","event_id":"arxiv:2606.05060","campaign":"session-20260901-rydberg-cz","tag":"flywheel-drain"}\n', { flag: "a" });
    const st = deriveStagingState(path);
    expect(st.entries.get("arxiv:2606.05060")?.state).toBe("staged");
    expect(st.lines).toHaveLength(2);
    // a LIVE reader skips an incomplete trailing line — the rest stands
    writeFileSync(path, '{"ev":"stage","seq":3,', { flag: "a" });
    const st2 = deriveStagingState(path);
    expect(st2.entries.get("arxiv:2606.05060")?.state).toBe("staged");
  });

  it("an orphan accept/drop (no stage) is carried as an orphan — readers never fail; the WRITERS refuse", () => {
    const dir = sessions();
    const path = stagingStreamPath(dir, "session-20260901-rydberg-cz");
    writeFileSync(path, '{"ev":"accept","seq":1,"ts":"2026-09-05T10:00:00.000Z","event_id":"arxiv:ghost","campaign":"session-20260901-rydberg-cz","instructed_by":"PI"}\n');
    const st = deriveStagingState(path);
    const ghost = st.entries.get("arxiv:ghost");
    expect(ghost?.orphan).toBe(true); // carried, never a crash — the validator reds it
  });

  it("a missing stream derives to empty (the fresh-campaign state), never a throw", () => {
    const dir = sessions();
    const st = deriveStagingState(stagingStreamPath(dir, "session-2099-01-01-never"));
    expect(st.entries.size).toBe(0);
  });
});

describe("compaction — O2: expired-and-dropped chains compact past the window, recorded, never silent", () => {
  it("a dropped chain older than the compaction window is removed, the compact line records it, seqs renumber", () => {
    const dir = sessions();
    const c = vclock();
    const path = stagingStreamPath(dir, "session-20260901-rydberg-cz");
    appendStageLine(path, paperEntry("arxiv:old-dropped", "session-20260901-rydberg-cz"), { nowMs: c.nowMs });
    c.jump(EXPIRES_AFTER_DAYS * 86_400_000 + 1);
    sweepExpiry(path, { nowMs: c.nowMs }); // drops old-dropped (recorded)
    // pending + accepted staged AFTER the sweep — fresh stamps, not yet expiring
    appendStageLine(path, paperEntry("arxiv:pending", "session-20260901-rydberg-cz"), { nowMs: c.nowMs });
    appendStageLine(path, paperEntry("arxiv:accepted", "session-20260901-rydberg-cz"), { nowMs: c.nowMs });
    appendAcceptStamp(path, "arxiv:accepted", { channel: "chat", note: "accept" }, { nowMs: c.nowMs });
    c.jump(COMPACTION_WINDOW_DAYS * 86_400_000 + 1); // the drop is now past the window
    const r = compactStagingStream(path, { nowMs: c.nowMs });
    expect(r.removed).toBe(2); // the stage + drop chain of the expired-and-dropped match
    const { lines } = readStagingStream(path);
    const compact = lines[lines.length - 1] as Record<string, unknown>;
    expect(compact.ev).toBe("compact");
    expect(compact.removed).toBe(2);
    expect(compact.window_days).toBe(COMPACTION_WINDOW_DAYS);
    expect(compact.high_water_seq).toBe(5); // the pre-compaction line count — nothing lost
    expect(lines.map((l) => (l as { seq: number }).seq)).toEqual([1, 2, 3, 4]); // renumbered: seq = line count again
    // the pending and accepted entries survive; the dropped one is gone
    const st = deriveStagingState(path);
    expect(st.entries.get("arxiv:pending")?.state).toBe("staged");
    expect(st.entries.get("arxiv:accepted")?.state).toBe("accepted");
    expect(st.entries.has("arxiv:old-dropped")).toBe(false);
  });

  it("accepted and pending entries are NEVER compacted (derivation reads accepted-only — the record stands)", () => {
    const dir = sessions();
    const c = vclock();
    const path = stagingStreamPath(dir, "session-20260901-rydberg-cz");
    appendStageLine(path, paperEntry("arxiv:accepted", "session-20260901-rydberg-cz"), { nowMs: c.nowMs });
    appendAcceptStamp(path, "arxiv:accepted", { channel: "chat", note: "accept" }, { nowMs: c.nowMs });
    c.jump(10 * COMPACTION_WINDOW_DAYS * 86_400_000); // any age — accepted survives
    const r = compactStagingStream(path, { nowMs: c.nowMs });
    expect(r.removed).toBe(0);
    expect(readStagingStream(path).lines).toHaveLength(2); // untouched, no idle compact noise
  });

  it("a recent drop is NOT compacted — the health stamp's trailing window stays computable", () => {
    const dir = sessions();
    const c = vclock();
    const path = stagingStreamPath(dir, "session-20260901-rydberg-cz");
    appendStageLine(path, paperEntry("arxiv:fresh-drop", "session-20260901-rydberg-cz"), { nowMs: c.nowMs });
    c.jump(EXPIRES_AFTER_DAYS * 86_400_000 + 1);
    sweepExpiry(path, { nowMs: c.nowMs });
    c.jump((COMPACTION_WINDOW_DAYS - 1) * 86_400_000); // dropped, but inside the window
    expect(compactStagingStream(path, { nowMs: c.nowMs }).removed).toBe(0);
  });
});

describe("the awaiting-the-eye listing — rendered from DERIVED state (S3 cell)", () => {
  it("lists pending staged matches with citations + provenance + review-by, NEVER as currency; counts the expired", () => {
    const dir = sessions();
    const c = vclock();
    const campaignPath = stagingStreamPath(dir, "session-20260901-rydberg-cz");
    appendStageLine(campaignPath, paperEntry("arxiv:2606.07777", "session-20260901-rydberg-cz"), { nowMs: c.nowMs });
    appendAcceptStamp(campaignPath, "arxiv:2606.07777", { channel: "chat", note: "accept" }, { nowMs: c.nowMs });
    appendStageLine(campaignPath, paperEntry("arxiv:2606.08888", "session-20260901-rydberg-cz"), { nowMs: c.nowMs });
    c.jump(EXPIRES_AFTER_DAYS * 86_400_000 + 1);
    sweepExpiry(campaignPath, { nowMs: c.nowMs }); // 08888 drops expired (chronic non-review)
    // 05060 stages FRESH after the sweep — the current pending item
    appendStageLine(campaignPath, paperEntry("arxiv:2606.05060", "session-20260901-rydberg-cz"), { nowMs: c.nowMs });
    const hopperPath = stagingStreamPath(dir, HOPPER_CAMPAIGN);
    appendStageLine(
      hopperPath,
      {
        event_id: "arxiv:2606.99999",
        campaign: HOPPER_CAMPAIGN,
        kind: "paper",
        title: "Protein folding via deep learning",
        url: "https://arxiv.org/abs/2606.99999",
        provenance: PROV,
        matched: [],
        reason: "below-threshold",
      },
      { nowMs: c.nowMs },
    );
    const text = renderAwaitingTheEye([campaignPath, hopperPath], { nowMs: c.nowMs });
    expect(text).toMatch(/awaiting the eye/i);
    expect(text).toContain("session-20260901-rydberg-cz");
    expect(text).toContain("Fast Rydberg CZ gates via shaped pulses");
    expect(text).toContain("https://arxiv.org/abs/2606.05060"); // CITED
    expect(text).toContain("review by"); // the review-by stamp renders
    expect(text).toContain("papers-digest"); // provenance renders
    expect(text).toContain("hopper");
    expect(text).toContain("Protein folding via deep learning"); // sub-threshold material — in the awaiting listing
    expect(text).toMatch(/expired without review.*1|1.*expired without review/i); // the count line
    expect(text).toContain("never rendered as currency"); // the register line, verbatim
    // the ACCEPTED item is currency, not awaiting — it does not appear as pending
    expect(text).not.toContain("https://arxiv.org/abs/2606.07777");
  });

  it("expiredWithoutReviewCount — the trailing-window health stamp input (chronic non-review masks itself)", () => {
    const dir = sessions();
    const c = vclock();
    const path = stagingStreamPath(dir, "session-20260901-rydberg-cz");
    appendStageLine(path, paperEntry("arxiv:a", "session-20260901-rydberg-cz"), { nowMs: c.nowMs });
    c.jump(EXPIRES_AFTER_DAYS * 86_400_000 + 1);
    sweepExpiry(path, { nowMs: c.nowMs });
    const now = c.nowMs();
    expect(expiredWithoutReviewCount(path, { nowMs: () => now })).toBe(1);
    c.jump(COMPACTION_WINDOW_DAYS * 86_400_000 + 1);
    expect(expiredWithoutReviewCount(path, { nowMs: c.nowMs })).toBe(0); // out of the trailing window
  });
});

void rmSync;
