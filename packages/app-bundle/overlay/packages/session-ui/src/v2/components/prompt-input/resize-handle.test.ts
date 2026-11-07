import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { COMPOSER_HEIGHT_KEY, COMPOSER_KEY_STEP } from "./resize"
import {
  COMPOSER_RESIZE_LABEL,
  COMPOSER_RESIZE_TITLE,
  ComposerResizeHandle,
  composerHeightStyle,
  createComposerResize,
  type ComposerResize,
} from "./resize-handle"

// amicode#612 — the REAL ComposerResizeHandle, driven with real pointer events.
//
// Bun's test transpiler does not apply Solid's DOM transform (see
// app/src/components/model-picker-row.test.tsx), so JSX compiles to
// React.createElement. This static adapter builds the handle's DOM straight
// from the component's own markup and wires every `onXxx` prop (which is where
// the component's `composerResizeHandlers` land) as a DOM listener, so
// dispatching pointerdown/pointermove/pointerup exercises the exact handlers
// the component wires. Attributes are evaluated once (static), so reactive
// outputs are asserted on the `ComposerResize` accessors instead.
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
    if (name === "children" || name === "classList" || value === undefined || value === null || value === false) continue
    if (typeof value === "function" && /^on[A-Z]/.test(name)) {
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
beforeEach(() => localStorage.clear())

const RENDERED = 100
const pointer = (type: string, init: PointerEventInit) =>
  new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, ...init })

function mount(extra: { label?: string; title?: string } = {}) {
  let resize!: ComposerResize
  let dispose!: () => void
  const handle = createRoot((d) => {
    dispose = d
    resize = createComposerResize(() => RENDERED)
    return ComposerResizeHandle({ resize, ...extra }) as unknown as HTMLElement
  })
  document.body.append(handle)
  return {
    handle,
    resize,
    dispose: () => {
      handle.remove()
      dispose()
    },
  }
}

describe("ComposerResizeHandle — real pointer interaction (#612)", () => {
  test("pointerdown → pointermove → pointerup changes the height style and persists on release", () => {
    const { handle, resize, dispose } = mount()
    expect(composerHeightStyle(resize.height())).toBeUndefined()

    handle.dispatchEvent(pointer("pointerdown", { clientY: 500 }))
    handle.dispatchEvent(pointer("pointermove", { clientY: 450 }))
    // Dragging the top edge UP by 50px grows the 100px text area to 150px.
    expect(composerHeightStyle(resize.height())).toEqual({ "min-height": "150px", "max-height": "150px" })
    // Mid-drag nothing is written to storage yet.
    expect(localStorage.getItem(COMPOSER_HEIGHT_KEY)).toBeNull()

    handle.dispatchEvent(pointer("pointerup", { clientY: 450 }))
    expect(localStorage.getItem(COMPOSER_HEIGHT_KEY)).toBe("150")

    // After release further moves are ignored.
    handle.dispatchEvent(pointer("pointermove", { clientY: 300 }))
    expect(composerHeightStyle(resize.height())).toEqual({ "min-height": "150px", "max-height": "150px" })
    dispose()
  })

  test("dragging down shrinks, and the height never goes below the minimum", () => {
    const { handle, resize, dispose } = mount()
    handle.dispatchEvent(pointer("pointerdown", { clientY: 500 }))
    handle.dispatchEvent(pointer("pointermove", { clientY: 900 }))
    expect(resize.height()).toBe(60)
    handle.dispatchEvent(pointer("pointerup", {}))
    dispose()
  })

  test("a non-primary button does not start a drag", () => {
    const { handle, resize, dispose } = mount()
    handle.dispatchEvent(pointer("pointerdown", { clientY: 500, button: 2 }))
    handle.dispatchEvent(pointer("pointermove", { clientY: 400 }))
    expect(resize.height()).toBeUndefined()
    dispose()
  })

  test("pointercancel ends the drag like pointerup", () => {
    const { handle, resize, dispose } = mount()
    handle.dispatchEvent(pointer("pointerdown", { clientY: 500 }))
    handle.dispatchEvent(pointer("pointermove", { clientY: 480 }))
    handle.dispatchEvent(pointer("pointercancel", {}))
    expect(resize.resizer.dragging()).toBe(false)
    expect(localStorage.getItem(COMPOSER_HEIGHT_KEY)).toBe("120")
    dispose()
  })

  test("ArrowUp grows by one step, double-click resets to the stock height", () => {
    const { handle, resize, dispose } = mount()
    const key = new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true })
    handle.dispatchEvent(key)
    expect(key.defaultPrevented).toBe(true)
    expect(resize.height()).toBe(RENDERED + COMPOSER_KEY_STEP)

    const other = new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true })
    handle.dispatchEvent(other)
    expect(other.defaultPrevented).toBe(false)

    handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))
    expect(resize.height()).toBeUndefined()
    expect(localStorage.getItem(COMPOSER_HEIGHT_KEY)).toBeNull()
    dispose()
  })

  test("maxHeight (aria-valuemax) follows the window size", () => {
    const { resize, dispose } = mount()
    const original = window.innerHeight
    try {
      window.innerHeight = 1000
      window.dispatchEvent(new Event("resize"))
      expect(resize.maxHeight()).toBe(600)
      window.innerHeight = 500
      window.dispatchEvent(new Event("resize"))
      expect(resize.maxHeight()).toBe(300)
    } finally {
      window.innerHeight = original
      dispose()
    }
  })
})

describe("ComposerResizeHandle — markup contract (#612)", () => {
  test("is a keyboard-focusable horizontal separator with the default copy", () => {
    const { handle, dispose } = mount()
    expect(handle.getAttribute("role")).toBe("separator")
    expect(handle.getAttribute("aria-orientation")).toBe("horizontal")
    expect(handle.getAttribute("tabindex")).toBe("0")
    expect(handle.getAttribute("aria-label")).toBe(COMPOSER_RESIZE_LABEL)
    expect(handle.getAttribute("title")).toBe(COMPOSER_RESIZE_TITLE)
    dispose()
  })

  test("label and title overrides (the i18n path) replace the defaults", () => {
    const { handle, dispose } = mount({ label: "Redimensionner", title: "Glisser" })
    expect(handle.getAttribute("aria-label")).toBe("Redimensionner")
    expect(handle.getAttribute("title")).toBe("Glisser")
    dispose()
  })

  test("keyboard focus shows a design-system focus ring, never removed", () => {
    const { handle, dispose } = mount()
    const classes = (handle.getAttribute("class") ?? "").split(/\s+/)
    expect(classes).toContain("focus-visible:outline-v2-border-border-focus")
    expect(classes).toContain("focus-visible:outline-2")
    expect(classes).not.toContain("outline-none")
    dispose()
  })
})
