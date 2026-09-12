import { test, expect, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

// ============================================================================
// Workbench drops — S2 gate (spec-20260731-110956-workbench-panes-refactor):
//   accidental_splits == 0          (sloppy drags change nothing)
//   drop_targets_are_explicit == 1  (only rails/strips/panel accept; content rejects)
//   duplicate_or_lost_tabs_after_move == 0  (incl. fault injection: dead pane boot)
// ============================================================================

const sourceRoute = `/${base64Encode(fixture.directory)}/session/${fixture.sourceID}`
const targetRoute = `/${base64Encode(fixture.directory)}/session/${fixture.targetID}`

async function boot(page: Page) {
  await mockOpenCodeServer(page, {
    sessions: fixture.sessions,
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages,
  })
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
  await expectAppVisible(page.getByText("Open chat").first())
}

/** HTML5 drag helper: from a locator's center to (x, y). */
async function drag(page: Page, from: ReturnType<Page["locator"]>, to: { x: number; y: number }) {
  const box = (await from.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 20, box.y + 60, { steps: 6 })
  await page.mouse.move(to.x, to.y, { steps: 10 })
  await page.mouse.up()
}

const mainStripTabs = (page: Page) => page.locator("[data-split-main] .no-scrollbar div[data-active], [data-split-main] .no-scrollbar .tab")
const stripTabCount = (page: Page) => page.locator(".no-scrollbar div[data-active]").count()
const paneFrame = (page: Page) => page.frameLocator("iframe[sandbox]")

/** Split via panel: drag the source session's panel entry onto the right rail. */
async function splitFromPanel(page: Page) {
  const entry = page.locator("[data-workbench-panel] button", { hasText: fixture.expected.sourceTitle }).first()
  await expect(entry).toBeVisible()
  await drag(page, entry, { x: page.viewportSize()!.width - 12, y: 450 })
  await expect(page.locator("[data-pane]")).toHaveCount(1)
  // the pane boots its own app instance — slow in dev (~8s cold vite). Its
  // strip rendering doubles as the drop model's boot-complete signal (its
  // first tabs-changed report to the mirror lands in the same boot).
  await expect(paneFrame(page).locator(".no-scrollbar div[data-active]").first()).toBeVisible({ timeout: 25_000 })
}

test.beforeEach(async ({ page }) => {
  test.setTimeout(30_000)
  page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 300)))
  page.on("console", (m) => {
    if (m.type() === "error" || m.text().includes("workbench")) console.log("[console]", m.text().slice(0, 200))
  })
  await page.setViewportSize({ width: 1440, height: 900 })
})

test("S2.1 accidental_splits == 0: a sloppy drag into content changes nothing", async ({ page }) => {
  await boot(page)
  await page.goto(sourceRoute)
  const tab = page.locator(".no-scrollbar div[data-active]").first()
  await expect(tab).toBeVisible()
  const before = await stripTabCount(page)
  await drag(page, tab, { x: 400, y: 500 })
  await expect(page.locator("[data-pane]")).toHaveCount(0)
  expect(await stripTabCount(page)).toBe(before)
})

test("S2.2 drop_targets_are_explicit: the main content area rejects drops", async ({ page }) => {
  await boot(page)
  await page.goto(targetRoute)
  await splitFromPanel(page)
  const tab = page.locator(".no-scrollbar div[data-active]").first()
  const before = await stripTabCount(page)
  // dead-center of the main content — not a strip, not a rail, not the panel
  await drag(page, tab, { x: 720, y: 620 })
  expect(await stripTabCount(page)).toBe(before)
  // and the pane keeps its own single tab
  await expect(paneFrame(page).locator(".no-scrollbar div[data-active]")).toHaveCount(1)
})

test("S2.3 panel entries are drag sources: panel → right rail splits with that session", async ({ page }) => {
  await boot(page)
  await page.goto(targetRoute)
  await splitFromPanel(page)
  // the pane shows the dragged session's tab
  await expect(paneFrame(page).locator(".no-scrollbar div[data-active]")).toHaveCount(1)
  // and the main strip is untouched
  expect(await stripTabCount(page)).toBe(1)
})

test("S2.4 move main → pane: the tab leaves the main strip and activates in the pane", async ({ page }) => {
  await boot(page)
  // main strip holds only the TARGET tab; the source session splits from the panel
  await page.goto(targetRoute)
  expect(await stripTabCount(page)).toBe(1)
  await splitFromPanel(page)

  // drag the main tab (target session) onto the pane's strip region
  const tab = page.locator(".no-scrollbar div[data-active]").first()
  const paneBox = (await page.locator("[data-pane]").boundingBox())!
  await drag(page, tab, { x: paneBox.x + paneBox.width / 2, y: paneBox.y + 18 })

  // the target tab left the main strip; the pane now holds source + target
  expect(await stripTabCount(page)).toBe(0)
  await expect(paneFrame(page).locator(".no-scrollbar div[data-active]")).toHaveCount(2)
  // the moved session is the pane's visible content
  await expect(paneFrame(page).getByText(fixture.expected.targetTitle).first()).toBeVisible()
})

test("S2.5 dock pane → main strip: the tab comes home", async ({ page }) => {
  await boot(page)
  await page.goto(targetRoute)
  await splitFromPanel(page)

  // drag the pane's tab back onto the main strip. NOTE: synthetic (CDP)
  // drags don't initiate HTML5 DnD inside the sandboxed pane iframe — a
  // platform limit, not app behavior. So the test exercises the pane's OWN
  // wiring seam-for-seam: dispatch dragstart on the pane's tab (fires its
  // wired listener → posts drag-tab-start to the parent), then drop on the
  // main strip (fires the parent's resolution → move executes).
  const paneTab = paneFrame(page).locator(".no-scrollbar div[data-active]").first()
  await expect(paneTab).toBeVisible()
  const path = await paneTab.evaluate((el) => {
    const href = el.querySelector("a")?.getAttribute("href") ?? ""
    el.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true }))
    return href
  })
  expect(path).toContain("/session/")

  const mainStrip = page.locator("[data-split-main] .no-scrollbar").first()
  const stripBox = (await mainStrip.boundingBox())!
  await mainStrip.evaluate((el, box) => {
    const row = el.closest("div.flex-row") ?? el
    row.dispatchEvent(
      new DragEvent("dragover", { bubbles: true, cancelable: true, clientX: box.x + 120, clientY: box.y + box.height / 2 }),
    )
    row.dispatchEvent(
      new DragEvent("drop", { bubbles: true, cancelable: true, clientX: box.x + 120, clientY: box.y + box.height / 2 }),
    )
  }, stripBox)

  await expect.poll(() => stripTabCount(page), { timeout: 5000 }).toBe(2)
})

test("S2.6 same-session singleton: dropping an already-open session focuses it, never duplicates", async ({ page }) => {
  await boot(page)
  await page.goto(sourceRoute)
  // the source session is open in main; drag its PANEL entry to the right rail
  const entry = page.locator("[data-workbench-panel] button", { hasText: fixture.expected.sourceTitle }).first()
  await drag(page, entry, { x: page.viewportSize()!.width - 12, y: 450 })
  await page.waitForTimeout(800)
  // no split happened — the existing tab was focused instead
  await expect(page.locator("[data-pane]")).toHaveCount(0)
  expect(await stripTabCount(page)).toBe(1)
})

test("S2.7 fault injection: a pane that never boots cannot swallow a tab", async ({ page }) => {
  await boot(page)
  // main shows the TARGET session — the SOURCE session (dragged below) must
  // not already be open, or the rail singleton gate focuses instead of splitting
  await page.goto(targetRoute)
  // block the pane iframe's app document — the pane boots empty and the
  // self-heal guard will merge it; a dropped tab must survive in main.
  await page.route("**/*", (route) => {
    const url = route.request().url()
    if (url.includes("amicode_pane=")) return route.abort()
    return route.fallback()
  })
  const entry = page.locator("[data-workbench-panel] button", { hasText: fixture.expected.sourceTitle }).first()
  await drag(page, entry, { x: page.viewportSize()!.width - 12, y: 450 })
  await expect(page.locator("[data-pane]")).toHaveCount(1)

  // drag the main tab toward the dead pane's strip region
  const tab = page.locator(".no-scrollbar div[data-active]").first()
  const paneBox = (await page.locator("[data-pane]").boundingBox())!
  await drag(page, tab, { x: paneBox.x + paneBox.width / 2, y: paneBox.y + 18 })

  // nothing was lost into the void: the tab is still open in main
  expect(await stripTabCount(page)).toBe(1)
  await expect(page.locator(".no-scrollbar div[data-active]")).toHaveCount(1)
})
