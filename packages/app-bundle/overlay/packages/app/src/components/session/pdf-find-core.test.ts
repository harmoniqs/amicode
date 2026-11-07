import { describe, expect, test } from "bun:test"
import { buildPdfIndex, findMatches } from "./pdf-find-core"
import { isPdfFindTarget } from "./pdf-find-guard"

// ---------------------------------------------------------------------------
// DOM builders — mimic pdf.js's text-layer output
// ---------------------------------------------------------------------------

function textLayer(page: number, parts: Array<string | "br">): HTMLDivElement {
  const layer = document.createElement("div")
  layer.setAttribute("data-pdf-text-layer", "")
  layer.dataset.page = String(page)
  for (const part of parts) {
    if (part === "br") {
      layer.appendChild(document.createElement("br"))
      continue
    }
    const span = document.createElement("span")
    span.textContent = part
    layer.appendChild(span)
  }
  return layer
}

function pdfRoot(...layers: HTMLDivElement[]): HTMLElement {
  const root = document.createElement("div")
  for (const layer of layers) root.appendChild(layer)
  return root
}

// ---------------------------------------------------------------------------
// buildPdfIndex
// ---------------------------------------------------------------------------

describe("buildPdfIndex", () => {
  test("extracts plain text from a single page", () => {
    const root = pdfRoot(textLayer(1, ["hello world"]))
    const index = buildPdfIndex(root)
    expect(index.text).toBe("hello world")
    expect(index.hasText).toBe(true)
  })

  test("joins multiple pages into one string with a space between", () => {
    const root = pdfRoot(textLayer(1, ["page one"]), textLayer(2, ["page two"]))
    const index = buildPdfIndex(root)
    expect(index.text).toBe("page one page two")
  })

  test("collapses whitespace runs to a single space", () => {
    const root = pdfRoot(textLayer(1, ["hello   \t\n  world"]))
    const index = buildPdfIndex(root)
    expect(index.text).toBe("hello world")
  })

  test("a <br> is a line break — emits a space", () => {
    const root = pdfRoot(textLayer(1, ["line one", "br", "line two"]))
    const index = buildPdfIndex(root)
    expect(index.text).toBe("line one line two")
  })

  test("a line ending in - joins the next line WITHOUT the hyphen", () => {
    const root = pdfRoot(textLayer(1, ["trans-", "br", "port"]))
    const index = buildPdfIndex(root)
    expect(index.text).toBe("transport")
  })

  test("hyphen join: offsets after the removed hyphen still land on real text", () => {
    const root = pdfRoot(textLayer(1, ["trans-", "br", "port"]))
    const index = buildPdfIndex(root)
    // "transport" — 'p' of "port" is at normalized offset 5. It must map
    // into the "port" text node, offset 0.
    const step = index.steps.find((s) => s.node.textContent === "port")
    expect(step).toBeDefined()
    expect(step!.offset).toBe(0)
    expect(step!.count).toBe(4)
  })

  test("empty text layer → hasText false", () => {
    const root = pdfRoot(textLayer(1, []))
    const index = buildPdfIndex(root)
    expect(index.text).toBe("")
    expect(index.hasText).toBe(false)
  })

  test("whitespace-only text layer → hasText false", () => {
    const root = pdfRoot(textLayer(1, ["   ", "  "]))
    const index = buildPdfIndex(root)
    expect(index.hasText).toBe(false)
  })

  test("NFKC-normalizes span text", () => {
    // ﬁ (U+FB01 LATIN SMALL LIGATURE FI) → "fi"
    const root = pdfRoot(textLayer(1, ["ﬁsh"]))
    const index = buildPdfIndex(root)
    expect(index.text).toBe("fish")
  })

  test("spans within a page are concatenated without added spaces", () => {
    const root = pdfRoot(textLayer(1, ["hel", "lo"]))
    const index = buildPdfIndex(root)
    expect(index.text).toBe("hello")
  })
})

// ---------------------------------------------------------------------------
// findMatches
// ---------------------------------------------------------------------------

describe("findMatches", () => {
  test("finds a single match with DOM endpoints", () => {
    const root = pdfRoot(textLayer(1, ["hello world"]))
    const index = buildPdfIndex(root)
    const matches = findMatches(index, "world")
    expect(matches).toHaveLength(1)
    expect(matches[0].page).toBe(1)
    expect(matches[0].start).toBe(6)
    expect(matches[0].end).toBe(11)
    expect(matches[0].startNode.textContent).toBe("hello world")
    expect(matches[0].range.toString()).toBe("world")
  })

  test("an internal space keeps its own source (the whitespace char in the text node)", () => {
    // Each normalized char maps to its own DOM char, so a match starting
    // right after the space resolves to (node, offsetOfChar).
    const root = pdfRoot(textLayer(1, ["hello world"]))
    const index = buildPdfIndex(root)
    const matches = findMatches(index, "world")
    expect(matches).toHaveLength(1)
    expect(matches[0].startOffset).toBe(6)
    expect(matches[0].range.toString()).toBe("world")
  })

  test("case-insensitive by default", () => {
    const root = pdfRoot(textLayer(1, ["Hello HELLO hello"]))
    const index = buildPdfIndex(root)
    expect(findMatches(index, "hello")).toHaveLength(3)
  })

  test("caseSensitive: true respects case", () => {
    const root = pdfRoot(textLayer(1, ["Hello HELLO hello"]))
    const index = buildPdfIndex(root)
    expect(findMatches(index, "hello", { caseSensitive: true })).toHaveLength(1)
  })

  test("finds all occurrences, in document order", () => {
    const root = pdfRoot(textLayer(1, ["a b a b a"]))
    const index = buildPdfIndex(root)
    const matches = findMatches(index, "a")
    expect(matches).toHaveLength(3)
    expect(matches.map((m) => m.start)).toEqual([0, 4, 8])
  })

  test("a match spanning two spans gets a cross-node range", () => {
    const root = pdfRoot(textLayer(1, ["hel", "lo world"]))
    const index = buildPdfIndex(root)
    const matches = findMatches(index, "hello")
    expect(matches).toHaveLength(1)
    expect(matches[0].range.toString()).toBe("hello")
    expect(matches[0].startNode.textContent).toBe("hel")
    expect(matches[0].endNode.textContent).toBe("lo world")
  })

  test("a match spanning a <br> line break matches across the space", () => {
    const root = pdfRoot(textLayer(1, ["line one", "br", "line two"]))
    const index = buildPdfIndex(root)
    const matches = findMatches(index, "one line")
    expect(matches).toHaveLength(1)
    // The break-space maps to the char before the break ("e" of "one"), so
    // the range covers "one" + the line-two prefix the space mapped to.
    expect(matches[0].range.toString()).toBe("oneline")
    expect(matches[0].startNode.textContent).toBe("line one")
    expect(matches[0].endNode.textContent).toBe("line two")
  })

  test("hyphenated line break: 'transport' matches 'trans-\\nport'", () => {
    const root = pdfRoot(textLayer(1, ["trans-", "br", "port"]))
    const index = buildPdfIndex(root)
    const matches = findMatches(index, "transport")
    expect(matches).toHaveLength(1)
    // The normalized string drops the hyphen, but the DOM range spans the
    // real text — "trans-" + "port".
    expect(matches[0].range.toString()).toBe("trans-port")
    expect(matches[0].startNode.textContent).toBe("trans-")
    expect(matches[0].endNode.textContent).toBe("port")
  })

  test("matches on page 2 are tagged page 2", () => {
    const root = pdfRoot(textLayer(1, ["alpha"]), textLayer(2, ["beta alpha"]))
    const index = buildPdfIndex(root)
    const matches = findMatches(index, "alpha")
    expect(matches).toHaveLength(2)
    expect(matches[0].page).toBe(1)
    expect(matches[1].page).toBe(2)
  })

  test("empty query returns no matches", () => {
    const root = pdfRoot(textLayer(1, ["hello"]))
    const index = buildPdfIndex(root)
    expect(findMatches(index, "")).toHaveLength(0)
  })

  test("no match returns empty", () => {
    const root = pdfRoot(textLayer(1, ["hello world"]))
    const index = buildPdfIndex(root)
    expect(findMatches(index, "zebra")).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// isPdfFindTarget (the hijack guard + command `when` predicate)
// ---------------------------------------------------------------------------

describe("isPdfFindTarget", () => {
  function previewPane(path: string, inner: HTMLElement): HTMLElement {
    const host = document.createElement("div")
    host.setAttribute("data-preview-host", path)
    const scroll = document.createElement("div")
    scroll.setAttribute("data-preview-scroll", "")
    host.appendChild(scroll)
    scroll.appendChild(inner)
    document.body.appendChild(host)
    return host
  }

  test("true for a target inside a PDF pane's scroll container", () => {
    const span = document.createElement("span")
    const host = previewPane("docs/paper.pdf", span)
    expect(isPdfFindTarget(span)).toBe(true)
    host.remove()
  })

  test("true for the scroll container itself (focused pane)", () => {
    const span = document.createElement("span")
    const host = previewPane("paper.pdf", span)
    const scroll = host.querySelector("[data-preview-scroll]")!
    expect(isPdfFindTarget(scroll)).toBe(true)
    host.remove()
  })

  test("false for a non-PDF preview pane", () => {
    const span = document.createElement("span")
    const host = previewPane("notes.md", span)
    expect(isPdfFindTarget(span)).toBe(false)
    host.remove()
  })

  test("false for a target outside any preview pane", () => {
    const div = document.createElement("div")
    document.body.appendChild(div)
    expect(isPdfFindTarget(div)).toBe(false)
    div.remove()
  })

  test("false for an input inside a PDF pane (editable owns its keys)", () => {
    const input = document.createElement("input")
    const host = previewPane("paper.pdf", input)
    expect(isPdfFindTarget(input)).toBe(false)
    host.remove()
  })

  test("false for a contenteditable inside a PDF pane", () => {
    const editable = document.createElement("div")
    editable.contentEditable = "true"
    const host = previewPane("paper.pdf", editable)
    expect(isPdfFindTarget(editable)).toBe(false)
    host.remove()
  })

  test("false for a CodeMirror editor target even inside a PDF pane", () => {
    const cm = document.createElement("div")
    cm.classList.add("cm-editor")
    const inner = document.createElement("div")
    cm.appendChild(inner)
    const host = previewPane("paper.pdf", cm)
    expect(isPdfFindTarget(inner)).toBe(false)
    host.remove()
  })

  test("case-insensitive .PDF extension", () => {
    const span = document.createElement("span")
    const host = previewPane("DOC.PDF", span)
    expect(isPdfFindTarget(span)).toBe(true)
    host.remove()
  })
})
