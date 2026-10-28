import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { ModelPickerRow } from "./model-picker-row"

// amicode#1999 (#1979 S9): the picker row truncated the model name after
// "Claud" — name, provider, meta, tags, badge and star shared one flex line.
// The row is now two lines: the name owns line 1 (wrapping, never single-line
// truncate, full name in title) beside the trailing tags/star; provider · meta
// sit on a separate faint line 2.
//
// Bun's test transpiler does not apply Solid's DOM transform (see
// test-browser/empty-workspace-landing.test.ts), so JSX compiles to
// React.createElement. This static adapter renders the row's DOM directly —
// the row is deliberately plain markup (no Show/classList) so it renders here
// exactly as Solid renders it.
type Child = Node | string | number | boolean | null | undefined | Child[]
type Props = Record<string, unknown>

function appendChildren(parent: Element, children: Child[]) {
  for (const child of children.flat(Infinity) as Exclude<Child, Child[]>[]) {
    if (child === null || child === undefined || child === false || child === true) continue
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
}

function createElement(type: string | ((props: Props) => Child), props: Props | null, ...children: Child[]): Child {
  if (typeof type === "function") {
    return type({ ...props, children: children.length === 1 ? children[0] : children })
  }
  const element = document.createElement(type)
  for (const [name, value] of Object.entries(props ?? {})) {
    if (name === "children" || value === undefined || value === null || value === false) continue
    element.setAttribute(name, value === true ? "" : String(value))
  }
  appendChildren(element, children)
  return element
}

const host = globalThis as typeof globalThis & { React?: unknown }
let previous: unknown
beforeAll(() => {
  previous = host.React
  host.React = { createElement }
})
afterAll(() => {
  if (previous === undefined) Reflect.deleteProperty(host, "React")
  else host.React = previous
})

const NAME = "Claude Sonnet 5.5 (US cross-region)"

const renderRow = (props: Partial<Parameters<typeof ModelPickerRow>[0]> = {}) => {
  const node = (
    <ModelPickerRow
      name={NAME}
      provider="Amazon Bedrock"
      meta="$3/$15 per Mtok · 200k ctx"
      trailing={<span data-testid="tag">Latest</span>}
      {...props}
    />
  ) as unknown as HTMLElement
  const root = document.createElement("div")
  root.append(node)
  return root
}

const classes = (el: Element | null) => (el?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean)

describe("ModelPickerRow — two-line row (#1999)", () => {
  test("the name element carries the full name as its title", () => {
    const name = renderRow().querySelector('[data-slot="model-row-name"]')
    expect(name).not.toBeNull()
    expect(name?.getAttribute("title")).toBe(NAME)
    expect(name?.textContent).toBe(NAME)
  })

  test("the name never single-line truncates: no truncate class, wraps up to two lines", () => {
    const name = renderRow().querySelector('[data-slot="model-row-name"]')
    expect(classes(name)).not.toContain("truncate")
    expect(classes(name)).not.toContain("whitespace-nowrap")
    expect(classes(name)).toContain("line-clamp-2")
    expect(classes(name)).toContain("break-words")
    expect(classes(name)).toContain("flex-1")
    expect(classes(name)).toContain("min-w-0")
  })

  test("provider and meta live in a separate second-line element, not the name line", () => {
    const root = renderRow()
    const line1 = root.querySelector('[data-slot="model-row-line1"]')
    const line2 = root.querySelector('[data-slot="model-row-line2"]')
    expect(line1).not.toBeNull()
    expect(line2).not.toBeNull()
    expect(line1?.contains(line2)).toBe(false)
    expect(line2?.contains(root.querySelector('[data-slot="model-row-name"]'))).toBe(false)

    const provider = root.querySelector('[data-slot="model-row-provider"]')
    const meta = root.querySelector('[data-slot="model-row-meta"]')
    expect(line2?.contains(provider)).toBe(true)
    expect(line2?.contains(meta)).toBe(true)
    expect(line1?.contains(provider)).toBe(false)
    expect(line1?.contains(meta)).toBe(false)
    expect(provider?.textContent).toBe("Amazon Bedrock")
    expect(meta?.textContent).toContain("$3/$15 per Mtok · 200k ctx")
    // line 2 is the line that truncates — single-line, faint 12px.
    expect(classes(line2)).toContain("truncate")
    expect(line2?.textContent).toBe("Amazon Bedrock · $3/$15 per Mtok · 200k ctx")
  })

  test("trailing tags/badge/star sit on line 1 beside the name and never shrink", () => {
    const root = renderRow()
    const trailing = root.querySelector('[data-slot="model-row-trailing"]')
    expect(root.querySelector('[data-slot="model-row-line1"]')?.contains(trailing)).toBe(true)
    expect(classes(trailing)).toContain("shrink-0")
    expect(trailing?.querySelector('[data-testid="tag"]')).not.toBeNull()
  })

  test("no meta → line 2 is just the provider; a greyed reason joins line 2", () => {
    const bare = renderRow({ meta: undefined })
    expect(bare.querySelector('[data-slot="model-row-meta"]')).toBeNull()
    expect(bare.querySelector('[data-slot="model-row-line2"]')?.textContent).toBe("Amazon Bedrock")

    const greyed = renderRow({ meta: undefined, reason: "Unreachable", greyed: true })
    const line2 = greyed.querySelector('[data-slot="model-row-line2"]')
    expect(line2?.textContent).toBe("Amazon Bedrock · Unreachable")
    expect(classes(greyed.querySelector('[data-slot="model-row"]'))).toContain("opacity-50")
  })
})
