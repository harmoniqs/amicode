import { test, expect, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

// ============================================================================
// Workbench panes — S1 gate (spec-20260731-110956-workbench-panes-refactor):
//   main_column_width_preserved == 1
//   content_baseline_offset_px <= 2
//   tab_labels_truncate_cleanly == 1
//   sessions_panel_hideable == 1
// Every metric is asserted headlessly; failure screenshots land in
// e2e/test-results (the runner archives them).
// ============================================================================

const sessionRoute = `/${base64Encode(fixture.directory)}/session/${fixture.sourceID}`

async function bootTwoSessions(page: Page) {
  await mockOpenCodeServer(page, {
    sessions: fixture.sessions,
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages,
  })
  // Seed the project into the persisted server store (the app otherwise boots
  // to the empty-projects home and the sessions never surface).
  await page.addInitScript((directory) => {
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({
        projects: { local: [{ worktree: directory, expanded: true }] },
        lastProject: { local: directory },
      }),
    )
  }, fixture.directory)
  await page.goto("/")
  // This build's home is the dashboard — it never lists session titles, so
  // readiness is the dashboard itself; session tabs appear once routed to.
  await expectAppVisible(page.getByText("Open chat").first())
}

/** Drag the first strip tab onto the right edge rail — the split gesture. */
async function splitViaRightRail(page: Page) {
  const tab = page.locator(".no-scrollbar div[data-active]").first()
  await expect(tab).toBeVisible()
  const box = (await tab.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 40, 450, { steps: 10 })
  await page.mouse.move(page.viewportSize()!.width - 12, 450, { steps: 10 })
  await page.mouse.up()
  await expect(page.locator("[data-pane]")).toHaveCount(1)
}

const paneFrame = (page: Page) => page.frameLocator("iframe[sandbox]")

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
})

test("S1.1 main_column_width_preserved: main keeps its floor and the row fills the window", async ({ page }) => {
  await bootTwoSessions(page)
  await page.goto(sessionRoute)
  await expect(page.locator(".no-scrollbar div[data-active]").first()).toBeVisible()

  await splitViaRightRail(page)

  const main = await page.locator("[data-split-main]").boundingBox()
  expect(main).not.toBeNull()
  expect(main!.width).toBeGreaterThanOrEqual(280)

  // the row fills the window width — no dead space after the pane (FM2)
  const row = await page.locator("div.h-full.w-full.min-h-0.min-w-0.flex.flex-row").boundingBox()
  expect(row).not.toBeNull()
  expect(Math.abs(row!.width - 1440)).toBeLessThanOrEqual(2)

  // sash drag keeps the floor
  const sash = page.locator(".cursor-col-resize").first()
  const sb = (await sash.boundingBox())!
  await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2)
  await page.mouse.down()
  await page.mouse.move(sb.x - 200, sb.y + sb.height / 2, { steps: 6 })
  await page.mouse.up()
  const main2 = await page.locator("[data-split-main]").boundingBox()
  expect(main2!.width).toBeGreaterThanOrEqual(280)

  // merge restores the single full-width view
  await page.locator("button[aria-label='Merge pane back']").click()
  await expect(page.locator("[data-pane]")).toHaveCount(0)
})

test("S1.2 content_baseline_offset_px <= 2: both sides' chrome and content align", async ({ page }) => {
  await bootTwoSessions(page)
  await page.goto(sessionRoute)
  await expect(page.locator(".no-scrollbar div[data-active]").first()).toBeVisible()
  await splitViaRightRail(page)

  // both titlebar strips at the same height
  const mainStrip = await page.locator(".no-scrollbar").first().boundingBox()
  const paneStrip = await paneFrame(page).locator(".no-scrollbar").first().boundingBox()
  expect(mainStrip).not.toBeNull()
  expect(paneStrip).not.toBeNull()
  expect(Math.abs(mainStrip!.y - paneStrip!.y)).toBeLessThanOrEqual(2)

  // session headers (the content's first heading) at the same height
  const mainHeader = await page.getByText(fixture.expected.sourceTitle).first().boundingBox()
  const paneHeader = await paneFrame(page).getByText(fixture.expected.sourceTitle).first().boundingBox()
  expect(mainHeader).not.toBeNull()
  expect(paneHeader).not.toBeNull()
  expect(Math.abs(mainHeader!.y - paneHeader!.y)).toBeLessThanOrEqual(2)
})

test("S1.3 tab_labels_truncate_cleanly: pane tab labels ellipsize, never clip mid-glyph", async ({ page }) => {
  await bootTwoSessions(page)
  // the long-titled session exercises truncation
  await page.goto(`/${base64Encode(fixture.directory)}/session/${fixture.targetID}`)
  await expect(page.locator(".no-scrollbar div[data-active]").first()).toBeVisible()
  await splitViaRightRail(page)

  const paneTabLabel = paneFrame(page).locator(".no-scrollbar div[data-active] a span.truncate").first()
  await expect(paneTabLabel).toBeVisible()
  const metrics = await paneTabLabel.evaluate((el) => {
    const cs = getComputedStyle(el)
    return { textOverflow: cs.textOverflow, overflow: cs.overflow, whiteSpace: cs.whiteSpace, clipped: el.scrollWidth > el.clientWidth }
  })
  expect(metrics.textOverflow).toBe("ellipsis")
  expect(metrics.overflow).toBe("hidden")
  expect(metrics.whiteSpace).toBe("nowrap")
  // truncation IS happening (content exceeds the box) and CSS handles it — no mid-glyph clip
  expect(metrics.clipped).toBe(true)
})

test("S1.4 sessions_panel_hideable: the workbench panel hides, persists across reload, and returns", async ({ page }) => {
  await bootTwoSessions(page)
  await page.goto(sessionRoute)

  // the workbench sessions panel shows on session routes, listing sessions
  const panel = page.locator("[data-workbench-panel]")
  await expect(panel).toBeVisible()
  await expect(panel.getByText(fixture.expected.sourceTitle).first()).toBeVisible()

  const sidebarToggle = page.getByRole("button", { name: "Toggle sidebar" })
  await sidebarToggle.click()
  await expect(panel).toBeHidden()

  await page.goto(sessionRoute)
  await expect(page.locator(".no-scrollbar div[data-active]").first()).toBeVisible()
  await expect(panel).toBeHidden()

  await sidebarToggle.click()
  await expect(panel).toBeVisible()
})
