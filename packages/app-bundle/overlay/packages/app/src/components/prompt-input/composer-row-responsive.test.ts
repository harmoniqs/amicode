import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

// amicode#2189 — the composer control row at narrow widths. The row must stay
// legible and keep Send reachable: chips truncate instead of overlapping, and
// below named container breakpoints they shed in an explicit priority order
// (variant -> harness -> model label -> concise). Layout lives in CSS
// container queries on the `amicode-composer` container, so these tests assert
// the rules and the class wiring from source (the repo's pattern for CSS
// behavior; see travelling-dot.test.ts).

const indexCss = readFileSync(resolve(__dirname, "../../index.css"), "utf8")
const composerSource = readFileSync(resolve(__dirname, "../prompt-input-v2.tsx"), "utf8")
const harnessSource = readFileSync(resolve(__dirname, "harness-control.tsx"), "utf8")
const rowSource = readFileSync(
  resolve(__dirname, "../../../../session-ui/src/v2/components/prompt-input/index.tsx"),
  "utf8",
)

describe("composer row slot wiring", () => {
  test("the control group is tagged so the CSS can target it", () => {
    expect(rowSource).toMatch(/class="amicode-composer-controls [^"]*min-w-0 flex-1/)
  })

  test("agent and variant selects carry their slot classes", () => {
    expect(rowSource).toMatch(/title="Choose agent"[\s\S]{0,200}class="amicode-composer-agent"/)
    expect(rowSource).toMatch(/title="Choose model variant"[\s\S]{0,200}class="amicode-composer-variant"/)
  })

  test("the model control and its label carry their slot classes", () => {
    expect(composerSource.match(/amicode-composer-model /g)?.length).toBe(2)
    expect(composerSource).toContain('class="amicode-composer-model-label truncate')
  })

  test("the harness trigger carries its slot class and can shrink", () => {
    expect(harnessSource).toContain('class="amicode-composer-harness min-w-0 ')
  })
})

// Pull the body of the first CSS rule whose selector list contains `selector`.
function ruleBody(css: string, selector: string): string {
  const at = css.indexOf(selector)
  if (at < 0) return ""
  const open = css.indexOf("{", at)
  return css.slice(open + 1, css.indexOf("}", open))
}

describe("chips truncate; Send is never overlapped", () => {
  test("the control group clips horizontally and keeps focus rings inside the clip", () => {
    const body = ruleBody(indexCss, ".amicode-composer-controls {")
    expect(body).toMatch(/overflow-x:\s*clip/)
    expect(body).toMatch(/padding-inline:\s*4px/)
    expect(body).toMatch(/margin-inline:\s*-4px/)
  })

  test("every slot chip can shrink below its label width so the label ellipsizes", () => {
    for (const slot of ["agent", "model", "variant", "harness"]) {
      expect(indexCss).toContain(`.amicode-composer-controls .amicode-composer-${slot}`)
    }
    const body = ruleBody(indexCss, ".amicode-composer-controls .amicode-composer-agent")
    expect(body).toMatch(/min-width:\s*0/)
  })

  test("the trailing controls never shrink", () => {
    expect(rowSource).toContain('<div class="mr-1 flex shrink-0 items-center">{control}</div>')
  })
})

// Every `@container amicode-composer (max-width: Nrem) { ... }` block, as
// [N, body]. Bodies here are flat rule lists, so brace depth 2 ends a block.
function containerBlocks(css: string): Array<[number, string]> {
  const out: Array<[number, string]> = []
  const re = /@container amicode-composer \(max-width:\s*([\d.]+)rem\)\s*\{/g
  for (let m = re.exec(css); m; m = re.exec(css)) {
    let depth = 1
    let i = re.lastIndex
    for (; i < css.length && depth > 0; i++) {
      if (css[i] === "{") depth++
      else if (css[i] === "}") depth--
    }
    out.push([Number(m[1]), css.slice(re.lastIndex, i - 1)])
  }
  return out
}

// The breakpoint (rem) at which `selector` is shed, or undefined.
function shedAt(selector: string): number | undefined {
  const hits = containerBlocks(indexCss).filter(([, body]) => body.includes(selector))
  return hits.length === 1 ? hits[0][0] : undefined
}

describe("explicit shed order: variant -> harness -> model label -> concise", () => {
  const variant = shedAt(".amicode-composer-variant")
  const harness = shedAt(".amicode-composer-harness")
  const modelLabel = shedAt(".amicode-composer-model-label")
  const concise = shedAt(".amicode-concise-toggle-wrap")

  test("each sheddable control has exactly one breakpoint", () => {
    expect([variant, harness, modelLabel, concise].every((n) => typeof n === "number")).toBe(true)
  })

  test("the breakpoints shed in priority order, widest first", () => {
    expect(variant!).toBeGreaterThan(harness!)
    expect(harness!).toBeGreaterThan(modelLabel!)
    expect(modelLabel!).toBeGreaterThan(concise!)
  })

  test("the concise toggle keeps its #1633 breakpoint (26rem), now last in the order", () => {
    expect(concise).toBe(26)
  })

  test("variant and harness are removed outright", () => {
    const blocks = containerBlocks(indexCss)
    const body = (n: number | undefined) => blocks.find(([rem]) => rem === n)![1]
    expect(ruleBody(body(variant), ".amicode-composer-variant")).toMatch(/display:\s*none/)
    expect(ruleBody(body(harness), ".amicode-composer-harness")).toMatch(/display:\s*none/)
  })

  test("the harness is never shed under a degraded harness (it is the way back)", () => {
    const blocks = containerBlocks(indexCss)
    const body = blocks.find(([rem]) => rem === harness)![1]
    expect(body).toContain(".amicode-composer-controls:not([data-harness-degraded]) .amicode-composer-harness")
  })

  test("the model chip goes icon-only: its label is visually hidden but keeps the accessible name", () => {
    const blocks = containerBlocks(indexCss)
    const label = ruleBody(blocks.find(([rem]) => rem === modelLabel)![1], ".amicode-composer-model-label")
    expect(label).not.toMatch(/display:\s*none/)
    expect(label).toMatch(/position:\s*absolute/)
    expect(label).toMatch(/clip-path:\s*inset\(50%\)/)
    expect(label).toMatch(/width:\s*1px/)
  })
})
