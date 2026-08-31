// amicode#694: the Campaign tab — the Work Column's full-ledger drill-down.
// The component is Solid JSX (DOM-tested surfaces in this repo are the model
// tests; the #690 precedent pins source-rendered widget surfaces at the
// string level). These pins cover the component's contract (routes, sections,
// empty states, escaping discipline) and the session-side-panel integration
// (tab trigger/content, panel menu, the digest tile's deep link).
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const here = import.meta.dir
const componentSrc = readFileSync(join(here, "campaign-tab.tsx"), "utf8")
const panelSrc = readFileSync(join(here, "../../pages/session/session-side-panel.tsx"), "utf8")

describe("CampaignTabContent — the full-ledger surface", () => {
  test("fetches the campaigns list, then the detail for the picked slug (route contract #662)", () => {
    expect(componentSrc).toContain('"/amicode/campaigns"')
    expect(componentSrc).toContain("`/amicode/campaign?slug=${")
    expect(componentSrc).toContain("encodeURIComponent(")
    expect(componentSrc).toContain("pickCampaign(")
  })

  test("maps the detail through the ledger model — no client-side fabrication", () => {
    expect(componentSrc).toContain("campaignLedgerModel(")
  })

  test("renders the four ledger sections: objective, verdict table, blocked queue, loop log", () => {
    expect(componentSrc).toContain("Objective")
    expect(componentSrc).toContain("Verdict")
    expect(componentSrc).toContain("Blocked")
    expect(componentSrc).toContain("Loop log")
  })

  test("empty state: no campaign explains how one starts", () => {
    expect(componentSrc).toContain("No campaign ledger yet")
    expect(componentSrc).toContain("Amico")
  })

  test("escaping discipline: Solid JSX only — no innerHTML, no dangerouslySetInnerHTML", () => {
    expect(componentSrc).not.toContain("innerHTML")
    expect(componentSrc).not.toContain("dangerouslySetInnerHTML")
  })

  test("detail fetch failure degrades to a readable message, never a blank tab", () => {
    expect(componentSrc).toContain("couldn't load")
  })
})

describe("Work Column integration — the campaign named surface", () => {
  test("the tab trigger exists in both tab-strip branches (legacy + v2)", () => {
    expect(panelSrc.split('value="campaign"').length - 1).toBeGreaterThanOrEqual(4) // 2 triggers + 2 contents
  })

  test("the panel menu offers Campaign beside the quantum surfaces", () => {
    expect(panelSrc).toContain('id: "campaign"')
    expect(panelSrc).toContain('"checklist"')
  })

  test("the active campaign tab renders CampaignTabContent", () => {
    expect(panelSrc).toContain('activeTab() === "campaign"')
    expect(panelSrc).toContain("<CampaignTabContent />")
  })
})

describe("The digest tile's click path deep-links into the tab", () => {
  test("the Home tab's widget host recognizes the tile's prompt and opens the tab", () => {
    expect(panelSrc).toContain("campaignPromptSlug(")
    expect(panelSrc).toContain('open("campaign")')
  })

  test("the home page's draft handoff deep-links too (prompt watch, once per prompt)", () => {
    expect(panelSrc).toContain("campaignDeepLink")
  })
})
