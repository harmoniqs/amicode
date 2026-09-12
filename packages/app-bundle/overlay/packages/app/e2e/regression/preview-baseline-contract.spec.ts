import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type Locator } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { createPdfFixture } from "../utils/pdf-fixture"
import { dragSelectText } from "../utils/text-selection"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/OpenCode/PreviewBaselineContract"
const projectID = "proj_preview_baseline_contract"
const sessionID = "ses_preview_baseline_contract"
const title = "Preview baseline contract"
const markdownFile = "notes/baseline.md"
const secondMarkdownFile = "notes/second.md"
const juliaFile = "scripts/preview.jl"
const juliaContent = "function evolve(state)\n  return state + 1\nend\n"
const imageFile = "assets/preview.png"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
const markdownContent = ["# Baseline Preview", "", "The renderer must keep focus."]
  .concat(Array.from({ length: 200 }, (_, index) => `Scrollable preview paragraph ${index}.`))
  .join("\n\n")
const secondMarkdownContent = "# Second Preview\n\nThe second renderer stays alive."
const imageContent = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR+UgAAAABJRU5ErkJggg=="
const pdfFile = "papers/selectable.pdf"
const pdfText = "Amicode selectable PDF text"
const pdfContent = createPdfFixture([pdfText])
const noTextPdfFile = "papers/no-selectable-text.pdf"
const noTextPdfContent = createPdfFixture([""])
const partialTextPdfFile = "papers/partial-selectable-text.pdf"
const partialTextPdfContent = createPdfFixture([pdfText, ""])
const multipagePdfFile = "papers/multipage.pdf"
const multipagePdfContent = createPdfFixture(["First PDF page", "Second PDF page"])
const invalidPdfFile = "papers/invalid.pdf"
const invalidPdfContent = "bm90IGEgcGRm"

test.use({ viewport: { width: 1440, height: 900 } })

test("keeps Markdown typing in CodeMirror after its language support loads", async ({ page }) => {
  await openPreview(page)

  const panel = page.locator("#review-panel")
  await panel.getByRole("button", { name: "Edit" }).click()

  const editor = panel.locator(".cm-content")
  await expect(editor).toBeVisible()
  await expect(editor.locator("span").filter({ hasText: "Baseline Preview" })).toBeVisible()
  await editor.click()
  await editor.press("End")
  await editor.type("\nTyped after language loading.")

  await expect(editor).toContainText("Typed after language loading.")
  await expect(editor).toBeFocused()
  await expect(page.locator('[data-component="prompt-input"]')).toHaveText("")
})

test("applies the bridged VS Code token color to a Julia Preview editor", async ({ page }) => {
  await openPreview(page)

  // A distinctive color makes this an end-to-end check of the full chain:
  // host message -> theme state -> Shiki Worker -> CM6 Decoration.mark.
  await page.evaluate(() => {
    window.postMessage({
      source: "amicode",
      kind: "syntax-theme",
      theme: {
        name: "Preview E2E Theme",
        tokenColors: [{ scope: "keyword", settings: { foreground: "#ff00aa" } }],
      },
    }, "*")
  })
  await openPreviewFile(page, juliaFile)

  const editor = page.locator(`#review-panel [data-preview-host="${juliaFile}"] .cm-content`)
  await expect(editor).toBeVisible()
  const functionToken = editor.locator("span").filter({ hasText: "function" }).first()
  await expect(functionToken).toBeVisible()
  await expect
    .poll(() => functionToken.evaluate((element) => getComputedStyle(element).color))
    .toBe("rgb(255, 0, 170)")
})

test("keeps the default cursor while a Preview tab crosses an editable file", async ({ page }) => {
  await openPreview(page)
  await openPreviewFile(page, secondMarkdownFile)

  const panel = page.locator("#review-panel")
  await panel.getByRole("tab", { name: "baseline.md" }).click()
  await panel.getByRole("button", { name: "Edit" }).click()

  const source = panel.getByRole("tab", { name: "second.md" })
  const editor = panel.locator('[data-preview-host="notes/baseline.md"] .cm-content')
  const sourceBox = await source.boundingBox()
  const editorBox = await editor.boundingBox()
  if (!sourceBox || !editorBox) throw new Error("Preview tab and editor must be measurable before dragging")

  const target = { x: editorBox.x + editorBox.width / 2, y: editorBox.y + editorBox.height / 2 }
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(target.x, target.y, { steps: 8 })

  await expect(page.locator("html[data-preview-tab-dragging]")).toHaveCount(1)
  await expect.poll(() => editor.evaluate((element) => getComputedStyle(element).cursor)).toBe("default")

  await page.mouse.up()
  await expect(page.locator("html[data-preview-tab-dragging]")).toHaveCount(0)
})

test("uses the Preview header for VS Code-style file tabs instead of a duplicate title", async ({ page }) => {
  await openPreview(page)

  const panel = page.locator("#review-panel")
  const tablist = panel.getByRole("tablist", { name: "Open previews" })
  const tab = tablist.getByRole("tab", { name: "baseline.md" })
  await expect(tablist).toHaveCSS("height", "32px")
  await expect(tab.locator("xpath=ancestor::*[@data-slot='tabs-trigger-wrapper']")).toHaveCount(1)
  await expect(panel.getByText("baseline.md", { exact: true })).toHaveCount(1)
  await expect(tablist).toHaveCSS("border-bottom-width", "0px")
  await expect(tablist.evaluate((element) => getComputedStyle(element, "::after").borderBottomWidth)).resolves.toBe(
    "0px",
  )
})

test("leaves Files Changed after its surface tab closes", async ({ page }) => {
  await openPreview(page)

  const panel = page.locator("#review-panel")
  const reviewClose = panel.locator(
    '[data-slot="tabs-trigger-wrapper"][data-value="review"] [data-slot="tabs-trigger-close-button"] button',
  )

  await panel.getByRole("tab", { name: /^Files Changed/ }).click()
  await expect(panel.getByRole("tab", { name: /^Files Changed/ })).toHaveAttribute("aria-selected", "true")
  await reviewClose.click()

  await expect(panel.getByRole("tab", { name: /^Files Changed/ })).toHaveCount(0)
  await expect(panel.getByRole("tab", { name: "Preview", exact: true })).toHaveAttribute("aria-selected", "true")
})

test("keeps the Markdown zoom pill aligned with other Preview files", async ({ page }) => {
  await openPreview(page)

  const panel = page.locator("#review-panel")
  const markdownHost = panel.locator(`[data-preview-host="${markdownFile}"]`)
  const modeToggle = markdownHost.getByRole("button", { name: "Preview", exact: true })
  const markdownZoom = markdownHost.locator("[data-preview-zoom]")
  const modeBox = await modeToggle.boundingBox()
  const markdownZoomBox = await markdownZoom.boundingBox()
  if (!modeBox || !markdownZoomBox) throw new Error("Markdown controls must be measurable")

  expect(modeBox.x).toBeLessThan(markdownZoomBox.x)

  await openPreviewFile(page, imageFile)
  const imageZoom = panel.locator(`[data-preview-host="${imageFile}"] [data-preview-zoom]`)
  const imageZoomBox = await imageZoom.boundingBox()
  if (!imageZoomBox) throw new Error("Image zoom control must be measurable")

  expect(Math.abs(markdownZoomBox.x - imageZoomBox.x)).toBeLessThanOrEqual(1)
})

test("allows image previews to zoom to 1000%", async ({ page }) => {
  await openPreview(page)
  await openPreviewFile(page, imageFile)

  const panel = page.locator("#review-panel")
  const zoom = panel.locator(`[data-preview-host="${imageFile}"] [data-preview-zoom]`)
  await expect(panel.getByAltText("preview.png")).toBeVisible()
  await expect(zoom).toHaveValue("100%")
  await zoom.fill("1000")
  await zoom.press("Enter")
  await expect(zoom).toHaveValue("1000%")
})

test("keeps the image point under the pointer fixed through wheel zoom", async ({ page }) => {
  await openPreview(page)
  await openPreviewFile(page, imageFile)

  const host = page.locator(`#review-panel [data-preview-host="${imageFile}"]`)
  const zoom = host.locator("[data-preview-zoom]")
  const scroll = host.locator(".overflow-auto")
  await zoom.fill("200")
  await zoom.press("Enter")
  await expect(zoom).toHaveValue("200%")
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
  await expect.poll(() => scroll.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true)

  await scroll.evaluate((element) => {
    element.scrollLeft = (element.scrollWidth - element.clientWidth) / 3
  })
  const box = await scroll.boundingBox()
  if (!box) throw new Error("Image preview scroll container must be measurable")

  const focusX = box.width * 0.25
  const before = await scroll.evaluate((element) => ({
    scrollLeft: element.scrollLeft,
    clientWidth: element.clientWidth,
  }))
  for (const deltaY of [-30, -30, -30]) {
    await scroll.dispatchEvent("wheel", {
      ctrlKey: true,
      deltaY,
      clientX: box.x + focusX,
      clientY: box.y + box.height / 2,
    })
  }
  await expect.poll(async () => Number((await zoom.inputValue()).replace("%", ""))).toBeGreaterThan(200)

  const nextZoom = Number((await zoom.inputValue()).replace("%", ""))
  const expectedScrollLeft = (before.scrollLeft + focusX) * (nextZoom / 200) - focusX
  await expect.poll(() => scroll.evaluate((element) => element.scrollLeft)).toBeCloseTo(expectedScrollLeft, 0)
})

test("lets a researcher select and copy text from a PDF Preview", async ({ page }) => {
  await openPreview(page)

  await page.evaluate((src) => {
    const writes: string[] = []
    ;(window as Window & { pdfClipboardWrites?: string[] }).pdfClipboardWrites = writes
    window.addEventListener("message", (event) => {
      const data = event.data as { source?: string; kind?: string; text?: string } | undefined
      if (data?.source === "amicode" && data.kind === "clipboard-write" && typeof data.text === "string") {
        writes.push(data.text)
      }
    })
    const iframe = document.createElement("iframe")
    iframe.id = "pdf-preview-webview"
    iframe.src = src
    iframe.style.cssText = "position: fixed; z-index: 9999; inset: 0; width: 100%; height: 100%; border: 0;"
    document.body.append(iframe)
  }, page.url())

  const preview = page.frameLocator("#pdf-preview-webview")
  await expect(preview.getByRole("heading", { name: title })).toBeVisible()
  await expect(preview.locator("#review-panel")).toBeAttached()
  await page.evaluate((path) => {
    document
      .querySelector<HTMLIFrameElement>("#pdf-preview-webview")
      ?.contentWindow?.postMessage({ source: "amicode", kind: "preview-file", path }, "*")
  }, pdfFile)

  const text = preview.getByText(pdfText, { exact: true })
  await expect(text).toBeVisible()
  await dragSelectText(page, text)
  await expect.poll(() => text.evaluate(() => window.getSelection()?.toString())).toBe(pdfText)
  expect(await text.evaluate((element) => getComputedStyle(element, "::selection").backgroundColor)).not.toBe(
    "rgba(0, 0, 0, 0)",
  )
  await preview
    .getByRole("tab", { name: "Preview", exact: true })
    .press(await page.evaluate(() => (navigator.platform.includes("Mac") ? "Meta+c" : "Control+c")))

  await expect
    .poll(() => page.evaluate(() => (window as Window & { pdfClipboardWrites?: string[] }).pdfClipboardWrites))
    .toEqual([pdfText])
})

test("keeps a PDF with no selectable text visible and explains the limitation", async ({ page }) => {
  await openPreview(page)
  await openPreviewFile(page, noTextPdfFile)

  const panel = page.locator("#review-panel")
  const host = panel.locator(`[data-preview-host="${noTextPdfFile}"]`)
  await expect(host.locator("canvas")).toBeVisible()
  await expect(panel.getByText("This PDF has no selectable text.", { exact: true })).toBeVisible()
  await expect(host.getByRole("status", { name: "Page 1 of 1" })).toHaveText("1 / 1")
  await expect(host.getByRole("button", { name: "Previous page" })).toBeDisabled()
  await expect(host.getByRole("button", { name: "Next page" })).toBeDisabled()
})

test("hides PDF page navigation when PDF rendering fails", async ({ page }) => {
  await openPreview(page)
  await openPreviewFile(page, invalidPdfFile)

  const host = page.locator(`#review-panel [data-preview-host="${invalidPdfFile}"]`)
  await expect(host.getByText("Could not render PDF", { exact: true })).toBeVisible()
  await expect(host.locator("[data-pdf-page-navigation]")).toHaveCount(0)
})

test("explains when text selection is unavailable on only some PDF pages", async ({ page }) => {
  await openPreview(page)
  await openPreviewFile(page, partialTextPdfFile)

  const panel = page.locator("#review-panel")
  await expect(panel.locator(`[data-preview-host="${partialTextPdfFile}"] canvas`)).toHaveCount(2)
  await expect(panel.getByText(pdfText, { exact: true })).toBeVisible()
  await expect(panel.getByText("Text selection is unavailable on some pages.", { exact: true })).toBeVisible()
})

test("shows PDF page navigation before the zoom controls", async ({ page }) => {
  await openPreview(page)
  await openPreviewFile(page, multipagePdfFile)

  const host = page.locator(`#review-panel [data-preview-host="${multipagePdfFile}"]`)
  const pageStatus = host.getByRole("status", { name: "Page 1 of 2" })
  const previous = host.getByRole("button", { name: "Previous page" })
  const next = host.getByRole("button", { name: "Next page" })
  const zoom = host.locator("[data-preview-zoom]")

  await expect(pageStatus).toHaveText("1 / 2")
  await expect(pageStatus).toHaveAttribute("aria-live", "polite")
  await expect(previous).toBeDisabled()
  await expect(next).toBeEnabled()

  const [navigationBox, zoomBox] = await Promise.all([pageStatus.boundingBox(), zoom.boundingBox()])
  if (!navigationBox || !zoomBox) throw new Error("PDF navigation and zoom controls must be measurable")
  expect(navigationBox.x + navigationBox.width).toBeLessThanOrEqual(zoomBox.x)
})

test("shows the editable PDF page field before page actions", async ({ page }) => {
  await openPreview(page)
  await openPreviewFile(page, multipagePdfFile)

  const host = page.locator(`#review-panel [data-preview-host="${multipagePdfFile}"]`)
  const pageInput = host.getByRole("textbox", { name: "Page number, 1 through 2" })
  const next = host.getByRole("button", { name: "Next page" })

  await expect(host.locator("label").filter({ hasText: "Page number" })).toHaveCount(1)
  await expect(pageInput).toHaveValue("1 / 2")
  const [inputBox, nextBox] = await Promise.all([pageInput.boundingBox(), next.boundingBox()])
  if (!inputBox || !nextBox) throw new Error("Page field and actions must be measurable")
  expect(inputBox.x + inputBox.width).toBeLessThanOrEqual(nextBox.x)
})

test("uses the same surface treatment for PDF page and zoom controls", async ({ page }) => {
  await openPreview(page)
  await openPreviewFile(page, multipagePdfFile)

  const host = page.locator(`#review-panel [data-preview-host="${multipagePdfFile}"]`)
  const pageControl = host.locator("[data-pdf-page-navigation]")
  const zoom = host.locator("[data-preview-zoom]")

  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme })
    const [pageSurface, zoomSurface] = await Promise.all([
      pageControl.evaluate((element) => {
        const style = getComputedStyle(element)
        return { background: style.backgroundColor, backdropFilter: style.backdropFilter }
      }),
      zoom.evaluate((element) => {
        const style = getComputedStyle(element.parentElement!)
        return { background: style.backgroundColor, backdropFilter: style.backdropFilter }
      }),
    ])
    expect(pageSurface).toEqual(zoomSurface)
  }
})

test("restores out-of-range manual PDF page entry", async ({ page }) => {
  await openPreview(page)
  await openPreviewFile(page, multipagePdfFile)

  const host = page.locator(`#review-panel [data-preview-host="${multipagePdfFile}"]`)
  const pageInput = host.getByRole("textbox", { name: "Page number, 1 through 2" })
  const pageStatus = host.getByRole("status")

  await pageInput.focus()
  await pageInput.fill("99")
  await pageInput.press("Enter")
  await expect(pageStatus).toHaveAccessibleName("Page 1 of 2")
  await expect(pageInput).toHaveValue("1 / 2")

  await pageInput.focus()
  await pageInput.fill("2")
  await pageInput.press("Enter")
  await expect(pageStatus).toHaveAccessibleName("Page 2 of 2")
  await expect(pageInput).toHaveValue("2 / 2")

  await pageInput.focus()
  await pageInput.fill("-4")
  await pageInput.press("Enter")
  await expect(pageStatus).toHaveAccessibleName("Page 2 of 2")
  await expect(pageInput).toHaveValue("2 / 2")
})

test("restores the current PDF page after invalid or cancelled entry", async ({ page }) => {
  await openPreview(page)
  await openPreviewFile(page, multipagePdfFile)

  const host = page.locator(`#review-panel [data-preview-host="${multipagePdfFile}"]`)
  const pageInput = host.getByRole("textbox", { name: "Page number, 1 through 2" })
  const pageStatus = host.getByRole("status")

  await pageInput.focus()
  await pageInput.fill("two")
  await pageInput.press("Enter")
  await expect(pageStatus).toHaveAccessibleName("Page 1 of 2")
  await expect(pageInput).toHaveValue("1 / 2")

  await pageInput.focus()
  await pageInput.fill("")
  await pageInput.press("Enter")
  await expect(pageInput).toHaveValue("1 / 2")

  await pageInput.focus()
  await pageInput.fill("2")
  await pageInput.press("Escape")
  await expect(pageStatus).toHaveAccessibleName("Page 1 of 2")
  await expect(pageInput).toHaveValue("1 / 2")
})

test("navigates a PDF page to the top of the Preview viewport", async ({ page }) => {
  await openPreview(page)
  await openPreviewFile(page, multipagePdfFile)

  const host = page.locator(`#review-panel [data-preview-host="${multipagePdfFile}"]`)
  const pageStatus = host.getByRole("status")
  const previous = host.getByRole("button", { name: "Previous page" })
  const next = host.getByRole("button", { name: "Next page" })
  const scroll = host.locator("[data-preview-scroll]")
  const secondPage = host.locator("canvas").nth(1)

  await expect(pageStatus).toHaveAccessibleName("Page 1 of 2")
  await next.focus()
  await next.press("Enter")
  await expect(pageStatus).toHaveAccessibleName("Page 2 of 2")
  await expect(previous).toBeEnabled()
  await expect(next).toBeDisabled()

  await expect.poll(async () => {
    const [scrollBox, pageBox] = await Promise.all([scroll.boundingBox(), secondPage.boundingBox()])
    return scrollBox && pageBox ? Math.abs(pageBox.y - scrollBox.y) : Infinity
  }).toBeLessThanOrEqual(20)

  await previous.focus()
  await previous.press("Enter")
  await expect(pageStatus).toHaveAccessibleName("Page 1 of 2")
})

test("tracks the PDF page nearest the Preview viewport center", async ({ page }) => {
  await openPreview(page)
  await openPreviewFile(page, multipagePdfFile)

  const host = page.locator(`#review-panel [data-preview-host="${multipagePdfFile}"]`)
  const pageStatus = host.getByRole("status")
  const canvases = host.locator("canvas")

  await expect(canvases).toHaveCount(2)
  await canvases.nth(1).evaluate((canvas) => {
    const scroll = canvas.closest<HTMLElement>("[data-preview-scroll]")
    if (!scroll) throw new Error("PDF canvas must be inside the Preview scroll container")
    scroll.scrollTop += canvas.getBoundingClientRect().top - scroll.getBoundingClientRect().top
  })
  await expect(pageStatus).toHaveAccessibleName("Page 2 of 2")

  await canvases.evaluateAll((elements) => {
    const [first, second] = elements
    if (!(first instanceof HTMLCanvasElement) || !(second instanceof HTMLCanvasElement)) {
      throw new Error("PDF page elements must be canvases")
    }
    const scroll = first?.closest<HTMLElement>("[data-preview-scroll]")
    if (!first || !second || !scroll) throw new Error("PDF pages must be inside the Preview scroll container")
    const scrollBounds = scroll.getBoundingClientRect()
    const firstBounds = first.getBoundingClientRect()
    const secondBounds = second.getBoundingClientRect()
    const firstCenter = firstBounds.top - scrollBounds.top + scroll.scrollTop + firstBounds.height / 2
    const secondCenter = secondBounds.top - scrollBounds.top + scroll.scrollTop + secondBounds.height / 2
    scroll.scrollTop = (firstCenter + secondCenter) / 2 - scroll.clientHeight / 2
  })
  await expect(pageStatus).toHaveAccessibleName("Page 1 of 2")
})

test("keeps selectable PDF text aligned with its page after zooming", async ({ page }) => {
  await openPreview(page)
  await openPreviewFile(page, pdfFile)

  const host = page.locator(`#review-panel [data-preview-host="${pdfFile}"]`)
  const canvas = host.locator("canvas")
  const text = host.getByText(pdfText, { exact: true })
  const zoom = host.locator("[data-preview-zoom]")
  await expect(text).toBeVisible()
  await expect.poll(() => textStaysWithinPage(text, canvas)).toBe(true)

  await zoom.fill("200")
  await zoom.press("Enter")
  await expect(zoom).toHaveValue("200%")
  await expect.poll(() => textStaysWithinPage(text, canvas)).toBe(true)
  await text.selectText()
  await expect.poll(() => text.evaluate(() => window.getSelection()?.toString())).toBe(pdfText)
})

test("keeps selectable PDF text live through repeated zoom updates", async ({ page }) => {
  await openPreview(page)
  await openPreviewFile(page, pdfFile)

  const host = page.locator(`#review-panel [data-preview-host="${pdfFile}"]`)
  const text = host.getByText(pdfText, { exact: true })
  const zoom = host.locator("[data-preview-zoom]")
  const scroll = host.locator(".overflow-auto")
  await expect(text).toBeVisible()
  const textHandle = await text.elementHandle()

  for (const deltaY of [-50, -50, -50]) {
    await scroll.dispatchEvent("wheel", { ctrlKey: true, deltaY })
  }

  await expect.poll(async () => Number((await zoom.inputValue()).replace("%", ""))).toBeGreaterThan(100)
  expect(await textHandle?.evaluate((element) => element.isConnected)).toBe(true)
  await expect(text).toBeVisible()
})

test("keeps the PDF point under the pointer fixed through wheel zoom", async ({ page }) => {
  await openPreview(page)
  await openPreviewFile(page, pdfFile)

  const host = page.locator(`#review-panel [data-preview-host="${pdfFile}"]`)
  const zoom = host.locator("[data-preview-zoom]")
  const scroll = host.locator(".overflow-auto")
  await zoom.fill("200")
  await zoom.press("Enter")
  await expect(zoom).toHaveValue("200%")
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
  await expect.poll(() => scroll.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true)
  await expect.poll(() => scroll.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)

  await scroll.evaluate((element) => {
    element.scrollLeft = (element.scrollWidth - element.clientWidth) / 3
    element.scrollTop = (element.scrollHeight - element.clientHeight) / 3
  })
  const box = await scroll.boundingBox()
  if (!box) throw new Error("PDF preview scroll container must be measurable")

  const focus = { x: box.width * 0.25, y: box.height * 0.4 }
  const before = await scroll.evaluate((element) => ({
    scrollLeft: element.scrollLeft,
    scrollTop: element.scrollTop,
  }))
  await scroll.dispatchEvent("wheel", {
    ctrlKey: true,
    deltaY: -80,
    clientX: box.x + focus.x,
    clientY: box.y + focus.y,
  })
  await expect.poll(async () => Number((await zoom.inputValue()).replace("%", ""))).toBeGreaterThan(200)

  const nextZoom = Number((await zoom.inputValue()).replace("%", ""))
  const ratio = nextZoom / 200
  await expect
    .poll(() => scroll.evaluate((element) => element.scrollLeft))
    .toBeCloseTo((before.scrollLeft + focus.x) * ratio - focus.x, 0)
  const expectedScrollTop = (before.scrollTop + focus.y) * ratio - focus.y
  await expect
    .poll(() => scroll.evaluate((element, expected) => Math.abs(element.scrollTop - expected), expectedScrollTop))
    .toBeLessThanOrEqual(1)
})

test("keeps Preview controls clear of an overflowing PDF scroll rail", async ({ page }) => {
  await openPreview(page)
  await openPreviewFile(page, pdfFile)

  const host = page.locator(`#review-panel [data-preview-host="${pdfFile}"]`)
  const scroll = host.locator(".overflow-auto")
  const controls = host.locator("[data-preview-controls]")
  const zoom = host.locator("[data-preview-zoom]")
  await zoom.fill("200")
  await zoom.press("Enter")
  await expect(zoom).toHaveValue("200%")
  await expect.poll(() => scroll.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)

  const scrollBox = await scroll.boundingBox()
  const controlsBox = await controls.boundingBox()
  if (!scrollBox || !controlsBox) throw new Error("Preview controls and scroll rail must be measurable")
  expect(scrollBox.x + scrollBox.width - (controlsBox.x + controlsBox.width)).toBeGreaterThanOrEqual(20)
})

test("defers PDF raster replacement until a zoom burst settles", async ({ page }) => {
  await openPreview(page)
  await openPreviewFile(page, pdfFile)

  const host = page.locator(`#review-panel [data-preview-host="${pdfFile}"]`)
  const canvas = host.locator("canvas")
  const scroll = host.locator(".overflow-auto")
  const initialWidth = await canvas.evaluate((element) => (element as HTMLCanvasElement).width)

  await scroll.dispatchEvent("wheel", { ctrlKey: true, deltaY: -50 })
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
  expect(await canvas.evaluate((element) => (element as HTMLCanvasElement).width)).toBe(initialWidth)

  await expect
    .poll(() => canvas.evaluate((element) => (element as HTMLCanvasElement).width))
    .toBeGreaterThan(initialWidth)
})

test("copies a Preview tab filename or full filepath from its context menu", async ({ page }) => {
  await openPreview(page)
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          ;(window as Window & { copiedPreviewValue?: string }).copiedPreviewValue = value
        },
      },
    })
  })

  const tab = page.locator("#review-panel").getByRole("tab", { name: "baseline.md" })
  await tab.click({ button: "right" })
  await page.getByRole("menuitem", { name: "Copy filename" }).click()
  await expect
    .poll(() => page.evaluate(() => (window as Window & { copiedPreviewValue?: string }).copiedPreviewValue))
    .toBe("baseline.md")

  await tab.click({ button: "right" })
  await page.getByRole("menuitem", { name: "Copy filepath" }).click()
  await expect
    .poll(() => page.evaluate(() => (window as Window & { copiedPreviewValue?: string }).copiedPreviewValue))
    .toBe(markdownFile)
})

test("keeps ordinary Preview scrolling at the position selected by the user", async ({ page }) => {
  await openPreview(page)

  const renderer = page
    .getByText("The renderer must keep focus.", { exact: true })
    .locator("xpath=ancestor::div[contains(@class, 'overflow-auto')][1]")
  await renderer.hover()
  await page.mouse.wheel(0, 800)
  await expect.poll(() => renderer.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)

  const position = await renderer.evaluate((element) => element.scrollTop)
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      }),
  )
  await expect.poll(() => renderer.evaluate((element) => element.scrollTop)).toBe(position)
})

test("writes the current editor content on Cmd+S without moving focus to the composer", async ({ page }) => {
  await openPreview(page)

  const panel = page.locator("#review-panel")
  await panel.getByRole("button", { name: "Edit" }).click()

  const editor = panel.locator(".cm-content")
  await expect(editor).toBeVisible()
  await expect(editor.locator("span").filter({ hasText: "Baseline Preview" })).toBeVisible()
  await editor.click()
  await editor.press(await page.evaluate(() => (navigator.platform.includes("Mac") ? "Meta+a" : "Control+a")))
  await editor.type("Saved from CodeMirror.")
  await expect(panel.getByLabel("Unsaved changes")).toBeVisible()

  const write = page.waitForRequest(
    (request) => new URL(request.url()).pathname.endsWith("/file/write") && request.method() === "POST",
  )
  await editor.press(await page.evaluate(() => (navigator.platform.includes("Mac") ? "Meta+s" : "Control+s")))

  expect((await write).postDataJSON()).toEqual({
    path: markdownFile,
    content: "Saved from CodeMirror.",
  })
  await expect(editor).toBeFocused()
  await expect(page.locator('[data-component="prompt-input"]')).toHaveText("")
})

test("retains renderer hosts and editor state through inner and outer Preview tabs", async ({ page }) => {
  await openPreview(page)
  await openPreviewFile(page, secondMarkdownFile)

  const panel = page.locator("#review-panel")
  const tabs = panel.getByRole("tablist", { name: "Open previews" })
  await expect(tabs.getByRole("tab", { name: "baseline.md" })).toBeVisible()
  await expect(tabs.getByRole("tab", { name: "second.md" })).toBeVisible()
  const secondHost = panel.locator('[data-preview-host="notes/second.md"]')
  await expect(secondHost).toBeVisible()
  await expect(panel.locator('[data-preview-host="notes/baseline.md"]')).toBeHidden()
  await expect(panel.locator('[data-preview-host="notes/baseline.md"]')).toHaveAttribute("hidden", "")
  await expect(panel.getByText("The second renderer stays alive.", { exact: true })).toBeVisible()

  await tabs.getByRole("tab", { name: "baseline.md" }).click()
  const baselineHost = panel.locator('[data-preview-host="notes/baseline.md"]')
  await expect(baselineHost).toBeVisible()
  await expect(secondHost).toBeHidden()
  await expect(secondHost).toHaveAttribute("hidden", "")
  await expect(secondHost).toHaveAttribute("inert", "")
  await expect(secondHost.locator("[data-preview-controls]")).toBeHidden()
  const host = await baselineHost.elementHandle()
  expect(host).not.toBeNull()

  await panel.getByRole("button", { name: "Edit" }).click()
  const editor = baselineHost.locator(".cm-content")
  await editor.click()
  await editor.press("End")
  await editor.type("\nRetained draft.")
  await expect(editor).toContainText("Retained draft.")

  await tabs.getByRole("tab", { name: "second.md" }).click()
  await expect(baselineHost).toBeAttached()
  await tabs.getByRole("tab", { name: "baseline.md" }).click()
  await expect(baselineHost).toBeVisible()
  await expect(editor).toContainText("Retained draft.")
  expect(await host!.evaluate((element) => element.isConnected)).toBe(true)

  await panel.getByRole("tab", { name: "Home" }).click()
  await expect(panel.getByRole("tablist", { name: "Open previews" })).toBeHidden()
  await expect(baselineHost).toBeHidden()
  await expect(baselineHost).toBeAttached()
  await panel.getByRole("tab", { name: "Preview" }).click()
  await expect(baselineHost).toBeVisible()
  await expect(editor).toContainText("Retained draft.")
  expect(await host!.evaluate((element) => element.isConnected)).toBe(true)
})

test("keeps a dirty tab open on cancel and delegates save before closing", async ({ page }) => {
  await openPreview(page)

  const panel = page.locator("#review-panel")
  await panel.getByRole("button", { name: "Edit" }).click()
  const editor = panel.locator('[data-preview-host="notes/baseline.md"] .cm-content')
  await editor.click()
  await editor.press("End")
  await editor.type("\nSave before close.")
  await expect(panel.getByRole("button", { name: "Close baseline.md" }).locator("[data-preview-unsaved]")).toBeVisible()

  await panel.getByRole("button", { name: "Close baseline.md" }).click()
  const dialog = panel.getByRole("dialog", { name: "Unsaved changes" })
  await expect(dialog).toBeVisible()
  await dialog.getByRole("button", { name: "Cancel" }).click()
  await expect(panel.getByRole("tab", { name: "baseline.md" })).toBeVisible()
  await expect(editor).toContainText("Save before close.")

  const write = page.waitForRequest(
    (request) => new URL(request.url()).pathname.endsWith("/file/write") && request.method() === "POST",
  )
  await panel.getByRole("button", { name: "Close baseline.md" }).click()
  await dialog.getByRole("button", { name: "Save" }).click()

  const saved = (await write).postDataJSON()
  expect(saved.path).toBe(markdownFile)
  expect(saved.content).toContain("Save before close.")
  await expect(panel.getByRole("tab", { name: "baseline.md" })).toHaveCount(0)

  await openPreviewFile(page, markdownFile)
  await panel.getByRole("button", { name: "Edit" }).click()
  const reopenedEditor = panel.locator('[data-preview-host="notes/baseline.md"] .cm-content')
  await reopenedEditor.click()
  await reopenedEditor.type("Discard this draft.")
  await panel.getByRole("button", { name: "Close baseline.md" }).click()
  await dialog.getByRole("button", { name: "Discard" }).click()
  await expect(panel.getByRole("tab", { name: "baseline.md" })).toHaveCount(0)
})

test("reuses an open path and refuses a ninth renderer host", async ({ page }) => {
  await openPreview(page)
  const panel = page.locator("#review-panel")
  const baselineHost = panel.locator('[data-preview-host="notes/baseline.md"]')
  const host = await baselineHost.elementHandle()

  await openPreviewFile(page, markdownFile)
  await expect(panel.getByRole("tablist", { name: "Open previews" }).getByRole("tab")).toHaveCount(1)
  expect(await host!.evaluate((element) => element.isConnected)).toBe(true)

  for (const index of Array.from({ length: 7 }, (_, value) => value + 1)) {
    await openPreviewFile(page, `notes/capacity-${index}.md`)
  }
  await expect(panel.getByRole("tablist", { name: "Open previews" }).getByRole("tab")).toHaveCount(8)

  await openPreviewFile(page, "notes/capacity-8.md")
  await expect(panel.getByRole("alert")).toHaveText("Close an existing Preview tab before opening another file.")
  await expect(baselineHost).toBeAttached()
  expect(await host!.evaluate((element) => element.isConnected)).toBe(true)
})

test("reorders Preview tabs without recreating their renderer hosts", async ({ page }) => {
  await openPreview(page)
  await openPreviewFile(page, secondMarkdownFile)

  const panel = page.locator("#review-panel")
  const tabs = panel.getByRole("tablist", { name: "Open previews" })
  const leaf = panel.locator('[data-preview-leaf="root"]')
  const baselineHost = panel.locator('[data-preview-host="notes/baseline.md"]')
  const host = await baselineHost.elementHandle()
  const source = tabs.getByRole("tab", { name: "second.md" })
  const target = tabs.getByRole("tab", { name: "baseline.md" })
  const sourceBox = await source.boundingBox()
  const targetBox = await target.boundingBox()
  if (!sourceBox || !targetBox) throw new Error("Preview tabs must be measurable before dragging")

  const grabX = sourceBox.x + sourceBox.width / 2
  const dragX = targetBox.x + targetBox.width / 2 - 12
  await page.mouse.move(grabX, sourceBox.y + sourceBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(dragX, targetBox.y + targetBox.height / 2)
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
  await page.mouse.up()

  await expect(panel.locator("[data-preview-leaf]")).toHaveCount(1)
  expect(await leaf.getByRole("tab").allTextContents()).toEqual(["second.md", "baseline.md"])
  await expect(baselineHost).toBeAttached()
  expect(await host!.evaluate((element) => element.isConnected)).toBe(true)
})

test("shows a rail insertion gap while reordering Preview tabs", async ({ page }) => {
  await openPreview(page)
  await openPreviewFile(page, secondMarkdownFile)

  const panel = page.locator("#review-panel")
  const tabs = panel.getByRole("tablist", { name: "Open previews" })
  const source = tabs.getByRole("tab", { name: "second.md" })
  const target = tabs.getByRole("tab", { name: "baseline.md" })
  const sourceBox = await source.boundingBox()
  const targetBox = await target.boundingBox()
  if (!sourceBox || !targetBox) throw new Error("Preview tabs must be measurable before dragging")

  const grabX = sourceBox.x + sourceBox.width / 2
  const dragX = targetBox.x + targetBox.width / 2 - 12
  await page.mouse.move(grabX, sourceBox.y + sourceBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(dragX, targetBox.y + targetBox.height / 2, { steps: 8 })

  await expect(panel.locator("[data-preview-drop-preview]")).toHaveCount(0)
  await expect(page.locator("[data-preview-tab-drag-proxy]")).toHaveCount(0)
  await expect(source).toHaveCSS("opacity", "1")
  const draggedSourceBox = await source.boundingBox()
  expect(draggedSourceBox ? dragX - draggedSourceBox.x : Infinity).toBeCloseTo(grabX - sourceBox.x, 0)
  await expect.poll(async () => (await target.boundingBox())?.x ?? -Infinity).toBeGreaterThan(targetBox.x)
  await page.mouse.up()
})

test("slides later Preview tabs left when the first tab moves right", async ({ page }) => {
  await openPreview(page)
  await openPreviewFile(page, secondMarkdownFile)
  await openPreviewFile(page, "notes/third.md")

  const panel = page.locator("#review-panel")
  const tabs = panel.getByRole("tablist", { name: "Open previews" })
  const source = tabs.getByRole("tab", { name: "baseline.md" })
  const middle = tabs.getByRole("tab", { name: "second.md" })
  const target = tabs.getByRole("tab", { name: "third.md" })
  const sourceBox = await source.boundingBox()
  const middleBox = await middle.boundingBox()
  const targetBox = await target.boundingBox()
  if (!sourceBox || !middleBox || !targetBox) throw new Error("Preview tabs must be measurable before dragging")

  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(targetBox.x + targetBox.width - 4, targetBox.y + targetBox.height / 2, { steps: 8 })

  await expect.poll(async () => (await middle.boundingBox())?.x ?? Infinity).toBeLessThan(middleBox.x)
  await expect.poll(async () => (await target.boundingBox())?.x ?? Infinity).toBeLessThan(targetBox.x)
  await page.mouse.up()
})

test("snaps a Preview tab to its rail inside the capture zone", async ({ page }) => {
  await openPreview(page)
  await openPreviewFile(page, secondMarkdownFile)

  const panel = page.locator("#review-panel")
  const tabs = panel.getByRole("tablist", { name: "Open previews" })
  const source = tabs.getByRole("tab", { name: "second.md" })
  const railBox = await tabs.boundingBox()
  const sourceBox = await source.boundingBox()
  if (!railBox || !sourceBox) throw new Error("Preview rail and tab must be measurable before dragging")

  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(sourceBox.x + sourceBox.width / 2 - 12, railBox.y + railBox.height + 12, { steps: 8 })

  await expect.poll(async () => (await source.boundingBox())?.y ?? Infinity).toBeCloseTo(sourceBox.y, 0)
  await page.mouse.up()
})

test("keeps the dragged Preview tab under the pointer while it crosses another rail", async ({ page }) => {
  await openPreview(page)
  await openPreviewFile(page, secondMarkdownFile)

  const panel = page.locator("#review-panel")
  const rootLeaf = panel.locator('[data-preview-leaf="root"]')
  const source = rootLeaf.getByRole("tab", { name: "second.md" })
  const sourceBox = await source.boundingBox()
  const rootBox = await rootLeaf.boundingBox()
  if (!sourceBox || !rootBox) throw new Error("Preview tab and root leaf must be measurable before splitting")

  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(rootBox.x + rootBox.width - 2, rootBox.y + rootBox.height / 2, { steps: 8 })
  await page.mouse.up()

  const sourceLeaf = panel.locator('[data-preview-leaf="pane-1"]')
  const crossRailSource = sourceLeaf.getByRole("tab", { name: "second.md" })
  const target = rootLeaf.getByRole("tab", { name: "baseline.md" })
  const crossRailSourceBox = await crossRailSource.boundingBox()
  const targetBox = await target.boundingBox()
  if (!crossRailSourceBox || !targetBox) throw new Error("Preview rails must be measurable before cross-rail dragging")

  const grabX = crossRailSourceBox.x + crossRailSourceBox.width / 2
  const dropX = targetBox.x + targetBox.width / 2 - 12

  await page.mouse.move(grabX, crossRailSourceBox.y + crossRailSourceBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(dropX, targetBox.y + targetBox.height / 2, { steps: 8 })

  const dragged = panel.getByRole("tab", { name: "second.md" })
  await expect(dragged).toHaveCSS("opacity", "1")
  const draggedBox = await dragged.boundingBox()
  expect(draggedBox ? dropX - draggedBox.x : Infinity).toBeCloseTo(grabX - crossRailSourceBox.x, 0)
  await page.mouse.up()
})

test("splits a Preview leaf at its right edge without recreating the moved renderer", async ({ page }) => {
  await openPreview(page)
  await openPreviewFile(page, secondMarkdownFile)

  const panel = page.locator("#review-panel")
  const source = panel.getByRole("tab", { name: "second.md" })
  const sourceLeaf = panel.locator('[data-preview-leaf="root"]')
  const outerPreview = panel.getByRole("tab", { name: "Preview", exact: true })
  const movedHost = panel.locator('[data-preview-host="notes/second.md"]')
  const host = await movedHost.elementHandle()
  const sourceBox = await source.boundingBox()
  const leafBox = await sourceLeaf.boundingBox()
  const outerPreviewBox = await outerPreview.boundingBox()
  if (!sourceBox || !leafBox || !host || !outerPreviewBox)
    throw new Error("Preview tab and leaf must be measurable before splitting")

  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(leafBox.x + leafBox.width - 2, leafBox.y + leafBox.height / 2, { steps: 8 })
  await expect(panel.locator('[data-preview-dragging="notes/second.md"]')).toBeVisible()
  await expect(page.locator("[data-preview-tab-drag-proxy]")).toHaveCount(0)
  const preview = panel.locator('[data-preview-drop-preview="right"]')
  await expect(preview).toBeVisible()
  await expect(preview).toHaveCSS("pointer-events", "none")
  const previewBox = await preview.boundingBox()
  expect(previewBox?.width).toBeGreaterThanOrEqual(leafBox.width / 2 - 2)
  expect(previewBox?.height).toBeGreaterThanOrEqual(leafBox.height - 2)
  await page.mouse.up()
  await page.waitForTimeout(250)
  await expect(preview).toHaveCount(0)

  const destinationLeaf = panel.locator('[data-preview-leaf="pane-1"]')
  await expect(panel.locator("[data-preview-leaf]")).toHaveCount(2)
  const baselineTab = sourceLeaf.getByRole("tab", { name: "baseline.md" })
  await expect(baselineTab).toBeVisible()
  const baselineTabBox = await baselineTab.boundingBox()
  const sourceLeafTabBox = await sourceLeaf.boundingBox()
  expect(baselineTabBox?.x ?? -Infinity).toBeGreaterThanOrEqual(sourceLeafTabBox?.x ?? Infinity)
  expect((baselineTabBox?.x ?? Infinity) + (baselineTabBox?.width ?? Infinity)).toBeLessThanOrEqual(
    (sourceLeafTabBox?.x ?? -Infinity) + (sourceLeafTabBox?.width ?? -Infinity),
  )
  const destinationTab = destinationLeaf.getByRole("tab", { name: "second.md" })
  await expect(destinationTab).toHaveAttribute("aria-selected", "true")
  const destinationTabBox = await destinationTab.boundingBox()
  const destinationTabLeafBox = await destinationLeaf.boundingBox()
  expect(destinationTabBox?.x ?? -Infinity).toBeGreaterThanOrEqual(destinationTabLeafBox?.x ?? Infinity)
  expect((destinationTabBox?.x ?? Infinity) + (destinationTabBox?.width ?? Infinity)).toBeLessThanOrEqual(
    (destinationTabLeafBox?.x ?? -Infinity) + (destinationTabLeafBox?.width ?? -Infinity),
  )
  expect(await sourceLeaf.getByRole("tab").allTextContents()).toEqual(["baseline.md"])
  expect(await destinationLeaf.getByRole("tab").allTextContents()).toEqual(["second.md"])
  await expect(panel.getByRole("tab", { name: "second.md" })).toHaveCount(1)
  await expect(destinationTab).toHaveCSS("transform", "none")
  await expect(destinationLeaf.locator('[data-preview-tab="notes/second.md"]')).toHaveCSS("translate", "none")
  await expect(destinationLeaf.locator('[data-preview-host="notes/second.md"]')).toBeVisible()
  await expect(destinationLeaf.getByText("The second renderer stays alive.", { exact: true })).toBeVisible()
  await expect(sourceLeaf.getByText("The renderer must keep focus.", { exact: true })).toBeVisible()
  expect(await host.evaluate((element) => element.isConnected)).toBe(true)

  await sourceLeaf.getByText("The renderer must keep focus.", { exact: true }).click()
  await expect(sourceLeaf).toHaveAttribute("data-focused", "true")
  await expect(destinationLeaf).not.toHaveAttribute("data-focused", "true")

  await destinationLeaf.getByText("The second renderer stays alive.", { exact: true }).click()
  await expect(destinationLeaf).toHaveAttribute("data-focused", "true")
  await expect(sourceLeaf).not.toHaveAttribute("data-focused", "true")

  const sourceLeafBox = await sourceLeaf.boundingBox()
  const destinationLeafBox = await destinationLeaf.boundingBox()
  expect(sourceLeafBox?.width).toBeGreaterThanOrEqual(150)
  expect(destinationLeafBox?.width).toBeGreaterThanOrEqual(150)
  expect(destinationLeafBox?.x).toBeGreaterThan(sourceLeafBox!.x)
  expect((await outerPreview.boundingBox())?.x).toBe(outerPreviewBox.x)
  await expect(panel.getByRole("separator", { name: "Resize Preview panes" })).toHaveCSS("width", "1px")
})

test("distinguishes focused and unfocused Preview pane tabs while preserving pane corners", async ({ page }) => {
  await openPreview(page)
  await openPreviewFile(page, secondMarkdownFile)

  const panel = page.locator("#review-panel")
  const source = panel.getByRole("tab", { name: "second.md" })
  const rootLeaf = panel.locator('[data-preview-leaf="root"]')
  const sourceBox = await source.boundingBox()
  const rootBox = await rootLeaf.boundingBox()
  if (!sourceBox || !rootBox) throw new Error("Preview tab and leaf must be measurable before splitting")

  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(rootBox.x + rootBox.width / 2, rootBox.y + rootBox.height - 2, { steps: 8 })
  await page.mouse.up()

  const bottomLeaf = panel.locator('[data-preview-leaf="pane-1"]')
  await expect(bottomLeaf).toHaveAttribute("data-focused", "true")
  await expect(rootLeaf).toHaveCSS("border-bottom-left-radius", "0px")
  await expect(rootLeaf).toHaveCSS("border-bottom-right-radius", "0px")
  await expect(bottomLeaf).toHaveCSS("border-bottom-left-radius", "4px")
  await expect(bottomLeaf).toHaveCSS("border-bottom-right-radius", "4px")

  const selectedTabStyle = (leaf: ReturnType<typeof panel.locator>) =>
    leaf.locator('[data-slot="tabs-trigger-wrapper"]:has([data-selected])').evaluate((element) => {
      const style = getComputedStyle(element)
      return { backgroundColor: style.backgroundColor, color: style.color }
    })

  const focusedStyle = await selectedTabStyle(bottomLeaf)
  const unfocusedStyle = await selectedTabStyle(rootLeaf)
  expect(focusedStyle).not.toEqual(unfocusedStyle)

  await rootLeaf.getByText("The renderer must keep focus.", { exact: true }).click()
  await expect(rootLeaf).toHaveAttribute("data-focused", "true")
  await expect(bottomLeaf).not.toHaveAttribute("data-focused", "true")
  await expect.poll(() => selectedTabStyle(rootLeaf)).toEqual(focusedStyle)
  await expect.poll(() => selectedTabStyle(bottomLeaf)).toEqual(unfocusedStyle)
})

test("transfers a renderer into another leaf and collapses its emptied source", async ({ page }) => {
  await openPreview(page)
  await openPreviewFile(page, secondMarkdownFile)

  const panel = page.locator("#review-panel")
  const source = panel.getByRole("tab", { name: "second.md" })
  const rootLeaf = panel.locator('[data-preview-leaf="root"]')
  const initialSourceBox = await source.boundingBox()
  const rootBox = await rootLeaf.boundingBox()
  if (!initialSourceBox || !rootBox) throw new Error("Preview tab and leaf must be measurable before splitting")

  await page.mouse.move(
    initialSourceBox.x + initialSourceBox.width / 2,
    initialSourceBox.y + initialSourceBox.height / 2,
  )
  await page.mouse.down()
  await page.mouse.move(rootBox.x + rootBox.width - 2, rootBox.y + rootBox.height / 2, { steps: 8 })
  await page.mouse.up()

  const splitSource = panel.locator('[data-preview-leaf="pane-1"]')
  const movedHost = splitSource.locator('[data-preview-host="notes/second.md"]')
  const host = await movedHost.elementHandle()
  const transferTab = splitSource.getByRole("tab", { name: "second.md" })
  const transferBox = await transferTab.boundingBox()
  const transferTarget = await rootLeaf.boundingBox()
  if (!host || !transferBox || !transferTarget) throw new Error("Preview leaves must be measurable before transferring")

  await page.mouse.move(transferBox.x + transferBox.width / 2, transferBox.y + transferBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(transferTarget.x + transferTarget.width / 2, transferTarget.y + transferTarget.height / 2, {
    steps: 8,
  })

  const mergePreview = panel.locator('[data-preview-drop-preview="center"]')
  await expect(mergePreview).toBeVisible()
  const mergePreviewBox = await mergePreview.boundingBox()
  expect(mergePreviewBox).not.toBeNull()
  expect(Math.abs(mergePreviewBox!.x - transferTarget.x)).toBeLessThan(2)
  expect(Math.abs(mergePreviewBox!.y - transferTarget.y)).toBeLessThan(2)
  expect(Math.abs(mergePreviewBox!.width - transferTarget.width)).toBeLessThanOrEqual(2)
  expect(Math.abs(mergePreviewBox!.height - transferTarget.height)).toBeLessThanOrEqual(2)

  await page.mouse.up()
  await page.waitForTimeout(250)

  await expect(panel.locator("[data-preview-leaf]")).toHaveCount(1)
  await expect(rootLeaf.getByRole("tab", { name: "second.md" })).toHaveAttribute("aria-selected", "true")
  await expect(rootLeaf.locator('[data-preview-host="notes/second.md"]')).toBeVisible()
  await expect(rootLeaf.getByText("The second renderer stays alive.", { exact: true })).toBeVisible()
  expect(await host.evaluate((element) => element.isConnected)).toBe(true)
  await expect
    .poll(() =>
      panel.locator("[data-preview-workspace]").evaluate((element) => element.scrollWidth - element.clientWidth),
    )
    .toBeLessThanOrEqual(1)
})

test("retains a focused, scrolled editor and unsaved draft through a Preview edge split", async ({ page }) => {
  await openPreview(page)
  await openPreviewFile(page, secondMarkdownFile)

  const panel = page.locator("#review-panel")
  await panel.getByRole("tab", { name: "baseline.md" }).click()
  const movedHost = panel.locator('[data-preview-host="notes/baseline.md"]')
  await panel.getByRole("button", { name: "Edit" }).click()
  const editor = movedHost.locator(".cm-content")
  await editor.click()
  await editor.press("End")
  await editor.type("\nRelocated draft.")
  await expect(editor).toContainText("Relocated draft.")
  await expect(editor).toBeFocused()
  const editorScroller = movedHost.locator(".cm-scroller")
  await editorScroller.evaluate((element) => {
    element.scrollTop = Math.min(240, element.scrollHeight - element.clientHeight)
  })
  await expect.poll(() => editorScroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  const scrollPosition = await editorScroller.evaluate((element) => element.scrollTop)
  const host = await movedHost.elementHandle()

  const source = panel.getByRole("tab", { name: "baseline.md" })
  const rootLeaf = panel.locator('[data-preview-leaf="root"]')
  const sourceBox = await source.boundingBox()
  const rootBox = await rootLeaf.boundingBox()
  if (!host || !sourceBox || !rootBox) throw new Error("Preview tab and leaf must be measurable before splitting")

  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(rootBox.x + rootBox.width - 2, rootBox.y + rootBox.height / 2, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(250)

  const destinationLeaf = panel.locator('[data-preview-leaf="pane-1"]')
  await expect(destinationLeaf.locator('[data-preview-host="notes/baseline.md"] .cm-content')).toContainText(
    "Relocated draft.",
  )
  await expect(editor).toBeFocused()
  await expect.poll(() => editorScroller.evaluate((element) => element.scrollTop)).toBe(scrollPosition)
  expect(await host.evaluate((element) => element.isConnected)).toBe(true)
})

test("keeps Preview zoom independent in split panes", async ({ page }) => {
  await openPreview(page)
  await openPreviewFile(page, secondMarkdownFile)

  const panel = page.locator("#review-panel")
  const source = panel.getByRole("tab", { name: "second.md" })
  const rootLeaf = panel.locator('[data-preview-leaf="root"]')
  const sourceBox = await source.boundingBox()
  const rootBox = await rootLeaf.boundingBox()
  if (!sourceBox || !rootBox) throw new Error("Preview tab and leaf must be measurable before splitting")

  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(rootBox.x + rootBox.width - 2, rootBox.y + rootBox.height / 2, { steps: 8 })
  await page.mouse.up()

  const destinationLeaf = panel.locator('[data-preview-leaf="pane-1"]')
  const rootZoom = rootLeaf.locator("[data-preview-zoom]:visible")
  const destinationZoom = destinationLeaf.locator("[data-preview-zoom]")
  await expect(rootZoom).toHaveValue("100%")
  await expect(destinationZoom).toHaveValue("100%")

  await rootZoom.fill("130")
  await rootZoom.press("Enter")

  await expect(rootZoom).toHaveValue("130%")
  await expect(destinationZoom).toHaveValue("100%")
})

test("keeps each pane's zoom control inside its minimum-width leaf", async ({ page }) => {
  await openPreview(page)
  await openPreviewFile(page, secondMarkdownFile)

  const panel = page.locator("#review-panel")
  const source = panel.getByRole("tab", { name: "second.md" })
  const rootLeaf = panel.locator('[data-preview-leaf="root"]')
  const sourceBox = await source.boundingBox()
  const rootBox = await rootLeaf.boundingBox()
  if (!sourceBox || !rootBox) throw new Error("Preview tab and leaf must be measurable before splitting")

  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(rootBox.x + rootBox.width - 2, rootBox.y + rootBox.height / 2, { steps: 8 })
  await page.mouse.up()

  const destinationLeaf = panel.locator('[data-preview-leaf="pane-1"]')
  for (const leaf of [rootLeaf, destinationLeaf]) {
    const leafBox = await leaf.boundingBox()
    const inputBox = await leaf.locator("[data-preview-zoom]:visible").boundingBox()
    if (!leafBox || !inputBox) throw new Error("Preview leaf and zoom input must be measurable")
    expect(inputBox.x).toBeGreaterThanOrEqual(leafBox.x)
    expect(inputBox.x + inputBox.width).toBeLessThanOrEqual(leafBox.x + leafBox.width)
  }
})

test("inherits source zoom and focuses the new Preview leaf after a split", async ({ page }) => {
  await openPreview(page)
  await openPreviewFile(page, secondMarkdownFile)

  const panel = page.locator("#review-panel")
  const rootLeaf = panel.locator('[data-preview-leaf="root"]')
  const rootZoom = rootLeaf.locator('[data-preview-host="notes/second.md"] [data-preview-zoom]')
  await rootZoom.fill("130")
  await rootZoom.press("Enter")
  await expect(rootZoom).toHaveValue("130%")

  const source = panel.getByRole("tab", { name: "second.md" })
  const sourceBox = await source.boundingBox()
  const rootBox = await rootLeaf.boundingBox()
  if (!sourceBox || !rootBox) throw new Error("Preview tab and leaf must be measurable before splitting")

  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(rootBox.x + rootBox.width - 2, rootBox.y + rootBox.height / 2, { steps: 8 })
  await page.mouse.up()

  const destinationLeaf = panel.locator('[data-preview-leaf="pane-1"]')
  await expect(destinationLeaf).toHaveAttribute("data-focused", "true")
  await expect(destinationLeaf.locator("[data-preview-zoom]")).toHaveValue("130%")
})

test("adopts destination pane zoom when transferring a Preview renderer", async ({ page }) => {
  await openPreview(page)
  await openPreviewFile(page, secondMarkdownFile)

  const panel = page.locator("#review-panel")
  const source = panel.getByRole("tab", { name: "second.md" })
  const rootLeaf = panel.locator('[data-preview-leaf="root"]')
  const sourceBox = await source.boundingBox()
  const rootBox = await rootLeaf.boundingBox()
  if (!sourceBox || !rootBox) throw new Error("Preview tab and leaf must be measurable before splitting")

  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(rootBox.x + rootBox.width - 2, rootBox.y + rootBox.height / 2, { steps: 8 })
  await page.mouse.up()

  const rootZoom = rootLeaf.locator("[data-preview-zoom]")
  await rootZoom.fill("130")
  await rootZoom.press("Enter")
  await expect(rootZoom).toHaveValue("130%")

  const sourceLeaf = panel.locator('[data-preview-leaf="pane-1"]')
  const movedHost = sourceLeaf.locator('[data-preview-host="notes/second.md"]')
  const host = await movedHost.elementHandle()
  const transferTab = sourceLeaf.getByRole("tab", { name: "second.md" })
  const transferBox = await transferTab.boundingBox()
  const transferTarget = await rootLeaf.boundingBox()
  if (!host || !transferBox || !transferTarget) throw new Error("Preview leaves must be measurable before transferring")

  await page.mouse.move(transferBox.x + transferBox.width / 2, transferBox.y + transferBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(transferTarget.x + transferTarget.width / 2, transferTarget.y + transferTarget.height / 2, {
    steps: 8,
  })
  await page.mouse.up()

  await expect(rootLeaf.locator('[data-preview-host="notes/second.md"] [data-preview-zoom]')).toHaveValue("130%")
  expect(await host.evaluate((element) => element.isConnected)).toBe(true)
})

test("keeps both Preview leaves at their minimum width while resizing a divider", async ({ page }) => {
  await openPreview(page)
  await openPreviewFile(page, secondMarkdownFile)

  const panel = page.locator("#review-panel")
  const source = panel.getByRole("tab", { name: "second.md" })
  const rootLeaf = panel.locator('[data-preview-leaf="root"]')
  const sourceBox = await source.boundingBox()
  const rootBox = await rootLeaf.boundingBox()
  if (!sourceBox || !rootBox) throw new Error("Preview tab and leaf must be measurable before splitting")

  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(rootBox.x + rootBox.width - 2, rootBox.y + rootBox.height / 2, { steps: 8 })
  await page.mouse.up()

  const divider = panel.getByRole("separator", { name: "Resize Preview panes" })
  await expect(divider).toBeVisible()
  const dividerBox = await divider.boundingBox()
  const initialRootLeafBox = await rootLeaf.boundingBox()
  if (!dividerBox || !initialRootLeafBox) throw new Error("Preview pane divider must be measurable")

  const accent = await page.evaluate(() => {
    const probe = document.createElement("div")
    probe.style.color = "var(--accent)"
    document.body.append(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    return color
  })

  await page.mouse.move(dividerBox.x - 3, dividerBox.y + dividerBox.height / 2)
  await page.mouse.down()
  await expect(divider).toHaveAttribute("data-resizing", "true")
  await expect(divider).toHaveCSS("background-color", accent)
  await page.mouse.move(dividerBox.x + 400, dividerBox.y + dividerBox.height / 2, { steps: 8 })
  await page.mouse.up()
  await expect(divider).not.toHaveAttribute("data-resizing", "true")

  const resizedDividerBox = await divider.boundingBox()
  if (!resizedDividerBox) throw new Error("Resized Preview pane divider must be measurable")
  await page.mouse.move(resizedDividerBox.x - 3, resizedDividerBox.y + resizedDividerBox.height / 2)
  await expect(divider).toHaveCSS("background-color", accent)

  const destinationLeaf = panel.locator('[data-preview-leaf="pane-1"]')
  const sourceLeafBox = await rootLeaf.boundingBox()
  const destinationLeafBox = await destinationLeaf.boundingBox()
  expect(Math.abs((sourceLeafBox?.width ?? 0) - initialRootLeafBox.width)).toBeGreaterThan(1)
  expect(sourceLeafBox?.width).toBeGreaterThanOrEqual(150)
  expect(destinationLeafBox?.width).toBeGreaterThanOrEqual(150)
})

test("rejects a self-edge drop from a one-tab Preview leaf", async ({ page }) => {
  await openPreview(page)

  const panel = page.locator("#review-panel")
  const source = panel.getByRole("tab", { name: "baseline.md" })
  const leaf = panel.locator('[data-preview-leaf="root"]')
  const sourceBox = await source.boundingBox()
  const leafBox = await leaf.boundingBox()
  if (!sourceBox || !leafBox) throw new Error("Preview tab and leaf must be measurable before dragging")

  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(leafBox.x + leafBox.width - 2, leafBox.y + leafBox.height / 2, { steps: 8 })
  await expect(panel.locator("[data-preview-drop-preview]")).toHaveCount(0)
  await page.mouse.up()

  await expect(panel.locator("[data-preview-leaf]")).toHaveCount(1)
  await expect(leaf.getByRole("tab", { name: "baseline.md" })).toHaveAttribute("aria-selected", "true")
})

for (const edge of ["left", "top", "bottom"] as const) {
  test(`edge-splits a Preview leaf at its ${edge} target`, async ({ page }) => {
    await openPreview(page)
    await openPreviewFile(page, secondMarkdownFile)

    const panel = page.locator("#review-panel")
    const source = panel.getByRole("tab", { name: "second.md" })
    const rootLeaf = panel.locator('[data-preview-leaf="root"]')
    const sourceBox = await source.boundingBox()
    const rootBox = await rootLeaf.boundingBox()
    const contentBox = await rootLeaf.locator(".preview-pane-content").boundingBox()
    if (!sourceBox || !rootBox || !contentBox)
      throw new Error("Preview tab and pane content must be measurable before splitting")

    const target = {
      left: { x: rootBox.x + 2, y: rootBox.y + rootBox.height / 2 },
      top: { x: contentBox.x + contentBox.width / 2, y: contentBox.y + 2 },
      bottom: { x: rootBox.x + rootBox.width / 2, y: rootBox.y + rootBox.height - 2 },
    }[edge]
    await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(target.x, target.y, { steps: 8 })
    await expect(panel.locator(`[data-preview-drop-preview="${edge}"]`)).toBeVisible()
    await page.mouse.up()
    await page.waitForTimeout(250)

    const destinationLeaf = panel.locator('[data-preview-leaf="pane-1"]')
    const sourceLeafBox = await rootLeaf.boundingBox()
    const destinationLeafBox = await destinationLeaf.boundingBox()
    await expect(destinationLeaf.getByRole("tab", { name: "second.md" })).toHaveAttribute("aria-selected", "true")
    if (edge === "left") expect(destinationLeafBox?.x).toBeLessThan(sourceLeafBox!.x)
    if (edge === "top") expect(destinationLeafBox?.y).toBeLessThan(sourceLeafBox!.y)
    if (edge === "bottom") expect(destinationLeafBox?.y).toBeGreaterThan(sourceLeafBox!.y)
  })
}

test("clears the prospective pane preview when a Preview drag is cancelled", async ({ page }) => {
  await openPreview(page)
  await openPreviewFile(page, secondMarkdownFile)

  const panel = page.locator("#review-panel")
  const source = panel.getByRole("tab", { name: "second.md" })
  const leaf = panel.locator('[data-preview-leaf="root"]')
  const sourceBox = await source.boundingBox()
  const leafBox = await leaf.boundingBox()
  if (!sourceBox || !leafBox) throw new Error("Preview tab and leaf must be measurable before dragging")

  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(leafBox.x + leafBox.width - 2, leafBox.y + leafBox.height / 2, { steps: 8 })
  await expect(page.locator("[data-preview-tab-drag-proxy]")).toHaveCount(0)
  await expect(panel.locator('[data-preview-drop-preview="right"]')).toBeVisible()
  await page.mouse.move(leafBox.x - 20, leafBox.y + leafBox.height / 2, { steps: 4 })
  await expect(panel.locator("[data-preview-drop-preview]")).toHaveCount(0)
  await page.mouse.up()

  await expect(panel.locator("[data-preview-leaf]")).toHaveCount(1)
  await expect(leaf.getByRole("tab", { name: "second.md" })).toHaveAttribute("aria-selected", "true")
})

test("uses CSS overflow when nested Preview panes exceed the Work Column", async ({ page }) => {
  await openPreview(page)
  await openPreviewFile(page, secondMarkdownFile)

  const panel = page.locator("#review-panel")
  const source = panel.getByRole("tab", { name: "second.md" })
  const rootLeaf = panel.locator('[data-preview-leaf="root"]')
  const sourceBox = await source.boundingBox()
  const rootBox = await rootLeaf.boundingBox()
  if (!sourceBox || !rootBox) throw new Error("Preview tab and leaf must be measurable before splitting")

  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(rootBox.x + rootBox.width - 2, rootBox.y + rootBox.height / 2, { steps: 8 })
  await page.mouse.up()

  await openPreviewFile(page, "notes/third.md")
  const thirdTab = panel.locator('[data-preview-leaf="pane-1"]').getByRole("tab", { name: "third.md" })
  const secondLeaf = panel.locator('[data-preview-leaf="pane-1"]')
  const thirdBox = await thirdTab.boundingBox()
  const secondLeafBox = await secondLeaf.boundingBox()
  if (!thirdBox || !secondLeafBox) throw new Error("Nested Preview tab and leaf must be measurable before splitting")

  await page.mouse.move(thirdBox.x + thirdBox.width / 2, thirdBox.y + thirdBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(secondLeafBox.x + secondLeafBox.width - 2, secondLeafBox.y + secondLeafBox.height / 2, {
    steps: 8,
  })
  await page.mouse.up()

  const workspace = panel.locator("[data-preview-workspace]")
  await expect(workspace).toBeVisible()
  await expect.poll(() => workspace.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true)
  await workspace.evaluate((element) => {
    element.scrollLeft = element.scrollWidth
  })
  await expect.poll(() => workspace.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
})

test("isolates an outer surface-tab drag from Preview panes", async ({ page }) => {
  await openPreview(page)
  await openPreviewFile(page, secondMarkdownFile)

  const panel = page.locator("#review-panel")
  const source = panel.getByRole("tab", { name: "second.md" })
  const rootLeaf = panel.locator('[data-preview-leaf="root"]')
  const sourceBox = await source.boundingBox()
  const rootBox = await rootLeaf.boundingBox()
  if (!sourceBox || !rootBox) throw new Error("Preview tab and leaf must be measurable before splitting")

  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(rootBox.x + rootBox.width - 2, rootBox.y + rootBox.height / 2, { steps: 8 })
  await page.mouse.up()

  const movedHost = panel.locator('[data-preview-host="notes/second.md"]')
  const host = await movedHost.elementHandle()
  const outerPreview = panel.getByRole("tab", { name: "Preview", exact: true })
  const outerFiles = panel.getByRole("tab", { name: /^Files Changed/ })
  const previewBox = await outerPreview.boundingBox()
  const filesBox = await outerFiles.boundingBox()
  if (!host || !previewBox || !filesBox) throw new Error("Outer surface tabs must be measurable before dragging")

  await page.mouse.move(previewBox.x + previewBox.width / 2, previewBox.y + previewBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(filesBox.x + 12, filesBox.y + filesBox.height / 2, { steps: 8 })
  await page.mouse.up()

  await expect.poll(async () => (await outerPreview.boundingBox())?.x ?? Infinity).toBeLessThan(filesBox.x)
  await expect(panel.locator("[data-preview-leaf]")).toHaveCount(2)
  expect(await host.evaluate((element) => element.isConnected)).toBe(true)
})

test("keeps Home fixed while surface tabs are rearranged", async ({ page }) => {
  await openPreview(page)

  const panel = page.locator("#review-panel")
  const home = panel.getByRole("tab", { name: "Home", exact: true })
  const preview = panel.getByRole("tab", { name: "Preview", exact: true })
  const homeHandle = await home.elementHandle()
  const homeBox = await home.boundingBox()
  const previewBox = await preview.boundingBox()
  if (!homeHandle || !homeBox || !previewBox)
    throw new Error("Home and Preview surface tabs must be measurable before dragging")

  await page.mouse.move(homeBox.x + homeBox.width / 2, homeBox.y + homeBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(previewBox.x + previewBox.width / 2, previewBox.y + previewBox.height / 2, { steps: 8 })

  expect(await homeHandle.evaluate((element) => element.isConnected)).toBe(true)
  expect(await homeHandle.evaluate((element) => element.getBoundingClientRect().x)).toBe(homeBox.x)
  await page.mouse.up()
})

test("opens a later Preview file in the leaf the researcher focused", async ({ page }) => {
  await openPreview(page)
  await openPreviewFile(page, secondMarkdownFile)

  const panel = page.locator("#review-panel")
  const source = panel.getByRole("tab", { name: "second.md" })
  const rootLeaf = panel.locator('[data-preview-leaf="root"]')
  const sourceBox = await source.boundingBox()
  const rootBox = await rootLeaf.boundingBox()
  if (!sourceBox || !rootBox) throw new Error("Preview tab and leaf must be measurable before splitting")

  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(rootBox.x + rootBox.width - 2, rootBox.y + rootBox.height / 2, { steps: 8 })
  await page.mouse.up()

  await rootLeaf.getByRole("tab", { name: "baseline.md" }).click()
  await openPreviewFile(page, "notes/third.md")

  const secondLeaf = panel.locator('[data-preview-leaf="pane-1"]')
  await expect(rootLeaf.getByRole("tab", { name: "third.md" })).toHaveAttribute("aria-selected", "true")
  await expect(secondLeaf.getByRole("tab", { name: "third.md" })).toHaveCount(0)
  await expect(rootLeaf.getByText("The nested renderer stays alive.", { exact: true })).toBeVisible()
})

test("closing clean tabs selects the previous tab then the empty placeholder", async ({ page }) => {
  await openPreview(page)
  await openPreviewFile(page, secondMarkdownFile)

  const panel = page.locator("#review-panel")
  await panel.getByRole("button", { name: "Close second.md" }).click()
  await expect(panel.getByRole("tab", { name: "second.md" })).toHaveCount(0)
  await expect(panel.getByRole("tab", { name: "baseline.md" })).toHaveAttribute("aria-selected", "true")

  await panel.getByRole("button", { name: "Close baseline.md" }).click()
  await expect(panel.getByText("Select a file from the sidebar", { exact: true })).toBeVisible()
})

async function openPreview(page: Parameters<typeof mockOpenCodeServer>[0]) {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "preview-baseline-contract",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: { test: { id: "test", name: "Test", limit: { context: 200_000 } } },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "test" },
    },
    sessions: [
      {
        id: sessionID,
        slug: sessionID,
        projectID,
        directory,
        title,
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    fileContent: (path) => {
      if (path === markdownFile) return { type: "text", content: markdownContent }
      if (path === secondMarkdownFile) return { type: "text", content: secondMarkdownContent }
      if (path === juliaFile) return { type: "text", content: juliaContent }
      if (path === imageFile)
        return { type: "binary", content: imageContent, encoding: "base64", mimeType: "image/png" }
      if (path === pdfFile)
        return { type: "binary", content: pdfContent, encoding: "base64", mimeType: "application/pdf" }
      if (path === noTextPdfFile)
        return { type: "binary", content: noTextPdfContent, encoding: "base64", mimeType: "application/pdf" }
      if (path === partialTextPdfFile)
        return { type: "binary", content: partialTextPdfContent, encoding: "base64", mimeType: "application/pdf" }
      if (path === multipagePdfFile)
        return { type: "binary", content: multipagePdfContent, encoding: "base64", mimeType: "application/pdf" }
      if (path === invalidPdfFile)
        return { type: "binary", content: invalidPdfContent, encoding: "base64", mimeType: "application/pdf" }
      if (path === "notes/third.md")
        return { type: "text", content: "# Third Preview\n\nThe nested renderer stays alive." }
      if (path.startsWith("notes/capacity-")) return { type: "text", content: `# ${path}` }
      return undefined
    },
    pageMessages: () => ({ items: [] }),
  })

  await page.addInitScript(
    ({ directory, server, sessionID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:layout",
        JSON.stringify({ review: { diffStyle: "split", panelOpened: true } }),
      )
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify([{ type: "session", server, sessionId: sessionID }]),
      )
    },
    { directory, server, sessionID },
  )

  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, title)
  await openPreviewFile(page, markdownFile)
  await expect(page.getByText("The renderer must keep focus.", { exact: true })).toBeVisible()
}

async function openPreviewFile(page: Parameters<typeof mockOpenCodeServer>[0], path: string) {
  await page.evaluate((path) => {
    window.postMessage({ source: "amicode", kind: "preview-file", path }, "*")
  }, path)
  await expect(page.locator("#review-panel").getByRole("tab", { name: "Preview", exact: true })).toHaveAttribute(
    "data-selected",
    "",
  )
}

async function textStaysWithinPage(text: Locator, canvas: Locator): Promise<boolean> {
  const [textBox, canvasBox] = await Promise.all([text.boundingBox(), canvas.boundingBox()])
  if (!textBox || !canvasBox) return false
  const tolerance = 2
  return (
    textBox.x >= canvasBox.x - tolerance &&
    textBox.y >= canvasBox.y - tolerance &&
    textBox.x + textBox.width <= canvasBox.x + canvasBox.width + tolerance &&
    textBox.y + textBox.height <= canvasBox.y + canvasBox.height + tolerance
  )
}
