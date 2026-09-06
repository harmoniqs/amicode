// sota_router.test.ts — the relevance router (#living-sota slice 2, spec
// spec-20260905-103000 D3 / S3): new papers match against ACTIVE campaigns —
// the campaign enumeration is the session-ledger parse target (sessions/
// session-*.md verdict tables + titles); matched items append `stage` lines to
// the matching campaign's SIDECAR, or the HOPPER when no campaign matches;
// below-threshold → the hopper. A matched paper never enters a campaign
// LEDGER (the nine-section grammar holds unamended — the stage lands in the
// sidecar BESIDE it); a malformed ledger degrades per-file with a named
// reason, never failing the sweep.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  enumerateCampaigns,
  routeItem,
  routePapersToStaging,
  RELEVANCE_THRESHOLD,
  HOPPER_CAMPAIGN,
  type CampaignLedgerInfo,
} from "../src/sota_router.js";
import { stagingStreamPath, deriveStagingState, SIDECAR_SUFFIX, EXPIRED_WITHOUT_REVIEW } from "../src/sota_staging.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sota-router-"));
  mkdirSync(join(dir, "sessions"), { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ── fixture campaign ledgers (the session-ledger grammar, verbatim shape) ────

const ACTIVE_LEDGER = `---
type: session-ledger
campaign: Rydberg blockade scaling
---

# Session ledger — Rydberg blockade scaling

Campaign: push the Rydberg CZ gate fidelity past 0.9999 on the 8-atom register.

## 1. Objective & standing directives

- Objective: push the Rydberg CZ gate fidelity past 0.9999 on the 8-atom register, blockade regime.

## 2. Verdict table

| item | status |
|---|---|
| H1 blockade radius calibration | **FAILED (3 runs) — retry queued** |
| H2 shaped pulse vs square pulse CZ | pending |
| spec-20260901-rydberg-cz | **approved** |

## 3. Active work

- none in flight
`;

const DONE_LEDGER = `# Session ledger — Wrapped old campaign

## 2. Verdict table

| item | status |
|---|---|
| S1 readme truth | **MERGED (PR #1)** |
`;

const NO_TABLE_LEDGER = `# Session ledger — A bare note

Some prose, no verdict table at all.
`;

function writeLedger(name: string, text: string): string {
  writeFileSync(join(dir, "sessions", name), text);
  return name.replace(/\.md$/, "");
}

const ACTIVE = "session-20260901-rydberg-cz";
const DONE = "session-20260801-wrapped-campaign";

function seedLedgers(): void {
  writeLedger(ACTIVE + ".md", ACTIVE_LEDGER);
  writeLedger(DONE + ".md", DONE_LEDGER);
  writeLedger("session-20260802-bare-note.md", NO_TABLE_LEDGER);
  writeLedger("CHECKOUTS.md", "not a ledger"); // never matches the session-*.md glob
}

describe("enumerateCampaigns — the session-ledger parse target (titles + verdict tables)", () => {
  it("enumerates ACTIVE campaigns: open verdict rows keep a campaign matchable; terminal-only ones do not", () => {
    seedLedgers();
    const { campaigns, skipped } = enumerateCampaigns(join(dir, "sessions"));
    expect(campaigns.map((c) => c.id)).toEqual([ACTIVE]); // the all-terminal ledger is not matchable
    const active = campaigns[0] as CampaignLedgerInfo;
    expect(active.title).toBe("Rydberg blockade scaling");
    expect(active.open).toEqual([
      "H1 blockade radius calibration",
      "H2 shaped pulse vs square pulse CZ",
    ]);
    // the skipped carry NAMED reasons (degrade per-file, never fail the sweep)
    expect(skipped).toEqual([{ file: "session-20260802-bare-note.md", reason: expect.stringMatching(/no verdict table/i) }]);
  });

  it("an unreadable ledger file is skipped with a named reason — the sweep proceeds", () => {
    // a directory with a ledger-shaped name: readFileSync throws EISDIR — the
    // per-file degradation path, never a sweep failure
    mkdirSync(join(dir, "sessions", "session-20260701-garbage.md"));
    const { campaigns, skipped } = enumerateCampaigns(join(dir, "sessions"));
    expect(campaigns).toEqual([]);
    expect(skipped).toEqual([{ file: "session-20260701-garbage.md", reason: expect.stringMatching(/unreadable/i) }]);
  });

  it("a missing/empty sessions dir enumerates to nothing (the router falls back to the hopper)", () => {
    expect(enumerateCampaigns(join(dir, "nope")).campaigns).toEqual([]);
  });
});

describe("routeItem — relevance against the campaign corpora (explainable, word-boundary)", () => {
  it("a paper sharing >= threshold distinct campaign terms routes to the campaign, with the matched terms recorded", () => {
    seedLedgers();
    const { campaigns } = enumerateCampaigns(join(dir, "sessions"));
    const r = routeItem(
      { title: "Fast Rydberg CZ gates via optimal control", detail: "We shape pulses in the blockade regime; the CZ gate reaches 0.9999." },
      campaigns,
    );
    if (r.target !== "campaign") throw new Error("expected a campaign route");
    expect(r.campaign.id).toBe(ACTIVE);
    expect(r.matched.length).toBeGreaterThanOrEqual(RELEVANCE_THRESHOLD);
    expect(r.matched).toContain("rydberg");
    expect(r.matched).toContain("cz");
  });

  it("a paper below the threshold routes to the HOPPER (sub-threshold material is awaiting-the-eye, never currency)", () => {
    seedLedgers();
    const { campaigns } = enumerateCampaigns(join(dir, "sessions"));
    const r = routeItem({ title: "Protein folding via deep learning", detail: "AlphaFold-style pipelines for structure prediction." }, campaigns);
    if (r.target !== "hopper") throw new Error("expected a hopper route");
    expect(r.reason).toBe("below-threshold");
  });

  it("no campaigns at all → the hopper with the named no-campaign-match reason", () => {
    const r = routeItem({ title: "Anything at all", detail: "whatever" }, []);
    if (r.target !== "hopper") throw new Error("expected a hopper route");
    expect(r.reason).toBe("no-campaign-match");
  });

  it("ties break deterministically (campaign id asc) — the router is reproducible", () => {
    const a: CampaignLedgerInfo = { id: "session-b", title: "Zeta rydberg cz", objectiveLine: "", open: [], terms: ["rydberg", "cz"] };
    const b: CampaignLedgerInfo = { id: "session-a", title: "Alpha rydberg cz", objectiveLine: "", open: [], terms: ["rydberg", "cz"] };
    const r = routeItem({ title: "rydberg cz", detail: "" }, [a, b]);
    if (r.target !== "campaign") throw new Error("expected a campaign route");
    expect(r.campaign.id).toBe("session-a");
  });
});

describe("routePapersToStaging — the digest's routing pass (stage lines, idempotent)", () => {
  const PROV = {
    job: "papers-digest",
    via: "fetched",
    source: "arXiv export API over HTTPS",
    fetched_at: "2026-09-05T10:00:00.000Z",
  };

  it("a matched paper lands in the matching campaign's SIDECAR with stamps; below-threshold to the hopper; the LEDGER is untouched", () => {
    seedLedgers();
    const r = routePapersToStaging({
      items: [
        { arxiv: "2606.05060", title: "Fast Rydberg CZ gates via optimal control", abstract: "We shape pulses in the blockade regime; the CZ gate reaches 0.9999." },
        { arxiv: "2606.99999", title: "Protein folding via deep learning", abstract: "AlphaFold-style pipelines." },
      ],
      sessionsDir: join(dir, "sessions"),
      provenance: PROV,
      nowMs: () => 1_000_000_000_000,
    });
    expect(r.staged).toHaveLength(1);
    expect(r.staged[0]).toMatchObject({ event_id: "arxiv:2606.05060", campaign: ACTIVE });
    expect(r.hopper).toHaveLength(1);
    expect(r.hopper[0]).toMatchObject({ event_id: "arxiv:2606.99999", campaign: HOPPER_CAMPAIGN, reason: "below-threshold" });
    // the stage line lives in the SIDECAR beside the ledger, never in the ledger
    const sidecar = stagingStreamPath(join(dir, "sessions"), ACTIVE);
    const st = deriveStagingState(sidecar);
    expect(st.entries.get("arxiv:2606.05060")?.state).toBe("staged");
    expect(st.entries.get("arxiv:2606.05060")?.kind).toBe("paper");
    expect(readFileSync(join(dir, "sessions", ACTIVE + ".md"), "utf8")).toBe(ACTIVE_LEDGER); // the grammar holds unamended
    // the hopper stream carries the below-threshold item with its reason
    const hop = deriveStagingState(stagingStreamPath(join(dir, "sessions"), HOPPER_CAMPAIGN));
    expect(hop.entries.get("arxiv:2606.99999")?.state).toBe("staged");
    expect((readFileSync(stagingStreamPath(join(dir, "sessions"), HOPPER_CAMPAIGN), "utf8").match(/below-threshold/g) ?? []).length).toBe(1);
  });

  it("re-running the digest on the same papers dedupes by event id — one stage line, centrally, no double delivery", () => {
    seedLedgers();
    const items = [{ arxiv: "2606.05060", title: "Fast Rydberg CZ gates via optimal control", abstract: "blockade regime CZ" }];
    const once = routePapersToStaging({ items, sessionsDir: join(dir, "sessions"), provenance: PROV, nowMs: () => 1 });
    const twice = routePapersToStaging({ items, sessionsDir: join(dir, "sessions"), provenance: PROV, nowMs: () => 2 });
    expect(once.staged).toHaveLength(1);
    expect(twice.staged).toHaveLength(0);
    expect(twice.deduped).toEqual(["arxiv:2606.05060"]);
    const raw = readFileSync(stagingStreamPath(join(dir, "sessions"), ACTIVE), "utf8").trim().split("\n");
    expect(raw).toHaveLength(1);
  });

  it("the stage lines carry the digest's provenance stamp and the expiry stamps (S3's fixture shape)", () => {
    seedLedgers();
    routePapersToStaging({
      items: [{ arxiv: "2606.05060", title: "Fast Rydberg CZ gates via optimal control", abstract: "blockade regime CZ" }],
      sessionsDir: join(dir, "sessions"),
      provenance: PROV,
      nowMs: () => 1_000_000_000_000,
    });
    const line = JSON.parse(readFileSync(stagingStreamPath(join(dir, "sessions"), ACTIVE), "utf8")) as Record<string, unknown>;
    expect(line.provenance).toEqual(PROV);
    expect(line.event_id).toBe("arxiv:2606.05060");
    expect(line.url).toBe("https://arxiv.org/abs/2606.05060");
    expect(line.kind).toBe("paper");
    expect(typeof line.expires_at).toBe("string");
    expect(line.reason ?? "matched").not.toBe(EXPIRED_WITHOUT_REVIEW); // a stage line is a stage, never a drop
  });
});
