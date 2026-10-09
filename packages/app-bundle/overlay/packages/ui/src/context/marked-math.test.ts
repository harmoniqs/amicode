import { expect, test } from "bun:test"
import { createMarkdownParser, renderMathInText } from "./marked-parser"

// Parse through the real production pipeline (createMarkdownParser wires the
// katexExtension + markedShiki). A no-op highlighter keeps the test hermetic —
// code spans still round-trip as <code> via marked's built-in inline handling.
const parse = (src: string) => createMarkdownParser((code) => code).parse(src)

test("renders single-$ inline math", async () => {
  const html = await parse("in the rotating frame, where $\\Omega_x, \\Omega_y$ are the drives")
  expect(html).toContain('class="katex"')
  expect(html).not.toContain("$\\Omega_x")
})

test("renders tight and loose-inner single-$ math", async () => {
  expect(await parse("structure is settled (one spin, $N = 1$)")).toContain('class="katex"')
  expect(await parse("a qubit $x$ here")).toContain('class="katex"')
  expect(await parse("set $\\delta/2\\pi = 0.1$ MHz")).toContain('class="katex"')
})

test("renders digit-led single-$ inline math", async () => {
  // opencode#375 — the open-side digit guard rejected any math starting with
  // a digit, the standard physics reporting shape ($3.53\times10^{-5}$)
  expect(await parse("nice determinism check ($3.53\\times10^{-5}$ — free)")).toContain('class="katex"')
  expect(await parse("floor through the mock seam ($3.1\\times10^{-3}$, T1-dominated)")).toContain(
    'class="katex"',
  )
  expect(await parse("infidelity $10^{-5}$ at best")).toContain('class="katex"')
  expect(await parse("$0.99$-style fidelity")).toContain('class="katex"')
})

test("keeps tight digit-pair currency literal under the close-side guard", async () => {
  // Pandoc rule: the closing $ must not be followed by a digit — the first $
  // in "$30-and-$50" closes against "3", so the pair stays literal
  const html = await parse("prices: $30-and-$50 pairs")
  expect(html).not.toContain('class="katex"')
  expect(html).toContain("$30-and-$50")
})

test("keeps currency and env-var dollars literal", async () => {
  const prices = await parse("costs $5 and $10 total")
  expect(prices).not.toContain('class="katex"')
  expect(prices).toContain("$5")
  expect(prices).toContain("$10")

  const env = await parse("set $HOME before $PATH please")
  expect(env).not.toContain('class="katex"')
  expect(env).toContain("$HOME")
  expect(env).toContain("$PATH")
})

test("keeps escaped dollars literal", async () => {
  const html = await parse("use \\$HOME before $E=mc^2$")
  expect(html).toContain("$HOME")
  // the real formula after the prose dollar still renders
  expect(html).toContain('class="katex"')
  expect(html).not.toContain("$E=mc^2$")
})

test("never eats one half of $$..$$", async () => {
  // one-line $$..$$ mid-paragraph is not block math (blockKatex wants fenced
  // newlines); the single-$ tokenizer must leave it untouched
  const html = await parse("the drive $$\\Omega_x(t)$$ sits here")
  expect(html).not.toContain('class="katex"')
  expect(html).toContain("$$\\Omega_x(t)$$")
})

test("keeps math inside code spans literal", async () => {
  const html = await parse("run `$x$` verbatim")
  expect(html).toContain("<code>$x$</code>")
  expect(html).not.toContain('class="katex"')
})

test("display $$ and \\(...\\) keep working", async () => {
  expect(await parse("$$\n\\hat H/\\hbar\n$$")).toContain("katex-display")
  expect(await parse("inline \\(\\Omega_x\\) math")).toContain('class="katex"')
})

test("renderMathInText renders single-$ inline and spares prose dollars", () => {
  const math = renderMathInText("where $\\Omega_x$ are")
  expect(math).toContain('class="katex"')
  expect(math).not.toContain("$\\Omega_x")

  const prices = renderMathInText("costs $5 and $10 total")
  expect(prices).not.toContain('class="katex"')
  expect(prices).toContain("$5")
  expect(prices).toContain("$10")

  // opencode#375 — digit-led math through the global replace, tight pairs still literal
  expect(renderMathInText("check ($3.53\\times10^{-5}$ — free)")).toContain('class="katex"')
  expect(renderMathInText("prices: $30-and-$50 pairs")).not.toContain('class="katex"')

  expect(renderMathInText("$$\n\\hat H\n$$")).toContain("katex-display")
  expect(renderMathInText("inline \\(\\Omega_x\\) math")).toContain('class="katex"')
})
