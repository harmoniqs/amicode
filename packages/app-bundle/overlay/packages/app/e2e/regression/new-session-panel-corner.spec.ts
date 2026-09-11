import { expect, test, type Page } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { createPdfFixture } from "../utils/pdf-fixture"
import { dragSelectText } from "../utils/text-selection"
import { expectAppVisible } from "../utils/waits"

const draftID = "draft_new_session_panel_corner"
const directory = "C:/OpenCode/NewSessionPanelCorner"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
const previewFile = "notes/draft-preview.md"
const previewContent = "Draft preview contents."
const pdfPreviewFile = "papers/draft-preview.pdf"
const pdfPreviewText = "Amicode draft PDF text"
const pdfPreviewContent = createPdfFixture([pdfPreviewText])

test.use({
  viewport: { width: 935, height: 522 },
  deviceScaleFactor: 1,
})

test("matches the rounded panel corners to the dark new-session background", async ({ page }, testInfo) => {
  await openDraft(page)
  const panel = page.locator('[data-component="session-new-design"]')
  await expect(panel).toHaveCount(1)
  const box = await panel.boundingBox()
  if (!box) throw new Error("New-session panel bounds are unavailable")

  const screenshot = await page.screenshot({ path: testInfo.outputPath("new-session-dark.png") })
  const corners = await page.evaluate(
    async ({ source, points }) => {
      const image = new Image()
      image.src = source
      await image.decode()
      const canvas = document.createElement("canvas")
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext("2d")
      if (!context) throw new Error("2D canvas is unavailable")
      context.drawImage(image, 0, 0)
      return points.map((point) => Array.from(context.getImageData(point.x, point.y, 1, 1).data))
    },
    {
      source: `data:image/png;base64,${screenshot.toString("base64")}`,
      points: [
        { x: Math.floor(box.x), y: Math.floor(box.y) },
        { x: Math.ceil(box.x + box.width) - 1, y: Math.floor(box.y) },
        { x: Math.floor(box.x), y: Math.ceil(box.y + box.height) - 1 },
        { x: Math.ceil(box.x + box.width) - 1, y: Math.ceil(box.y + box.height) - 1 },
      ],
    },
  )

  expect(corners.every(([red, green, blue, alpha]) => red <= 8 && green <= 8 && blue <= 8 && alpha === 255)).toBe(true)
})

test("opens and reopens Preview without promoting a new-session draft", async ({ page }) => {
  await openDraft(page)

  await postPreviewFile(page)
  const preview = page.locator("[data-draft-preview]")
  await expect(preview).toBeVisible()
  await expect(preview.getByRole("tab", { name: "draft-preview.md" })).toBeVisible()
  await expect(preview.getByText(previewContent, { exact: true })).toBeVisible()
  expect(new URL(page.url()).pathname).toBe("/new-session")
  expect(new URL(page.url()).searchParams.get("draftId")).toBe(draftID)

  await preview.getByRole("button", { name: "Close Preview" }).click()
  await expect(preview).toHaveCount(0)

  await postPreviewFile(page)
  await expect(preview).toBeVisible()
  await expect(preview.getByRole("tab", { name: "draft-preview.md" })).toBeVisible()
})

test("shows selectable PDF text in draft Preview", async ({ page }) => {
  await openDraft(page)
  await postPreviewFile(page, pdfPreviewFile)

  const text = page.locator("[data-draft-preview]").getByText(pdfPreviewText, { exact: true })
  await expect(text).toBeVisible()
  await dragSelectText(page, text)
  await expect.poll(() => text.evaluate(() => window.getSelection()?.toString())).toBe(pdfPreviewText)
})

async function openDraft(page: Page) {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: "proj_new_session_panel_corner",
      worktree: directory,
      vcs: "git",
      name: "new-session-panel-corner",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: { all: [], connected: [], default: {} },
    sessions: [],
    pageMessages: () => ({ items: [] }),
    fileContent: (path) => {
      if (path === previewFile) return { type: "text", content: previewContent }
      if (path === pdfPreviewFile) return { type: "binary", content: pdfPreviewContent, encoding: "base64", mimeType: "application/pdf" }
      return undefined
    },
  })
  await page.addInitScript(
    ({ directory, draftID, server }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem("opencode-theme-id", "oc-2")
      localStorage.setItem("opencode-color-scheme", "dark")
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify([{ type: "draft", draftID, server, directory }]),
      )
    },
    { directory, draftID, server },
  )

  await page.goto(`/new-session?draftId=${draftID}`)
  await expectAppVisible(page.locator('[data-component="prompt-input"]'))
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "dark")
}

async function postPreviewFile(page: Page, path = previewFile) {
  await page.evaluate((path) => {
    window.postMessage({ source: "amicode", kind: "preview-file", path }, "*")
  }, path)
}
