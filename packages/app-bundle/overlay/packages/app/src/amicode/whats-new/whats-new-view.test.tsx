import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { buildCardViews, initialExpanded, notesLink, whatsNewKeyHandler, type WhatsNewPayload } from "./whats-new-model"
import { WhatsNewCardView, WhatsNewFrame, WhatsNewWelcome, focusContinue } from "./whats-new-view"

// amicode#2020: the What's-new page is a fixed frame — pinned header, ONE
// scrolling region holding the cards, pinned footer with Continue — so the
// Continue button can never hide at the bottom of a long scroll.
//
// Bun's test transpiler does not apply Solid's DOM transform (see
// components/model-picker-row.test.tsx and test-browser/empty-workspace-landing.test.ts),
// so JSX compiles to React.createElement. This static adapter renders the
// view's DOM directly — the view is deliberately plain markup (no Show/For/
// classList) so it renders here exactly as Solid renders it.
type Child = Node | string | number | boolean | null | undefined | Child[]
type Props = Record<string, unknown>

function appendChildren(parent: Element, children: Child[]) {
  for (const child of children) {
    if (Array.isArray(child)) {
      appendChildren(parent, child)
      continue
    }
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
    if (name === "class") {
      element.className = String(value)
      continue
    }
    if (name.startsWith("on") && typeof value === "function") {
      element.addEventListener(name.slice(2).toLowerCase(), value as EventListener)
      continue
    }
    element.setAttribute(name, value === true ? "" : String(value))
  }
  appendChildren(element, children)
  return element
}

const host = globalThis as unknown as Record<string, unknown>
let previous: unknown
beforeAll(() => {
  previous = host.React
  host.React = { createElement }
})
afterAll(() => {
  if (previous === undefined) Reflect.deleteProperty(host, "React")
  else host.React = previous
})

const LONG = "word ".repeat(60).trim()
const payload = (over: Partial<WhatsNewPayload> = {}): WhatsNewPayload => ({
  current: "0.4.0",
  since: "0.3.10",
  show: true,
  welcome: false,
  cards: ["0.4.0", "0.3.11", "0.3.10"].map((version) => ({
    version,
    date: "2026-10-29",
    highlights: [
      { title: `${version} first`, body: "short body" },
      { title: `${version} second`, body: LONG },
    ],
    notes: version === "0.4.0" ? "https://notes/0.4.0" : null,
    body: "",
  })),
  newForYou: [],
  ...over,
})

type Handlers = { dismissed: number; toggled: string[]; more: string[]; opened: string[] }

function render(p: WhatsNewPayload, expanded = initialExpanded(p.cards), more: string[] = []) {
  const h: Handlers = { dismissed: 0, toggled: [], more: [], opened: [] }
  const views = buildCardViews(p, expanded, more)
  const root = document.createElement("div")
  root.append(
    (
      <WhatsNewFrame
        title="What's new in Amicode"
        version={p.current}
        summary="What changed since 0.3.10"
        notesHref={notesLink(p)}
        onContinue={() => h.dismissed++}
        onOpenNotes={(href: string) => h.opened.push(href)}
      >
        {p.welcome ? <WhatsNewWelcome /> : null}
        {views.map((card) => (
          <WhatsNewCardView
            card={card}
            onToggleCard={(v: string) => h.toggled.push(v)}
            onToggleMore={(k: string) => h.more.push(k)}
          />
        ))}
      </WhatsNewFrame>
    ) as unknown as HTMLElement,
  )
  return { root, h }
}

const q = (root: ParentNode, sel: string) => root.querySelector(sel) as HTMLElement | null
const qa = (root: ParentNode, sel: string) => [...root.querySelectorAll(sel)] as HTMLElement[]

describe("the frame: pinned header + scrolling cards + pinned footer", () => {
  test("the footer with Continue is OUTSIDE the scrolling container", () => {
    const { root } = render(payload())
    const scroll = q(root, '[data-slot="whats-new-scroll"]')!
    const footer = q(root, '[data-slot="whats-new-footer"]')!
    const header = q(root, '[data-slot="whats-new-header"]')!
    const cont = q(root, '[data-action="whats-new-continue"]')!
    expect(scroll && footer && header && cont).toBeTruthy()
    expect(scroll.contains(footer)).toBe(false)
    expect(scroll.contains(header)).toBe(false)
    expect(scroll.contains(cont)).toBe(false)
    expect(footer.contains(cont)).toBe(true)
    expect(footer.parentElement).toBe(scroll.parentElement)
    expect(header.parentElement).toBe(scroll.parentElement)
    // order in the column: header, scroll, footer
    const kids = [...scroll.parentElement!.children]
    expect(kids.indexOf(header)).toBeLessThan(kids.indexOf(scroll))
    expect(kids.indexOf(scroll)).toBeLessThan(kids.indexOf(footer))
    // the scroll region is the only overflow-y owner; the frame itself never scrolls
    expect(scroll.className).toContain("overflow-y-auto")
    expect(q(root, '[data-component="amicode-whats-new"]')!.className).not.toContain("overflow-y-auto")
    // every card lives in the scroll region
    expect(qa(root, '[data-slot="whats-new-card"]').every((c) => scroll.contains(c))).toBe(true)
  })

  test("header carries the title, version and the one-line summary; footer carries the release-notes link", () => {
    const { root, h } = render(payload())
    const header = q(root, '[data-slot="whats-new-header"]')!
    expect(header.textContent).toContain("What's new in Amicode")
    expect(header.textContent).toContain("0.4.0")
    expect(q(header, '[data-slot="whats-new-summary"]')!.textContent).toBe("What changed since 0.3.10")
    const link = q(root, '[data-slot="whats-new-footer"] a')!
    expect(link.textContent).toBe("Release notes")
    expect(link.getAttribute("href")).toBe("https://notes/0.4.0")
    link.click()
    expect(h.opened).toEqual(["https://notes/0.4.0"])
    expect(h.dismissed).toBe(0)
  })

  test("no release-notes link when no card has one; Continue is a button and fires onContinue", () => {
    const p = payload()
    p.cards.forEach((c) => (c.notes = null))
    const { root, h } = render(p)
    expect(q(root, '[data-slot="whats-new-footer"] a')).toBeNull()
    const cont = q(root, '[data-action="whats-new-continue"]')!
    expect(cont.tagName).toBe("BUTTON")
    expect(cont.textContent).toBe("Continue")
    cont.click()
    expect(h.dismissed).toBe(1)
  })

  test("Continue takes the accent fill with near-black ink (no gold, no raw hex)", () => {
    const { root } = render(payload())
    const cls = q(root, '[data-action="whats-new-continue"]')!.className
    expect(cls).toContain("bg-[var(--accent)]")
    expect(cls).toContain("text-[var(--accent-ink)]")
    expect(root.innerHTML).not.toMatch(/#[0-9a-fA-F]{3,6}\b/)
  })
})

describe("cards: only the newest is expanded", () => {
  test("3 cards → first expanded, others collapsed to a title row with a chevron", () => {
    const { root } = render(payload())
    const cards = qa(root, '[data-slot="whats-new-card"]')
    expect(cards.map((c) => c.getAttribute("data-expanded"))).toEqual(["true", "false", "false"])
    expect(qa(cards[0], '[data-slot="whats-new-highlight"]').length).toBe(2)
    for (const c of cards.slice(1)) expect(qa(c, '[data-slot="whats-new-highlight"]').length).toBe(0)
    const toggles = qa(root, '[data-slot="whats-new-card-toggle"]')
    expect(toggles.length).toBe(3)
    expect(toggles.map((t) => t.getAttribute("aria-expanded"))).toEqual(["true", "false", "false"])
    for (const t of toggles) {
      expect(t.tagName).toBe("BUTTON")
      expect(q(t, "svg")).not.toBeNull()
    }
  })

  test("clicking a collapsed card's toggle requests its version; expanded state then shows its highlights", () => {
    const { root, h } = render(payload())
    qa(root, '[data-slot="whats-new-card-toggle"]')[1].click()
    expect(h.toggled).toEqual(["0.3.11"])
    const after = render(payload(), ["0.4.0", "0.3.11"])
    const cards = qa(after.root, '[data-slot="whats-new-card"]')
    expect(cards.map((c) => c.getAttribute("data-expanded"))).toEqual(["true", "true", "false"])
    expect(qa(cards[1], '[data-slot="whats-new-highlight"]').length).toBe(2)
  })
})

describe("highlights: marker, readable body, clamp + Show more", () => {
  test("each highlight has a leading marker, a title and a body", () => {
    const { root } = render(payload())
    const h0 = qa(root, '[data-slot="whats-new-highlight"]')[0]
    const marker = q(h0, '[data-slot="whats-new-marker"]')!
    expect(marker.getAttribute("aria-hidden")).toBe("true")
    expect(h0.firstElementChild).toBe(marker)
    expect(q(h0, '[data-slot="whats-new-highlight-title"]')!.className).toContain("text-14-medium")
    const body = q(h0, '[data-slot="whats-new-highlight-body"]')!
    expect(body.className).toContain("text-13-regular")
    expect(body.className).toContain("leading-")
    expect(body.className).not.toContain("line-clamp-2")
  })

  test("a long body is line-clamped with Show more; toggled → full with Show less", () => {
    const { root, h } = render(payload())
    const second = qa(root, '[data-slot="whats-new-highlight"]')[1]
    expect(q(second, '[data-slot="whats-new-highlight-body"]')!.className).toContain("line-clamp-2")
    const btn = q(second, '[data-slot="whats-new-more"]')!
    expect(btn.textContent).toBe("Show more")
    btn.click()
    expect(h.more).toEqual(["0.4.0:1"])
    const open = render(payload(), ["0.4.0"], ["0.4.0:1"])
    const s2 = qa(open.root, '[data-slot="whats-new-highlight"]')[1]
    expect(q(s2, '[data-slot="whats-new-highlight-body"]')!.className).not.toContain("line-clamp-2")
    expect(q(s2, '[data-slot="whats-new-more"]')!.textContent).toBe("Show less")
  })

  test("a short body has no Show more control", () => {
    const { root } = render(payload())
    expect(q(qa(root, '[data-slot="whats-new-highlight"]')[0], '[data-slot="whats-new-more"]')).toBeNull()
  })
})

describe("New for you: a distinct block BEFORE the highlights of the newest card", () => {
  const arrivals = [{ provider: "anthropic", model: "claude-new", first_ok_at: 5 }]

  test("renders in the newest card, ahead of every highlight, with the accent-soft tint", () => {
    const { root } = render(payload({ newForYou: arrivals }))
    const cards = qa(root, '[data-slot="whats-new-card"]')
    const nfy = q(cards[0], '[data-slot="new-for-you"]')!
    expect(nfy).not.toBeNull()
    expect(nfy.textContent).toContain("New for you")
    expect(nfy.textContent).toContain("claude-new")
    expect(nfy.textContent).toContain("anthropic")
    const firstHighlight = q(cards[0], '[data-slot="whats-new-highlight"]')!
    expect(nfy.compareDocumentPosition(firstHighlight) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(nfy.className).toContain("bg-[var(--accent-fill-soft)]")
    expect(nfy.className).toContain("border-[var(--accent-edge)]")
    for (const c of cards.slice(1)) expect(q(c, '[data-slot="new-for-you"]')).toBeNull()
  })

  test("absent when there are no arrivals", () => {
    expect(q(render(payload()).root, '[data-slot="new-for-you"]')).toBeNull()
  })
})

describe("keyboard + focus", () => {
  test("focusContinue lands focus on Continue", () => {
    const { root } = render(payload())
    document.body.append(root)
    try {
      focusContinue(root)
      expect(document.activeElement).toBe(q(root, '[data-action="whats-new-continue"]'))
    } finally {
      root.remove()
    }
  })

  test("Enter and Esc dismiss through the real key handler; Enter inside an input does not", () => {
    const { root } = render(payload())
    document.body.append(root)
    let dismissed = 0
    const handler = whatsNewKeyHandler(() => dismissed++)
    const onKey = (e: KeyboardEvent) => handler(e)
    window.addEventListener("keydown", onKey, { capture: true })
    try {
      const cont = q(root, '[data-action="whats-new-continue"]')!
      cont.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
      expect(dismissed).toBe(1)
      cont.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
      expect(dismissed).toBe(2)
      const input = document.createElement("input")
      root.append(input)
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
      expect(dismissed).toBe(2)
    } finally {
      window.removeEventListener("keydown", onKey, { capture: true })
      root.remove()
    }
  })
})
