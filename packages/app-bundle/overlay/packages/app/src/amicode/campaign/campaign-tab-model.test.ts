// amicode#694: the Campaign tab's data path — pure projections from the
// campaign routes (#662) to the tab's render model, plus the deep-link
// recognizer for the digest tile's click path. The routes' wire shapes are
// snake_case (campaign_ledger.ts); the model stays mechanical: strip display
// markers, split table cells, never invent content.
import { describe, expect, test } from "bun:test"
import {
  campaignLedgerModel,
  campaignPromptSlug,
  pickCampaign,
  statusTone,
  type CampaignDetailPayload,
} from "./campaign-tab-model"

const detail = (over: Partial<CampaignDetailPayload> = {}): CampaignDetailPayload => ({
  slug: "session-20260830-spin-cz",
  date: "2026-08-30",
  campaign: "exchange-CZ",
  status: "ACTIVE",
  type: "autoresearch",
  // §1's body — the route strips the `## 1.` header line (splitSections)
  objective: "- Land the exchange-CZ campaign\n- stay under 200 ns",
  verdicts: [
    ["Unit", "Scope", "Status"],
    ["H1 spec", "app overlay", "**DONE** — PR #17 merged"],
    ["calibration", "chip", "**BLOCKED** — awaiting chip time"],
  ],
  active_work: "- refactoring the gate",
  blocked: "- **chip time** — Shannon is booked until Thursday\n- probe rewire pending",
  next_queue: "- sweep J coupling",
  loop_log_tail: "| iter | verdict |\n| --- | --- |\n| 12 | spec landed |\n| 13 | blocked on chip |",
  compaction: "(append-only: compaction log)",
  sections_found: [1, 2, 3, 4, 5, 8],
  file_date: "2026-08-30",
  ...over,
})

describe("campaignPromptSlug — the digest tile's click-path deep link", () => {
  test("recognizes the tile's exact composition", () => {
    expect(campaignPromptSlug("Open the campaign session-20260830-spin-cz")).toBe("session-20260830-spin-cz")
  })

  test("is case-insensitive on the phrase, exact on the slug", () => {
    expect(campaignPromptSlug("open the campaign session-x")).toBe("session-x")
  })

  test("rejects non-campaign prompts and empty text", () => {
    expect(campaignPromptSlug("Open the problem foo")).toBeNull()
    expect(campaignPromptSlug("")).toBeNull()
    expect(campaignPromptSlug("open the campaign")).toBeNull()
  })

  test("rejects slug-unsafe tails (traversal, spaces)", () => {
    expect(campaignPromptSlug("Open the campaign ../etc/passwd")).toBeNull()
    expect(campaignPromptSlug("Open the campaign two words")).toBeNull()
  })
})

describe("pickCampaign — same rule as the digest tile (newest ACTIVE, newest fallback)", () => {
  test("prefers the newest ACTIVE entry; the list is newest-first", () => {
    const list = [
      { slug: "a", status: "FINISHED" },
      { slug: "b", status: "ACTIVE" },
    ]
    expect(pickCampaign(list)?.slug).toBe("b")
  })

  test("falls back to the newest overall when none is ACTIVE", () => {
    const list = [{ slug: "a", status: "FINISHED" }, { slug: "b", status: null }]
    expect(pickCampaign(list)?.slug).toBe("a")
  })

  test("empty list picks nothing", () => {
    expect(pickCampaign([])).toBeUndefined()
  })
})

describe("campaignLedgerModel — the full-ledger projection", () => {
  test("maps the verdict table: header columns + unit/status/evidence rows", () => {
    const model = campaignLedgerModel(detail())
    expect(model.verdictColumns).toEqual(["Unit", "Scope", "Status"])
    expect(model.verdicts).toEqual([
      { unit: "H1 spec", status: "DONE", evidence: "**DONE** — PR #17 merged" },
      { unit: "calibration", status: "BLOCKED", evidence: "**BLOCKED** — awaiting chip time" },
    ])
  })

  test("projects the status token mechanically (bold stripped, cut at the dash)", () => {
    const model = campaignLedgerModel(detail())
    expect(model.verdicts[0]?.status).toBe("DONE")
    expect(model.verdicts[1]?.status).toBe("BLOCKED")
  })

  test("handles a verdict table without a header row", () => {
    const model = campaignLedgerModel(detail({ verdicts: [["S1", "**DONE** — merged"]] }))
    expect(model.verdictColumns).toEqual([])
    expect(model.verdicts).toEqual([{ unit: "S1", status: "DONE", evidence: "**DONE** — merged" }])
  })

  test("renders the objective as marker-stripped lines", () => {
    const model = campaignLedgerModel(detail())
    expect(model.objectiveLines).toEqual(["Land the exchange-CZ campaign", "stay under 200 ns"])
  })

  test("renders the blocked queue with reasons as lines", () => {
    const model = campaignLedgerModel(detail())
    expect(model.blockedLines).toEqual(["chip time — Shannon is booked until Thursday", "probe rewire pending"])
  })

  test("keeps a table §8 loop-log tail as rows and a text tail as lines", () => {
    const table = campaignLedgerModel(detail())
    expect(table.loopLog).toEqual({ kind: "table", rows: [["iter", "verdict"], ["12", "spec landed"], ["13", "blocked on chip"]] })
    const text = campaignLedgerModel(detail({ loop_log_tail: "loop 12 done\nloop 13 started" }))
    expect(text.loopLog).toEqual({ kind: "text", lines: ["loop 12 done", "loop 13 started"] })
  })

  test("surfaces the frontmatter identity fields", () => {
    const model = campaignLedgerModel(detail())
    expect(model.slug).toBe("session-20260830-spin-cz")
    expect(model.label).toBe("exchange-CZ")
    expect(model.status).toBe("ACTIVE")
    expect(model.date).toBe("2026-08-30")
  })

  test("falls back to the slug for the label and the filename date", () => {
    const model = campaignLedgerModel(detail({ campaign: null, date: null }))
    expect(model.label).toBe("session-20260830-spin-cz")
    expect(model.date).toBe("2026-08-30") // file_date fallback
  })

  test("a null/undefined detail degrades to the empty model", () => {
    const model = campaignLedgerModel(null)
    expect(model.hasLedger).toBe(false)
    expect(model.verdicts).toEqual([])
    expect(model.objectiveLines).toEqual([])
  })

  test("a content-less ledger flags the empty state (the tab explains how one starts)", () => {
    const model = campaignLedgerModel(
      detail({ objective: "", verdicts: [], blocked: "", loop_log_tail: "" }),
    )
    expect(model.hasLedger).toBe(false)
  })

  test("an objective-less ledger with content still counts as a ledger", () => {
    const model = campaignLedgerModel(detail({ objective: "" }))
    expect(model.hasLedger).toBe(true)
  })
})

describe("statusTone — the verdict chip tone discipline (theme tokens, no raw colors)", () => {
  test("success / danger / neutral tones from the status token", () => {
    expect(statusTone("DONE")).toBe("success")
    expect(statusTone("MERGED")).toBe("success")
    expect(statusTone("PASS")).toBe("success")
    expect(statusTone("BLOCKED")).toBe("danger")
    expect(statusTone("FAIL")).toBe("danger")
    expect(statusTone("STUCK")).toBe("danger")
    expect(statusTone("WIP")).toBe("neutral")
    expect(statusTone("")).toBe("neutral")
  })
})
