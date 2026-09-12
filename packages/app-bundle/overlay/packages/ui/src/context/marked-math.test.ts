import { expect, test } from "bun:test"
import { Marked } from "marked"
import { markedCodeSpanBoundary } from "./marked-code-span"
import { katexExtension, renderMathInText } from "./marked"

const parse = (src: string) => new Marked(markedCodeSpanBoundary, katexExtension).parse(src)

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

  expect(renderMathInText("$$\n\\hat H\n$$")).toContain("katex-display")
  expect(renderMathInText("inline \\(\\Omega_x\\) math")).toContain('class="katex"')
})
