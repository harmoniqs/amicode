import { test, expect, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

// ============================================================================
// amicode#105 chrome surfaces — AC button_flow_e2e_passing >= 3:
//   1. the vault button opens the POPULATED global drawer on home
//   2. sidebar-right toggles a SINGLE-PANE work column (pressed state truthful)
//   3. the status popover opens inside the viewport (no magic shift)
// ============================================================================

const sessionRoute = `/${base64Encode(fixture.directory)}/session/${fixture.sourceID}`

async function bootApp(page: Page) {
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
}

async function mockVaultRoutes(page: Page) {
  // Registered AFTER the base mock — last registration wins in Playwright.
  await page.route("**/amicode/vaults", (route) =>
    route.fulfill({ json: { mounts: [{ id: "personal", kind: "personal", writable: true }] } }),
  )
  await page.route("**/amicode/vault-files*", (route) =>
    route.fulfill({
      json: { ok: true, files: [{ path: "notes/todo.md", name: "todo.md", size: 42, readable: true }] },
    }),
  )
}

test("vault button opens the populated drawer on home (global host)", async ({ page }) => {
  await bootApp(page)
  await mockVaultRoutes(page)
  await page.goto("/")
  await expectAppVisible(page.getByText("Open chat").first())

  await page.getByRole("button", { name: "Open vault" }).click()

  const drawer = page.locator('[data-component="amico-vault-panel"]')
  await expect(drawer).toBeVisible()
  // populated, not a silent empty shell — the mocked tree renders (dirs
  // start collapsed: unfold, then the file is there)
  await drawer.getByRole("button", { name: "notes" }).click()
  await expect(drawer.getByText("todo.md")).toBeVisible()
  // and it closes from the same TITLEBAR button (the toggle is not one-way)
  await page.getByRole("banner").getByRole("button", { name: "Close vault panel" }).click()
  await expect(drawer).toBeHidden()
})

test("sidebar-right toggles a single-pane work column, pressed state truthful", async ({ page }) => {
  await bootApp(page)
  await page.goto(sessionRoute)
  const toggle = page.getByRole("button", { name: "Toggle review" })
  await expect(toggle).toBeVisible()

  await toggle.click()
  const column = page.locator("#review-panel")
  await expect(column).toBeVisible()
  await expect(toggle).toHaveAttribute("aria-expanded", "true")
  // single-pane: the review file-list sidebar never renders (the split that
  // squished the chat) — the aside must not exist even with the column open
  await expect(page.locator('[data-slot="session-review-v2-sidebar"]')).toHaveCount(0)
  // bounded: the column is fixed-width and the chat is the flex REMAINDER —
  // the pre-fix review pane took everything the chat left behind
  const width = await page.evaluate(() => window.innerWidth)
  const columnBox = (await column.boundingBox())!
  expect(columnBox.width).toBeLessThanOrEqual(width * 0.6)
  expect(columnBox.width).toBeLessThan(width / 2)

  await toggle.click()
  await expect(column).toBeHidden()
  await expect(toggle).toHaveAttribute("aria-expanded", "false")
})

test("status popover opens inside the viewport (no magic shift)", async ({ page }) => {
  await bootApp(page)
  await page.goto(sessionRoute)
  const trigger = page.getByRole("button", { name: "Status" })
  await expect(trigger).toBeVisible()

  await trigger.click()
  const body = page.locator('[data-slot="popover-body"]').first()
  await expect(body).toBeVisible()
  const box = (await body.boundingBox())!
  const width = await page.evaluate(() => window.innerWidth)
  // the old shift={-168} could land the panel off-anchor/clipped; honest
  // anchoring keeps it fully inside the viewport
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(width)
})
