import { test, expect } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

test("pane boot watch", async ({ page }) => {
  test.setTimeout(120_000)
  page.on("console", (m) => console.log("[frame-console]", m.text().slice(0, 200)))
  page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 300)))
  await page.setViewportSize({ width: 1440, height: 900 })
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
      JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] }, lastProject: { local: directory } }),
    )
  }, fixture.directory)
  await page.goto("/")
  await expectAppVisible(page.getByText("Open chat").first())
  await page.goto(`/${base64Encode(fixture.directory)}/session/${fixture.targetID}`)
  const entry = page.locator("[data-workbench-panel] button", { hasText: fixture.expected.sourceTitle }).first()
  const box = (await entry.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + 40, 450, { steps: 6 })
  await page.mouse.move(1428, 450, { steps: 6 })
  await page.mouse.up()
  await expect(page.locator("[data-pane]")).toHaveCount(1)
  const frame = page.frameLocator("iframe[sandbox]").locator("body")
  await expect.poll(async () => (await frame.innerText()).trim().length, { timeout: 30_000 }).toBeGreaterThan(0)
  const text = await frame.innerText()
  console.log("PANE BODY (first 400):", JSON.stringify(text.trim().slice(0, 400)))
})
