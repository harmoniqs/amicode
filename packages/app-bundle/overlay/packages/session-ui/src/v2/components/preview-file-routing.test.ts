import { describe, expect, test } from "bun:test"
import { isRenderable, RENDERABLE_EXTENSIONS } from "./markdown-utils"
import * as fs from "node:fs"
import * as path from "node:path"

/**
 * Tests for file-type routing, view-mode visibility, and file-type
 * classification (#925: "text" replaces "unsupported").
 */

// ---------------------------------------------------------------------------
// File type categorization for routing (#925: "text" catch-all)
// ---------------------------------------------------------------------------

type FileCategory = "markdown" | "image" | "pdf" | "text"

function getFileCategory(path: string): FileCategory {
  const dot = path.lastIndexOf(".")
  if (dot <= 0) return "text" // extensionless → text
  const ext = path.slice(dot).toLowerCase()
  if ((RENDERABLE_EXTENSIONS.markdown as readonly string[]).includes(ext)) return "markdown"
  if ((RENDERABLE_EXTENSIONS.images as readonly string[]).includes(ext)) return "image"
  if ((RENDERABLE_EXTENSIONS.pdf as readonly string[]).includes(ext)) return "pdf"
  return "text"
}

function shouldShowModeToggle(path: string): boolean {
  return getFileCategory(path) === "markdown"
}

// ---------------------------------------------------------------------------
// File type signal — async classification after file.read() (#925, #934)
// ---------------------------------------------------------------------------

type FileType = "text" | "binary" | "error" | "too-large" | null

const MAX_FILE_SIZE = 1_000_000

/**
 * Classify a file.read() result. When the category is image/pdf and the server
 * returns "binary", this is a RENDERABLE binary — return "text" (the pass-through
 * signal) so the category-based renderer handles it.
 */
function classifyFileType(
  readResult: { type: string; content: string; length?: number; encoding?: string; mimeType?: string } | null,
  readError: boolean,
  category?: FileCategory,
): FileType {
  if (readError) return "error"
  if (!readResult) return null
  if (readResult.type !== "text") {
    // Image/PDF binaries are rendered by the category branch, not the binary guard
    if (category === "image" || category === "pdf") return "text"
    return "binary"
  }
  const size = readResult.length ?? readResult.content.length
  if (size > MAX_FILE_SIZE) return "too-large"
  return "text"
}

// ---------------------------------------------------------------------------
// File type routing
// ---------------------------------------------------------------------------

describe("getFileCategory", () => {
  test("classifies .md as markdown", () => {
    expect(getFileCategory("README.md")).toBe("markdown")
    expect(getFileCategory("docs/guide.md")).toBe("markdown")
  })

  test("classifies .markdown as markdown", () => {
    expect(getFileCategory("notes.markdown")).toBe("markdown")
  })

  test("classifies image extensions as image", () => {
    expect(getFileCategory("photo.png")).toBe("image")
    expect(getFileCategory("logo.jpg")).toBe("image")
    expect(getFileCategory("icon.jpeg")).toBe("image")
    expect(getFileCategory("anim.gif")).toBe("image")
    expect(getFileCategory("vector.svg")).toBe("image")
    expect(getFileCategory("modern.webp")).toBe("image")
    expect(getFileCategory("favicon.ico")).toBe("image")
    expect(getFileCategory("bitmap.bmp")).toBe("image")
  })

  test("classifies .pdf as pdf", () => {
    expect(getFileCategory("paper.pdf")).toBe("pdf")
  })

  test("classifies code/config extensions as text", () => {
    expect(getFileCategory("app.ts")).toBe("text")
    expect(getFileCategory("style.css")).toBe("text")
    expect(getFileCategory("data.json")).toBe("text")
    expect(getFileCategory("script.py")).toBe("text")
    expect(getFileCategory("page.html")).toBe("text")
  })

  test("classifies extensionless files as text", () => {
    expect(getFileCategory("Makefile")).toBe("text")
    expect(getFileCategory("Dockerfile")).toBe("text")
    expect(getFileCategory("LICENSE")).toBe("text")
    expect(getFileCategory("src/Makefile")).toBe("text")
  })

  test("case-insensitive", () => {
    expect(getFileCategory("FILE.MD")).toBe("markdown")
    expect(getFileCategory("IMAGE.PNG")).toBe("image")
    expect(getFileCategory("DOC.PDF")).toBe("pdf")
  })
})

// ---------------------------------------------------------------------------
// Mode toggle visibility
// ---------------------------------------------------------------------------

describe("shouldShowModeToggle", () => {
  test("shows for markdown files", () => {
    expect(shouldShowModeToggle("README.md")).toBe(true)
    expect(shouldShowModeToggle("notes.markdown")).toBe(true)
  })

  test("hides for image files", () => {
    expect(shouldShowModeToggle("photo.png")).toBe(false)
    expect(shouldShowModeToggle("logo.jpg")).toBe(false)
  })

  test("hides for PDF files", () => {
    expect(shouldShowModeToggle("paper.pdf")).toBe(false)
  })

  test("hides for text files", () => {
    expect(shouldShowModeToggle("app.ts")).toBe(false)
    expect(shouldShowModeToggle("Makefile")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// File type signal — classifyFileType (#925)
// ---------------------------------------------------------------------------

describe("classifyFileType", () => {
  test("returns null when no result yet (loading)", () => {
    expect(classifyFileType(null, false)).toBeNull()
  })

  test("returns 'text' for normal text content under 1 MB", () => {
    expect(classifyFileType({ type: "text", content: "hello world", length: 11 }, false)).toBe("text")
  })

  test("returns 'text' when length field is absent (uses content.length)", () => {
    expect(classifyFileType({ type: "text", content: "short" }, false)).toBe("text")
  })

  test("returns 'binary' when type is not text (generic file)", () => {
    expect(classifyFileType({ type: "binary", content: "" }, false)).toBe("binary")
    expect(classifyFileType({ type: "base64", content: "AA==" }, false)).toBe("binary")
  })

  test("returns 'error' when read failed", () => {
    expect(classifyFileType(null, true)).toBe("error")
    // error takes precedence even if a result is somehow present
    expect(classifyFileType({ type: "text", content: "" }, true)).toBe("error")
  })

  test("returns 'too-large' for text content over 1 MB", () => {
    expect(classifyFileType({ type: "text", content: "", length: 1_000_001 }, false)).toBe("too-large")
  })

  test("returns 'text' for text content at exactly 1 MB", () => {
    expect(classifyFileType({ type: "text", content: "", length: 1_000_000 }, false)).toBe("text")
  })

  test("returns 'text' (not 'binary') for image binary — renderable (#934)", () => {
    const result = { type: "binary", content: "iVBOR...", encoding: "base64", mimeType: "image/png" }
    expect(classifyFileType(result, false, "image")).toBe("text")
  })

  test("returns 'text' (not 'binary') for PDF binary — renderable (#934)", () => {
    const result = { type: "binary", content: "JVBER...", encoding: "base64", mimeType: "application/pdf" }
    expect(classifyFileType(result, false, "pdf")).toBe("text")
  })

  test("still returns 'binary' for non-renderable binary even with category", () => {
    const result = { type: "binary", content: "", encoding: "base64", mimeType: "application/octet-stream" }
    expect(classifyFileType(result, false, "text")).toBe("binary")
  })

  test("error still takes precedence over renderable category", () => {
    expect(classifyFileType(null, true, "image")).toBe("error")
  })
})

// ---------------------------------------------------------------------------
// No-project fallback: isRenderable filters touchedFiles (unchanged)
// ---------------------------------------------------------------------------

describe("no-project fallback filtering", () => {
  test("filters touchedFiles to renderable only", () => {
    const touched = [
      "README.md",
      "src/app.ts",
      "docs/diagram.png",
      "style.css",
      "paper.pdf",
    ]
    const renderable = touched.filter(isRenderable)
    expect(renderable).toEqual(["README.md", "docs/diagram.png", "paper.pdf"])
  })

  test("handles empty touchedFiles", () => {
    const renderable = ([] as string[]).filter(isRenderable)
    expect(renderable).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Toolbar layout structural assertions (#934)
// ---------------------------------------------------------------------------

describe("toolbar layout (#934)", () => {
  const previewTabSrc = fs.readFileSync(
    path.resolve(__dirname, "../../../../app/src/components/session/session-preview-tab.tsx"),
    "utf8",
  )
  const fileViewSrc = fs.readFileSync(
    path.resolve(__dirname, "../../../../app/src/components/session/preview-file-view.tsx"),
    "utf8",
  )
  const previewTreeSrc = fs.readFileSync(
    path.resolve(__dirname, "../../../../app/src/components/session/session-preview-tree.ts"),
    "utf8",
  )
  const pdfCanvasViewSrc = fs.readFileSync(
    path.resolve(__dirname, "../../../../app/src/components/session/pdf-canvas-view.tsx"),
    "utf8",
  )

  test("zoom controls live in PreviewFileView, not SessionPreviewTab", () => {
    // SessionPreviewTab must NOT render the zoom buttons/input (aria-label)
    expect(previewTabSrc).not.toContain("Zoom out")
    expect(previewTabSrc).not.toContain("Zoom in")
    // It routes the pane-local zoom accessor to each renderer host.
    expect(previewTabSrc).toContain("zoom={() => zoomForPath(path)}")

    // PreviewFileView MUST render the zoom widget
    expect(fileViewSrc).toContain("Zoom out")
    expect(fileViewSrc).toContain("Zoom in")
  })

  test("unsaved dot lives in SessionPreviewTab next to filename", () => {
    // The parent should render the unsaved dot (aria-label pattern)
    expect(previewTabSrc).toMatch(/aria-label.*[Uu]nsaved/)

    // PreviewFileView should NOT render the save dot anymore
    expect(fileViewSrc).not.toMatch(/aria-label.*Sav(ing|ed)"/)
  })

  test("PreviewFileView accepts onSaveStatusChange prop", () => {
    expect(fileViewSrc).toContain("onSaveStatusChange")
  })

  test("SessionPreviewTab passes zoomIn and zoomOut to PreviewFileView", () => {
    expect(previewTabSrc).toContain("zoomIn={(maximum) => setZoomForPath(path, zoomForPath(path) + 10, maximum)}")
    expect(previewTabSrc).toContain("zoomOut={() => setZoomForPath(path, zoomForPath(path) - 10)}")
  })

  test("image zoom uses direct CSS sizing, not transform: scale (#934)", () => {
    // Extract the image Match block (from category() === "image" to its closing </Match>)
    const imageMatchStart = fileViewSrc.indexOf('category() === "image"')
    const imageMatchEnd = fileViewSrc.indexOf("</Match>", imageMatchStart)
    const imageBlock = fileViewSrc.slice(imageMatchStart, imageMatchEnd)

    // Must NOT use transform: scale on the image wrapper
    expect(imageBlock).not.toContain("transform:")
    expect(imageBlock).not.toContain("origin-top-left")
  })

  test("image element overrides Tailwind preflight max-width and flex-shrink (#934)", () => {
    const imageMatchStart = fileViewSrc.indexOf('category() === "image"')
    const imageMatchEnd = fileViewSrc.indexOf("</Match>", imageMatchStart)
    const imageBlock = fileViewSrc.slice(imageMatchStart, imageMatchEnd)

    // base.css sets max-width: 100% on all img — max-w-none defeats it
    expect(imageBlock).toContain("max-w-none")
    // flex parent would shrink the img back — shrink-0 prevents it
    expect(imageBlock).toContain("shrink-0")
  })

  test("image/PDF wrappers use safe centering for full scroll reach (#934)", () => {
    // When a flex container centers a child that overflows, the negative
    // (left/top) overflow is clipped and unreachable via scroll. The fix is
    // inline-flex + min-w-full: the wrapper's width = max(content, container),
    // so centering happens inside a box that covers the full scroll area.
    const imageMatchStart = fileViewSrc.indexOf('category() === "image"')
    const imageMatchEnd = fileViewSrc.indexOf("</Match>", imageMatchStart)
    const imageBlock = fileViewSrc.slice(imageMatchStart, imageMatchEnd)

    // Image wrapper must use inline-flex + min-w-full for safe centering
    expect(imageBlock).toContain("inline-flex")
    expect(imageBlock).toContain("min-w-full")
    expect(imageBlock).toContain("min-h-full")

    // PDF wrapper (in PdfCanvasView) must use the same pattern
    expect(pdfCanvasViewSrc).toContain("inline-flex")
    expect(pdfCanvasViewSrc).toContain("min-w-full")
    expect(pdfCanvasViewSrc).toContain("min-h-full")
  })

  test("image uses absolute pixel width from measured container, not percentage (#934)", () => {
    // The root cause of the left-scroll clipping bug: `width: ${zoom}%` inside
    // an inline-flex wrapper creates a circular CSS dependency. The inline-flex
    // wrapper sizes from the image's intrinsic (natural) dimensions, then the
    // percentage resolves to a LARGER value, overflowing the wrapper. justify-center
    // pushes the left overflow into unreachable negative scroll territory.
    //
    // Fix: measure container width via ResizeObserver (like PDF does) and compute
    // absolute pixel widths. The wrapper then sizes correctly around the content.

    // Must track container width with a signal, same pattern as PdfCanvasView
    expect(fileViewSrc).toContain("containerWidth")
    expect(fileViewSrc).toContain("ResizeObserver")

    // Image width must be computed as absolute pixels, NOT a zoom percentage.
    // Look for the pixel-based width pattern in the image block:
    const imageMatchStart = fileViewSrc.indexOf('category() === "image"')
    const imageMatchEnd = fileViewSrc.indexOf("</Match>", imageMatchStart)
    const imageBlock = fileViewSrc.slice(imageMatchStart, imageMatchEnd)

    // Must use pixel width (e.g. `${imageWidth()}px`), not percentage
    expect(imageBlock).toContain("px")
    // Must NOT use `zoom()` directly as a percentage on the image
    expect(imageBlock).not.toMatch(/width:.*zoom\(\).*%/)
  })

  test("PDF renders via canvas (PDF.js), not iframe/embed/placeholder (#934)", () => {
    const pdfMatchStart = fileViewSrc.indexOf('category() === "pdf"')
    const pdfMatchEnd = fileViewSrc.indexOf("</Match>", pdfMatchStart)
    const pdfBlock = fileViewSrc.slice(pdfMatchStart, pdfMatchEnd)

    // Must NOT use iframe/embed (Chromium PDF viewer unavailable in VS Code webviews)
    expect(pdfBlock).not.toContain("<iframe")
    expect(pdfBlock).not.toContain("<embed")
    // Must NOT show a "not available" placeholder
    expect(pdfBlock).not.toContain("not available")
    // Must render using a canvas-based PDF renderer
    expect(pdfBlock).toContain("PdfCanvasView")
  })

  test("PDF.js is imported with worker injected on globalThis (no Worker created)", () => {
    // pdfjs-dist must be imported in the canvas renderer
    expect(pdfCanvasViewSrc).toContain("pdfjs-dist")
    // Worker module imported and injected on globalThis — the one code path in
    // pdfjs-dist v6 that bypasses both new Worker() and the workerSrc getter.
    expect(pdfCanvasViewSrc).toContain("pdf.worker")
    expect(pdfCanvasViewSrc).toContain("globalThis.pdfjsWorker")
  })

  test("PDF keeps open-in-editor as secondary action", () => {
    // The open-in-editor action lives inside PdfCanvasView
    expect(pdfCanvasViewSrc).toContain("open-file")
    expect(pdfCanvasViewSrc).toContain("Open in editor")
  })

  test("PDF pages fit container width at 100% zoom, not intrinsic PDF size (#934)", () => {
    // Must track container width via ResizeObserver for responsive fit-to-width
    expect(pdfCanvasViewSrc).toContain("ResizeObserver")
    // Must observe the PARENT (scroll container), not the wrapper — observing the
    // wrapper creates a feedback loop (pages resize wrapper → observer fires →
    // containerWidth changes → pages re-render → wrapper resizes → ...)
    expect(pdfCanvasViewSrc).toContain("parentElement")
    // Must compute a base scale from container width / intrinsic page width
    // (getViewport at scale=1 gives intrinsic size, then divide container into it)
    expect(pdfCanvasViewSrc).toContain("containerWidth")
    expect(pdfCanvasViewSrc).toContain("getViewport({ scale: 1 })")
  })

  test("zoom floor is category-aware: 100% for image/pdf, 50% for markdown/text (#934)", () => {
    // The parent routes existing renderer controls to the owning leaf pane.
    expect(previewTabSrc).toContain("setZoomForPath")
    // PreviewFileView applies a higher floor for image/pdf in its zoom-out handler
    expect(fileViewSrc).toContain("zoomFloor")
  })

  test("pinch/wheel zoom: SessionPreviewTab exposes onZoomChange to PreviewFileView (#934)", () => {
    // Parent must define a handler that accepts an arbitrary zoom value
    expect(previewTabSrc).toContain("onZoomChange")
    // The leaf model clamps to the renderer's category-specific maximum.
    expect(previewTreeSrc).toContain("Math.min(Math.max(zoom, 50), Math.min(Math.max(maximum, 50), 1000))")
  })

  test("pinch/wheel zoom: PreviewFileView has a wheel handler for ctrlKey/shiftKey (#934)", () => {
    // Must accept onZoomChange prop
    expect(fileViewSrc).toContain("onZoomChange")
    // Wheel handler must check ctrlKey (trackpad pinch) and shiftKey (shift+scroll)
    expect(fileViewSrc).toContain("ctrlKey")
    expect(fileViewSrc).toContain("shiftKey")
    // Must use addEventListener with passive: false (Solid's onWheel is passive by default)
    expect(fileViewSrc).toContain("passive")
    // Must use exponential scaling for smooth zoom (not linear steps)
    expect(fileViewSrc).toContain("Math.exp")
  })

  test("zoom anchors to viewport center, not top-left (#934)", () => {
    // Must have a scroll-adjustment helper that keeps the viewport center
    // stable after a zoom change (adjusts scrollLeft/scrollTop by the ratio)
    expect(fileViewSrc).toContain("adjustScrollForZoom")
    // Must compute the center point from scrollLeft + clientWidth/2
    expect(fileViewSrc).toContain("clientWidth")
    expect(fileViewSrc).toContain("clientHeight")
    // Must use rAF so the DOM (image CSS + PDF canvas microtask) updates first
    expect(fileViewSrc).toContain("requestAnimationFrame")
  })

})

// ---------------------------------------------------------------------------
// Editor zoom — CM6 font-size scaling (#937)
// ---------------------------------------------------------------------------

describe("editor zoom via CM6 font-size (#937)", () => {
  const editorSrc = fs.readFileSync(
    path.resolve(__dirname, "preview-editor.tsx"),
    "utf8",
  )
  const fileViewSrc = fs.readFileSync(
    path.resolve(__dirname, "../../../../app/src/components/session/preview-file-view.tsx"),
    "utf8",
  )

  test("PreviewEditor accepts a zoom prop", () => {
    // The props type must include zoom as an optional accessor
    expect(editorSrc).toMatch(/zoom\??\s*:\s*\(\)\s*=>\s*number/)
  })

  test("PreviewEditor uses a Compartment for zoom font-size reconfiguration", () => {
    // Must create a Compartment for the zoom theme (separate from editable)
    expect(editorSrc).toContain("zoomCompartment")
    expect(editorSrc).toContain("Compartment")
  })

  test("PreviewEditor applies fontSize derived from zoom", () => {
    // The zoom theme must set fontSize as a function of the zoom value
    expect(editorSrc).toContain("fontSize")
    // Must reference zoom in the font-size computation
    expect(editorSrc).toMatch(/fontSize.*zoom|zoom.*fontSize/)
  })

  test("PreviewEditor reactively reconfigures zoom on prop change", () => {
    // Must dispatch a reconfigure effect when zoom changes
    expect(editorSrc).toContain("reconfigure")
  })

  test("PreviewEditor call sites do NOT pass zoom prop (zoom disabled in edit mode)", () => {
    // Markdown edit mode (inside the <Match when=... "markdown"> block)
    const mdMatchTag = 'Match when={category() === "markdown"}'
    const mdStart = fileViewSrc.indexOf(mdMatchTag)
    const mdEnd = fileViewSrc.indexOf("</Match>", mdStart)
    const markdownMatch = fileViewSrc.slice(mdStart, mdEnd)
    expect(markdownMatch).not.toContain("zoom={")

    // Text/code file rendering
    const txtMatchTag = 'Match when={category() === "text"}'
    const txtStart = fileViewSrc.indexOf(txtMatchTag)
    const txtEnd = fileViewSrc.indexOf("</Match>", txtStart)
    const textMatch = fileViewSrc.slice(txtStart, txtEnd)
    expect(textMatch).not.toContain("zoom={")
  })
})

// ---------------------------------------------------------------------------
// Zoom layout redesign — editable input + reset + vertical stepper (#937)
// ---------------------------------------------------------------------------

describe("zoom layout redesign (#937)", () => {
  const fileViewSrc = fs.readFileSync(
    path.resolve(__dirname, "../../../../app/src/components/session/preview-file-view.tsx"),
    "utf8",
  )

  test("zoom input is editable (not readOnly)", () => {
    // Extract the zoom controls section
    const zoomSection = fileViewSrc.slice(
      fileViewSrc.indexOf("Zoom out"),
      fileViewSrc.indexOf("</div>", fileViewSrc.lastIndexOf("Zoom in")) + 10,
    )
    // The zoom input must NOT be readOnly
    expect(zoomSection).not.toContain("readOnly")
  })

  test("zoom input commits value via onZoomChange", () => {
    // Must call onZoomChange when the user enters a value
    expect(fileViewSrc).toContain("onZoomChange")
  })

  test("zoom input does NOT fire onZoomChange on every keystroke (no onInput handler)", () => {
    // Extract the <input> element block for the zoom percentage
    const inputStart = fileViewSrc.indexOf("Editable zoom percentage input")
    const inputEnd = fileViewSrc.indexOf("/>", inputStart)
    const inputBlock = fileViewSrc.slice(inputStart, inputEnd)
    // Must NOT have an onInput handler — zoom commits on blur/Enter only
    expect(inputBlock).not.toContain("onInput")
  })

  test("zoom input commits on blur with category-aware clamping", () => {
    const inputStart = fileViewSrc.indexOf("Editable zoom percentage input")
    const inputEnd = fileViewSrc.indexOf("/>", inputStart)
    const inputBlock = fileViewSrc.slice(inputStart, inputEnd)
    // The onBlur handler must parse, clamp, and apply
    expect(inputBlock).toContain("onBlur")
    // Must clamp the parsed value to the valid range
    expect(inputBlock).toContain("zoomFloor()")
    expect(inputBlock).toContain("zoomCeiling()")
    expect(inputBlock).toContain("Math.min")
    expect(inputBlock).toContain("Math.max")
  })

  test("zoom input supports Escape to revert without committing", () => {
    const inputStart = fileViewSrc.indexOf("Editable zoom percentage input")
    const inputEnd = fileViewSrc.indexOf("/>", inputStart)
    const inputBlock = fileViewSrc.slice(inputStart, inputEnd)
    expect(inputBlock).toContain("Escape")
  })

  test("has a reset-to-100% button", () => {
    expect(fileViewSrc).toContain('aria-label="Reset zoom"')
  })

  test("+/- stepper is vertical (flex-col)", () => {
    // The stepper container must use flex-col for vertical stacking
    // Find the region between "Zoom in" and "Zoom out" buttons
    const zoomInIdx = fileViewSrc.indexOf('"Zoom in"')
    const zoomOutIdx = fileViewSrc.indexOf('"Zoom out"')
    // Their shared container must use flex-col — search 500 chars back
    // to include the parent div
    const start = Math.max(0, Math.min(zoomInIdx, zoomOutIdx) - 500)
    const end = Math.max(zoomInIdx, zoomOutIdx) + 100
    const stepperRegion = fileViewSrc.slice(start, end)
    expect(stepperRegion).toContain("flex-col")
  })
})

// ---------------------------------------------------------------------------
// Preview tab: floating overlay controls (#937)
// ---------------------------------------------------------------------------

describe("preview tab: floating overlay controls (#937)", () => {
  const fileViewSrc = fs.readFileSync(
    path.resolve(__dirname, "../../../../app/src/components/session/preview-file-view.tsx"),
    "utf8",
  )

  test("no action bar exists (removed entirely)", () => {
    // The old action bar had border-border-weaker-base + py-1 — must be gone
    expect(fileViewSrc).not.toContain("border-border-weaker-base")
  })

  test("floating controls container with absolute positioning", () => {
    // A single container holds both controls, positioned top-right
    expect(fileViewSrc).toContain("Floating controls")
    const ctrlIdx = fileViewSrc.indexOf("Floating controls")
    const ctrlBlock = fileViewSrc.slice(ctrlIdx, ctrlIdx + 500)
    expect(ctrlBlock).toContain("absolute")
    expect(ctrlBlock).toContain("right")
    expect(ctrlBlock).toContain("z-index")
  })

  test("zoom pill inside Show gated on !isEditing()", () => {
    // Zoom pill disappears entirely in edit mode (DOM-removed, not opacity-gated)
    expect(fileViewSrc).toMatch(/Show when=\{!isEditing\(\)\}/)
  })

  test("mode toggle inside Show gated on showModeToggle()", () => {
    expect(fileViewSrc).toMatch(/Show when=\{showModeToggle\(\)\}/)
  })

  test("mode toggle appears before the zoom pill in the flex container", () => {
    const ctrlIdx = fileViewSrc.indexOf("Floating controls")
    const afterCtrl = fileViewSrc.slice(ctrlIdx)
    const zoomIdx = afterCtrl.indexOf("!isEditing()")
    const toggleIdx = afterCtrl.indexOf("showModeToggle()")
    expect(toggleIdx).toBeLessThan(zoomIdx)
  })

  test("showControls signal + 2s idle timer", () => {
    expect(fileViewSrc).toContain("showControls")
    expect(fileViewSrc).toContain("setShowControls")
    expect(fileViewSrc).toMatch(/2000/)
  })

  test("controls container opacity driven by showControls signal", () => {
    const ctrlIdx = fileViewSrc.indexOf("Floating controls")
    const ctrlBlock = fileViewSrc.slice(ctrlIdx, ctrlIdx + 800)
    expect(ctrlBlock).toContain("showControls()")
    expect(ctrlBlock).toContain("opacity")
    expect(ctrlBlock).toContain("transition")
  })

  test("relative wrapper has mouse event handlers for show/hide", () => {
    expect(fileViewSrc).toContain("onMouseEnter")
    expect(fileViewSrc).toContain("onMouseMove")
    expect(fileViewSrc).toContain("onMouseLeave")
  })

  test("controls stay visible while hovering (pause idle timer)", () => {
    const ctrlIdx = fileViewSrc.indexOf("Floating controls")
    const ctrlBlock = fileViewSrc.slice(ctrlIdx, ctrlIdx + 500)
    expect(ctrlBlock).toContain("onMouseEnter")
    expect(ctrlBlock).toContain("onMouseLeave")
  })

  test("pinch/wheel zoom reveals controls", () => {
    const wheelIdx = fileViewSrc.indexOf("handleWheelZoom")
    const wheelBlock = fileViewSrc.slice(wheelIdx, wheelIdx + 1000)
    expect(wheelBlock).toContain("setShowControls(true)")
    expect(wheelBlock).toContain("startIdleTimer")
  })

  test("isEditing signal exists with correct category logic", () => {
    expect(fileViewSrc).toContain("isEditing")
    expect(fileViewSrc).toMatch(/category\(\)[\s\S]*markdown[\s\S]*mode.*edit|mode.*edit[\s\S]*markdown/)
    expect(fileViewSrc).toMatch(/return true/)
  })

  test("PreviewEditor call sites do not pass zoom prop", () => {
    const editorInstances = fileViewSrc.split("<PreviewEditor").slice(1)
    expect(editorInstances.length).toBeGreaterThanOrEqual(2)
    for (const instance of editorInstances) {
      const closingTag = instance.indexOf("/>")
      const propsBlock = instance.slice(0, closingTag)
      expect(propsBlock).not.toContain("zoom={")
    }
  })
})

// ---------------------------------------------------------------------------
// Dirty dot indicator — VS Code style (#937)
// ---------------------------------------------------------------------------

describe("dirty dot indicator (#937)", () => {
  const previewTabSrc = fs.readFileSync(
    path.resolve(__dirname, "../../../../app/src/components/session/session-preview-tab.tsx"),
    "utf8",
  )

  test("shows an unsaved dot based on workspace dirty state", () => {
    // The workspace owns only a dirty flag; PreviewFileView owns draft text.
    expect(previewTabSrc).toContain("dirtyPaths")
  })

  test("unsaved dot has aria-label for accessibility", () => {
    expect(previewTabSrc).toMatch(/aria-label.*[Uu]nsaved/)
  })

  test("does not show transient saving/saved status dots", () => {
    // The old saving spinner and saved green dot should be removed
    expect(previewTabSrc).not.toMatch(/aria-label="Saving"/)
    expect(previewTabSrc).not.toMatch(/aria-label="Saved"/)
  })
})

// ---------------------------------------------------------------------------
// File save uses SDK client, not raw fetch (#937)
// ---------------------------------------------------------------------------

describe("file save uses SDK client (#937)", () => {
  const fileViewSrc = fs.readFileSync(
    path.resolve(__dirname, "../../../../app/src/components/session/preview-file-view.tsx"),
    "utf8",
  )

  // Extract the saveFile function body
  const saveFileStart = fileViewSrc.indexOf("const saveFile =")
  const saveFileBody = (() => {
    // Find the matching closing brace by counting braces from the opening {
    let depth = 0
    let started = false
    for (let i = saveFileStart; i < fileViewSrc.length; i++) {
      if (fileViewSrc[i] === "{") { depth++; started = true }
      if (fileViewSrc[i] === "}") { depth-- }
      if (started && depth === 0) return fileViewSrc.slice(saveFileStart, i + 1)
    }
    return ""
  })()

  // Extract the onCleanup block
  const cleanupStart = fileViewSrc.indexOf("Flush pending save on navigation away")
  const cleanupEnd = fileViewSrc.indexOf("savedTimer) clearTimeout(savedTimer)", cleanupStart)
  const cleanupBlock = fileViewSrc.slice(cleanupStart, cleanupEnd + 50)

  test("saveFile uses SDK client.file.write, not raw fetch to /file/write", () => {
    expect(saveFileBody).toContain("file.write")
    expect(saveFileBody).not.toContain('fetch(new URL("/file/write"')
  })

  test("no autosave flush on cleanup (save is explicit only)", () => {
    // With no debounced autosave, there should be no flush-on-cleanup
    // writing unsaved content to disk
    expect(fileViewSrc).not.toContain("Flush pending save on navigation away")
  })

  test("clears unsavedContent after successful save", () => {
    // After a successful write, the dirty state must be cleared (null)
    expect(saveFileBody).toContain("setUnsavedContent(null)")
  })

  test("saveFile uses try/catch for error handling", () => {
    // The SDK throws on non-2xx — must use try/catch, not bare .then()
    expect(saveFileBody).toContain("try")
    expect(saveFileBody).toContain("catch")
    // Should NOT use .then() on the SDK call (that's the raw-fetch pattern)
    expect(saveFileBody).not.toContain(".then(")
  })
})

// ---------------------------------------------------------------------------
// Dirty dot uses valid v2 color tokens (#937)
// ---------------------------------------------------------------------------

describe("dirty dot uses valid v2 color tokens (#937)", () => {
  const previewTabSrc = fs.readFileSync(
    path.resolve(__dirname, "../../../../app/src/components/session/session-preview-tab.tsx"),
    "utf8",
  )

  test("unsaved dot uses a v2-prefixed background color", () => {
    // The aria-label and its visual class may span adjacent lines.
    const dotStart = previewTabSrc.indexOf('aria-label="Unsaved changes"')
    expect(dotStart).toBeGreaterThan(-1)
    const dotBlock = previewTabSrc.slice(dotStart, dotStart + 160)
    // Must use bg-v2-* (the valid v2 design system token), not bare bg-text-faint
    expect(dotBlock).toMatch(/bg-v2-/)
    expect(dotBlock).not.toMatch(/bg-text-faint[^-]|bg-text-faint"/)
  })

  test("empty-state icon uses a v2-prefixed text color", () => {
    // The open-file icon in the empty state should use a valid v2 color token
    const iconLine = previewTabSrc.split("\n").find((l) => l.includes("open-file"))
    expect(iconLine).toBeDefined()
    // Must NOT use bare text-text-faint (without v2- prefix)
    expect(iconLine).not.toMatch(/(?<!v2-)text-text-faint/)
  })
})

// ---------------------------------------------------------------------------
// File content handler must NOT trim text (#937)
// ---------------------------------------------------------------------------

describe("file content handler does not trim text (#937)", () => {
  const handlerSrc = fs.readFileSync(
    path.resolve(
      __dirname,
      "../../../../opencode/src/server/routes/instance/httpapi/handlers/file.ts",
    ),
    "utf8",
  )

  test("text content returned from absolute-path branch is not trimmed", () => {
    // Find the absolute-path branch: "Read directly from disk for absolute paths"
    const absStart = handlerSrc.indexOf("Read directly from disk for absolute paths")
    const absEnd = handlerSrc.indexOf("} catch", absStart)
    const absBlock = handlerSrc.slice(absStart, absEnd)
    expect(absBlock).not.toContain(".trim()")
  })

  test("text content returned from in-workspace branch is not trimmed", () => {
    // Find the in-workspace branch: text.value used in the return
    // The return statement with type: "text" after Option.isSome(text)
    const isSomeIdx = handlerSrc.indexOf("Option.isSome(text)")
    const returnBlock = handlerSrc.slice(isSomeIdx, isSomeIdx + 200)
    expect(returnBlock).not.toContain(".trim()")
  })
})

// ---------------------------------------------------------------------------
// No autosave — save only on explicit Cmd+S (#937)
// ---------------------------------------------------------------------------

describe("no autosave — save only on Cmd+S (#937)", () => {
  const fileViewSrc = fs.readFileSync(
    path.resolve(__dirname, "../../../../app/src/components/session/preview-file-view.tsx"),
    "utf8",
  )

  // Extract the handleEdit function body
  const editStart = fileViewSrc.indexOf("const handleEdit =")
  const editBody = (() => {
    let depth = 0
    let started = false
    for (let i = editStart; i < fileViewSrc.length; i++) {
      if (fileViewSrc[i] === "{") { depth++; started = true }
      if (fileViewSrc[i] === "}") { depth-- }
      if (started && depth === 0) return fileViewSrc.slice(editStart, i + 1)
    }
    return ""
  })()

  test("handleEdit does NOT call debouncedSave or saveFile", () => {
    // Editing should only track dirty state, never trigger a save
    expect(editBody).not.toContain("debouncedSave")
    expect(editBody).not.toContain("saveFile")
  })

  test("no debouncedSave function exists", () => {
    expect(fileViewSrc).not.toContain("debouncedSave")
  })

  test("no saveTimer exists (no debounce infrastructure)", () => {
    expect(fileViewSrc).not.toMatch(/\bsaveTimer\b/)
  })

  test("handleImmediateSave still exists for Cmd+S", () => {
    expect(fileViewSrc).toContain("handleImmediateSave")
  })
})

// ---------------------------------------------------------------------------
// Files Changed tab: floating zoom overlay in preview mode (#937)
// ---------------------------------------------------------------------------

describe("files changed tab: floating zoom overlay in preview mode (#937)", () => {
  const reviewSrc = fs.readFileSync(
    path.resolve(__dirname, "./session-review-file-preview-v2.tsx"),
    "utf8",
  )

  test("zoom overlay appears only in markdown preview mode (isPreviewMd)", () => {
    // The zoom overlay must be gated by isPreviewMd()
    // Find a zoom-related block near isPreviewMd
    const zoomIdx = reviewSrc.indexOf('"Zoom in"')
    expect(zoomIdx).toBeGreaterThan(-1)
    // The zoom controls must be inside a Show gated on isPreviewMd
    const regionBefore = reviewSrc.slice(Math.max(0, zoomIdx - 5000), zoomIdx)
    expect(regionBefore).toContain("isPreviewMd()")
  })

  test("zoom overlay has absolute positioning (floating)", () => {
    // The zoom overlay container between isPreviewMd and the zoom buttons must
    // use absolute positioning to float over the content
    const previewStart = reviewSrc.indexOf("isPreviewMd()")
    const zoomIdx = reviewSrc.indexOf('"Zoom in"')
    const overlayRegion = reviewSrc.slice(previewStart, zoomIdx)
    expect(overlayRegion).toContain('"absolute"')
    expect(overlayRegion).toContain('"z-index"')
  })

  test("zoom state is managed locally (createSignal for zoom)", () => {
    expect(reviewSrc).toMatch(/createSignal\(100\)/)
  })

  test("markdown preview applies zoom transform", () => {
    // The markdown preview div should have a scale transform
    const mdPreviewIdx = reviewSrc.indexOf("session-review-v2-markdown-preview")
    expect(mdPreviewIdx).toBeGreaterThan(-1)
    const mdPreviewBlock = reviewSrc.slice(mdPreviewIdx, mdPreviewIdx + 500)
    expect(mdPreviewBlock).toMatch(/scale|zoom/)
  })
})

// ---------------------------------------------------------------------------
// Files Changed tab: auto-hide zoom pill on idle (#937)
// ---------------------------------------------------------------------------

describe("files changed tab: auto-hide zoom pill on idle (#937)", () => {
  const reviewSrc = fs.readFileSync(
    path.resolve(__dirname, "./session-review-file-preview-v2.tsx"),
    "utf8",
  )

  test("showZoomPill signal controls visibility", () => {
    expect(reviewSrc).toContain("showZoomPill")
    expect(reviewSrc).toContain("setShowZoomPill")
  })

  test("pill opacity is driven by showZoomPill signal", () => {
    // The overlay div should use showZoomPill() to control opacity
    const overlayStart = reviewSrc.indexOf("Floating zoom overlay")
    const overlayBlock = reviewSrc.slice(overlayStart, overlayStart + 1500)
    expect(overlayBlock).toContain("showZoomPill()")
    expect(overlayBlock).toContain("opacity")
    expect(overlayBlock).toContain("transition")
  })

  test("preview wrapper has mouse event handlers for show/hide", () => {
    // The relative wrapper around the markdown preview must handle
    // mouseenter, mousemove, and mouseleave
    const wrapperStart = reviewSrc.indexOf('position: "relative", height: "100%"')
    const wrapperBlock = reviewSrc.slice(wrapperStart, wrapperStart + 300)
    expect(wrapperBlock).toContain("onMouseEnter")
    expect(wrapperBlock).toContain("onMouseMove")
    expect(wrapperBlock).toContain("onMouseLeave")
  })

  test("idle timer is 2 seconds", () => {
    // The idle timeout should be 2000ms
    expect(reviewSrc).toMatch(/2000/)
  })

  test("pill stays visible while hovering over it (pause idle timer)", () => {
    // The pill container must have its own mouseenter/mouseleave
    // to pause/resume the idle timer
    const overlayStart = reviewSrc.indexOf("Floating zoom overlay")
    const overlayBlock = reviewSrc.slice(overlayStart, overlayStart + 300)
    expect(overlayBlock).toContain("onMouseEnter")
    expect(overlayBlock).toContain("onMouseLeave")
  })

  test("pill starts visible initially (true default)", () => {
    // The signal should initialize to true so the pill shows on first render
    expect(reviewSrc).toMatch(/showZoomPill.*createSignal\(true\)|createSignal\(true\)[\s\S]*showZoomPill/)
  })
})

// ---------------------------------------------------------------------------
// Files Changed tab: pinch/wheel zoom in markdown preview (#937)
// ---------------------------------------------------------------------------

describe("files changed tab: pinch/wheel zoom in markdown preview (#937)", () => {
  const reviewSrc = fs.readFileSync(
    path.resolve(__dirname, "./session-review-file-preview-v2.tsx"),
    "utf8",
  )

  test("handleWheelZoom exists and checks ctrlKey/shiftKey", () => {
    expect(reviewSrc).toContain("handleWheelZoom")
    expect(reviewSrc).toContain("ctrlKey")
    expect(reviewSrc).toContain("shiftKey")
  })

  test("wheel listener attached with passive: false", () => {
    expect(reviewSrc).toMatch(/addEventListener\("wheel"/)
    expect(reviewSrc).toContain("passive: false")
  })

  test("wheel zoom reveals the pill and resets idle timer", () => {
    // The handler should show the pill during pinch gestures
    const handlerStart = reviewSrc.indexOf("handleWheelZoom")
    const handlerBlock = reviewSrc.slice(handlerStart, handlerStart + 600)
    expect(handlerBlock).toContain("setShowZoomPill(true)")
    expect(handlerBlock).toContain("startZoomIdleTimer")
  })

  test("wheel zoom calls onZoomChange with clamped value", () => {
    const handlerStart = reviewSrc.indexOf("handleWheelZoom")
    const handlerBlock = reviewSrc.slice(handlerStart, handlerStart + 600)
    expect(handlerBlock).toContain("onZoomChange")
    expect(handlerBlock).toContain("Math.min")
    expect(handlerBlock).toContain("Math.max")
  })
})
